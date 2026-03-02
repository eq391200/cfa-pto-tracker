/**
 * Accrual Engine — Core PTO calculation logic.
 *
 * Implements Puerto Rico Labor Law (Ley 180-1998, as amended):
 *   - 130-hour monthly threshold for hourly employees
 *   - 1 sick day per qualifying month (capped at 15-day running balance)
 *   - 4-tier vacation accrual based on tenure:
 *       0–1 yr:  0.50 days/mo (½ day)
 *       1–5 yr:  0.75 days/mo (¾ day)
 *       5–15 yr: 1.00 days/mo
 *       15+ yr:  1.25 days/mo (1¼ days)
 *   - Exempt employees accrue automatically every month regardless of hours
 */

const { getDb } = require('../db');

// ── PR Labor Law Constants ──────────────────────────────────────────
const HOURS_THRESHOLD = 130;          // Minimum hours for hourly employee accrual
const SICK_DAYS_PER_MONTH = 1;        // Flat sick accrual per qualifying month
const SICK_BALANCE_CAP = 15;          // Max carry-over sick days

/** Vacation accrual tiers (monthly rates by tenure bracket). */
const VACATION_TIERS = [
  { maxYears: 1,        rate: 0.50 },  // 0–1 year
  { maxYears: 5,        rate: 0.75 },  // 1–5 years
  { maxYears: 15,       rate: 1.00 },  // 5–15 years
  { maxYears: Infinity, rate: 1.25 }   // 15+ years
];

// ── Public API ──────────────────────────────────────────────────────

/**
 * Run the accrual engine for all active employees across all months with data.
 * Processes months chronologically per employee, tracking running sick balance
 * to enforce the 15-day cap.
 *
 * @returns {{ processed: number }}
 */
function runAccrualEngine() {
  const db = getDb();

  const employees = db.prepare("SELECT * FROM employees WHERE status = 'active'").all();
  const getMonthlyHours = db.prepare('SELECT * FROM monthly_hours WHERE employee_id = ? ORDER BY year, month');

  // Sick days taken grouped by year-month (for balance tracking)
  const getSickTaken = db.prepare(`
    SELECT
      CAST(strftime('%Y', date_taken) AS INTEGER) AS year,
      CAST(strftime('%m', date_taken) AS INTEGER) AS month,
      SUM(days_taken) AS total
    FROM time_off_taken
    WHERE employee_id = ? AND type = 'sick'
    GROUP BY year, month
  `);

  const upsertAccrual = db.prepare(`
    INSERT INTO accruals (employee_id, year, month, sick_days_earned, vacation_days_earned, hours_worked, accrual_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(employee_id, year, month) DO UPDATE SET
      sick_days_earned = excluded.sick_days_earned,
      vacation_days_earned = excluded.vacation_days_earned,
      hours_worked = excluded.hours_worked,
      accrual_type = excluded.accrual_type,
      created_at = CURRENT_TIMESTAMP
  `);

  let processed = 0;

  const processAll = db.transaction(() => {
    for (const emp of employees) {
      // Build a lookup of sick days taken per month
      const sickTakenMap = new Map();
      for (const sr of getSickTaken.all(emp.id)) {
        sickTakenMap.set(`${sr.year}-${sr.month}`, sr.total);
      }

      // Exempt employees get synthetic months for every month since hire
      let allMonths = getMonthlyHours.all(emp.id);
      if (emp.employee_type === 'exempt' && emp.first_clock_in) {
        allMonths = buildExemptMonthList(db, emp, allMonths);
      }

      // Process chronologically, tracking running sick balance
      let runningSickBalance = 0;

      for (const mh of allMonths) {
        const result = calculateAccrual(emp, mh);

        // Subtract sick days used this month
        const sickUsed = sickTakenMap.get(`${mh.year}-${mh.month}`) || 0;
        runningSickBalance = Math.max(0, runningSickBalance - sickUsed);

        // Cap sick accrual to stay within 15-day limit
        let sickToAccrue = result.sickDays;
        if (runningSickBalance >= SICK_BALANCE_CAP) {
          sickToAccrue = 0;
        } else if (runningSickBalance + sickToAccrue > SICK_BALANCE_CAP) {
          sickToAccrue = Math.round((SICK_BALANCE_CAP - runningSickBalance) * 100) / 100;
        }

        runningSickBalance += sickToAccrue;

        upsertAccrual.run(
          emp.id, mh.year, mh.month,
          sickToAccrue, result.vacationDays,
          mh.total_hours, result.accrualType
        );
        processed++;
      }
    }
  });

  processAll();
  return { processed };
}

/**
 * Calculate accrual for a single employee for a single month.
 *
 * @param {Object} employee - Employee record from DB
 * @param {Object} monthlyHours - { year, month, total_hours }
 * @returns {{ sickDays: number, vacationDays: number, accrualType: string }}
 */
function calculateAccrual(employee, monthlyHours) {
  const isExempt = employee.employee_type === 'exempt';
  const hours = monthlyHours.total_hours;
  const qualifies = isExempt || hours >= HOURS_THRESHOLD;

  if (!qualifies) {
    return { sickDays: 0, vacationDays: 0, accrualType: 'hourly_threshold' };
  }

  const tenureDays = calculateTenureDays(employee.first_clock_in, monthlyHours.year, monthlyHours.month);
  const vacationRate = getVacationRate(tenureDays);

  return {
    sickDays: SICK_DAYS_PER_MONTH,
    vacationDays: vacationRate,
    accrualType: isExempt ? 'exempt_auto' : 'hourly_threshold'
  };
}

/**
 * Look up the vacation accrual rate for a given tenure.
 *
 * @param {number} tenureDays - Days since hire
 * @returns {number} Monthly vacation accrual rate
 */
function getVacationRate(tenureDays) {
  const tenureYears = tenureDays / 365.25;
  for (const tier of VACATION_TIERS) {
    if (tenureYears < tier.maxYears) return tier.rate;
  }
  return VACATION_TIERS[VACATION_TIERS.length - 1].rate;
}

/**
 * Calculate days between first_clock_in and the start of a given month.
 *
 * @param {string|null} firstClockIn - ISO date string
 * @param {number} year
 * @param {number} month - 1-based
 * @returns {number}
 */
function calculateTenureDays(firstClockIn, year, month) {
  if (!firstClockIn) return 0;
  const start = new Date(firstClockIn);
  const monthStart = new Date(year, month - 1, 1);
  return Math.floor((monthStart.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * For exempt employees, build a complete month list from hire date to latest data.
 * Fills in synthetic entries (0 hours) for months without wage data.
 */
function buildExemptMonthList(db, employee, existingMonths) {
  if (!employee.first_clock_in) return existingMonths;

  const latest = db.prepare('SELECT MAX(year * 100 + month) AS ym FROM monthly_hours').get();
  if (!latest?.ym) return existingMonths;

  const latestYear = Math.floor(latest.ym / 100);
  const latestMonth = latest.ym % 100;

  const existingSet = new Set(existingMonths.map(mh => `${mh.year}-${mh.month}`));
  const allMonths = [...existingMonths];

  const startDate = new Date(employee.first_clock_in);
  let y = startDate.getFullYear();
  let m = startDate.getMonth() + 1;

  while (y < latestYear || (y === latestYear && m <= latestMonth)) {
    if (!existingSet.has(`${y}-${m}`)) {
      allMonths.push({ employee_id: employee.id, year: y, month: m, total_hours: 0 });
    }
    m++;
    if (m > 12) { m = 1; y++; }
  }

  allMonths.sort((a, b) => (a.year * 100 + a.month) - (b.year * 100 + b.month));
  return allMonths;
}

/**
 * Flag active hourly employees with 4+ consecutive months of no hours.
 * Exempt employees are never flagged.
 *
 * @returns {number} Count of newly flagged employees
 */
function checkInactiveEmployees() {
  const db = getDb();

  const latest = db.prepare('SELECT MAX(year * 100 + month) AS ym FROM monthly_hours').get();
  if (!latest?.ym) return 0;

  const latestYear = Math.floor(latest.ym / 100);
  const latestMonth = latest.ym % 100;

  // Exempt employees never get flagged
  db.prepare("UPDATE employees SET flagged_for_review = 0, consecutive_empty_months = 0 WHERE employee_type = 'exempt'").run();

  const activeHourly = db.prepare("SELECT id, full_name FROM employees WHERE status = 'active' AND employee_type = 'hourly'").all();
  const getHours = db.prepare('SELECT total_hours FROM monthly_hours WHERE employee_id = ? AND year = ? AND month = ?');

  let flaggedCount = 0;
  const CONSECUTIVE_THRESHOLD = 4;
  const MAX_LOOKBACK = 6;

  const updateFlags = db.transaction(() => {
    for (const emp of activeHourly) {
      let consecutive = 0;
      let y = latestYear;
      let m = latestMonth;

      for (let i = 0; i < MAX_LOOKBACK; i++) {
        const hours = getHours.get(emp.id, y, m);
        if (!hours || hours.total_hours === 0) {
          consecutive++;
        } else {
          break;
        }
        m--;
        if (m === 0) { m = 12; y--; }
      }

      const shouldFlag = consecutive >= CONSECUTIVE_THRESHOLD ? 1 : 0;
      db.prepare('UPDATE employees SET consecutive_empty_months = ?, flagged_for_review = ? WHERE id = ?')
        .run(consecutive, shouldFlag, emp.id);

      if (shouldFlag) flaggedCount++;
    }
  });

  updateFlags();
  return flaggedCount;
}

module.exports = {
  runAccrualEngine,
  calculateAccrual,
  calculateTenureDays,
  getVacationRate,
  checkInactiveEmployees,
  HOURS_THRESHOLD,
  SICK_BALANCE_CAP
};
