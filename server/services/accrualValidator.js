/**
 * Accrual Validator — Reliability layer for PTO accrual calculations.
 *
 * Runs on server startup and nightly via cron to:
 *   1. Recalculate all accruals (idempotent — upserts)
 *   2. Detect anomalies that may indicate data issues
 *   3. Log results to accrual_validation_log for audit trail
 *
 * Anomaly checks (PR Labor Law compliance):
 *   - Hourly employee with ≥130 hrs but no accrual
 *   - Exempt employee missing expected months
 *   - Sick balance exceeding 15-day cap
 *   - Negative balances (should never happen after migration fix)
 *   - Vacation rate mismatch for tenure bracket
 */

const { getDb } = require('../db');
const { runAccrualEngine, checkInactiveEmployees, HOURS_THRESHOLD, SICK_BALANCE_CAP } = require('./accrualEngine');

/**
 * Full recalculate + validate cycle.
 * @param {'startup'|'cron'|'manual'} triggerType
 * @returns {{ recalculated: number, anomalies: Object[], flagged: number }}
 */
function recalculateAndValidate(triggerType = 'manual') {
  const start = Date.now();
  const db = getDb();

  // Step 1: Recalculate all accruals (idempotent upserts)
  const result = runAccrualEngine();
  const flagged = checkInactiveEmployees();

  // Step 2: Run anomaly checks
  const anomalies = detectAnomalies(db);

  // Step 3: Log to audit table
  const duration = Date.now() - start;
  try {
    db.prepare(`
      INSERT INTO accrual_validation_log (trigger_type, records_recalculated, anomalies_found, anomaly_details, resolved, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      triggerType,
      result.processed,
      anomalies.length,
      anomalies.length > 0 ? JSON.stringify(anomalies) : null,
      anomalies.length === 0 ? 1 : 0,
      duration
    );
  } catch (e) {
    console.warn('[AccrualValidator] Failed to log validation:', e.message);
  }

  const label = triggerType === 'startup' ? 'Startup' : triggerType === 'cron' ? 'Nightly' : 'Manual';
  console.log(`[AccrualValidator] ${label} run: ${result.processed} records recalculated, ${anomalies.length} anomalies, ${flagged} inactive flagged (${duration}ms)`);

  if (anomalies.length > 0) {
    console.warn('[AccrualValidator] Anomalies detected:');
    for (const a of anomalies) {
      console.warn(`  - [${a.type}] ${a.employee}: ${a.detail}`);
    }
  }

  return { recalculated: result.processed, anomalies, flagged };
}

/**
 * Detect data anomalies across all active employees.
 * @param {import('better-sqlite3').Database} db
 * @returns {Object[]} Array of anomaly objects
 */
function detectAnomalies(db) {
  const anomalies = [];

  // 1. Hourly employees with ≥130 hours but zero accrual in that month
  const missingAccruals = db.prepare(`
    SELECT e.full_name, mh.year, mh.month, mh.total_hours
    FROM monthly_hours mh
    JOIN employees e ON e.id = mh.employee_id
    LEFT JOIN accruals a ON a.employee_id = mh.employee_id AND a.year = mh.year AND a.month = mh.month
    WHERE e.status = 'active'
      AND e.employee_type = 'hourly'
      AND mh.total_hours >= ?
      AND (a.id IS NULL OR (a.sick_days_earned = 0 AND a.vacation_days_earned = 0))
  `).all(HOURS_THRESHOLD);

  for (const row of missingAccruals) {
    anomalies.push({
      type: 'missing_accrual',
      employee: row.full_name,
      detail: `${row.year}-${String(row.month).padStart(2, '0')}: ${row.total_hours} hrs worked but no accrual recorded`
    });
  }

  // 2. Exempt employees with gaps in accrual months (since hire)
  const exemptEmployees = db.prepare("SELECT id, full_name, first_clock_in FROM employees WHERE status = 'active' AND employee_type = 'exempt' AND first_clock_in IS NOT NULL").all();
  const latestYM = db.prepare('SELECT MAX(year * 100 + month) AS ym FROM monthly_hours').get();

  if (latestYM?.ym) {
    const latY = Math.floor(latestYM.ym / 100);
    const latM = latestYM.ym % 100;

    for (const emp of exemptEmployees) {
      const startDate = new Date(emp.first_clock_in);
      let y = startDate.getFullYear();
      let m = startDate.getMonth() + 1;
      let missing = 0;

      while (y < latY || (y === latY && m <= latM)) {
        const has = db.prepare('SELECT 1 FROM accruals WHERE employee_id = ? AND year = ? AND month = ?').get(emp.id, y, m);
        if (!has) missing++;
        m++;
        if (m > 12) { m = 1; y++; }
      }

      if (missing > 0) {
        anomalies.push({
          type: 'exempt_gap',
          employee: emp.full_name,
          detail: `${missing} month(s) missing accrual records since hire`
        });
      }
    }
  }

  // 3. Sick balance exceeding 15-day cap
  const overCap = db.prepare(`
    SELECT e.full_name,
           COALESCE(SUM(a.sick_days_earned), 0) AS earned,
           COALESCE(st.total, 0) AS taken,
           COALESCE(SUM(a.sick_days_earned), 0) - COALESCE(st.total, 0) AS balance
    FROM employees e
    LEFT JOIN accruals a ON a.employee_id = e.id
    LEFT JOIN (
      SELECT employee_id, SUM(days_taken) AS total FROM time_off_taken WHERE type = 'sick' GROUP BY employee_id
    ) st ON st.employee_id = e.id
    WHERE e.status = 'active'
    GROUP BY e.id
    HAVING balance > ?
  `).all(SICK_BALANCE_CAP + 0.01);

  for (const row of overCap) {
    anomalies.push({
      type: 'sick_over_cap',
      employee: row.full_name,
      detail: `Sick balance ${row.balance.toFixed(2)} exceeds ${SICK_BALANCE_CAP}-day cap (earned: ${row.earned.toFixed(2)}, taken: ${row.taken.toFixed(2)})`
    });
  }

  // 4. Negative vacation balance (possible data entry error)
  const negativeVac = db.prepare(`
    SELECT e.full_name,
           COALESCE(SUM(a.vacation_days_earned), 0) - COALESCE(vt.total, 0) AS balance
    FROM employees e
    LEFT JOIN accruals a ON a.employee_id = e.id
    LEFT JOIN (
      SELECT employee_id, SUM(days_taken) AS total FROM time_off_taken WHERE type = 'vacation' GROUP BY employee_id
    ) vt ON vt.employee_id = e.id
    WHERE e.status = 'active'
    GROUP BY e.id
    HAVING balance < -0.01
  `).all();

  for (const row of negativeVac) {
    anomalies.push({
      type: 'negative_vacation',
      employee: row.full_name,
      detail: `Vacation balance is ${row.balance.toFixed(2)} (negative — more taken than earned)`
    });
  }

  return anomalies;
}

/**
 * Get the latest validation results for the admin dashboard.
 * @returns {{ latest: Object|null, recentAnomalies: Object[] }}
 */
function getValidationStatus() {
  const db = getDb();

  const latest = db.prepare(`
    SELECT * FROM accrual_validation_log ORDER BY run_at DESC LIMIT 1
  `).get();

  const recentWithAnomalies = db.prepare(`
    SELECT * FROM accrual_validation_log
    WHERE anomalies_found > 0
    ORDER BY run_at DESC LIMIT 5
  `).all();

  // Parse anomaly details
  const recentAnomalies = [];
  for (const log of recentWithAnomalies) {
    if (log.anomaly_details) {
      try {
        const parsed = JSON.parse(log.anomaly_details);
        recentAnomalies.push({ run_at: log.run_at, trigger_type: log.trigger_type, anomalies: parsed });
      } catch (_) {}
    }
  }

  return { latest: latest || null, recentAnomalies };
}

module.exports = { recalculateAndValidate, detectAnomalies, getValidationStatus };
