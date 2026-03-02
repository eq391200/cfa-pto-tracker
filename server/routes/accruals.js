/**
 * Accrual routes — PTO balance summaries, employee detail, time-off recording.
 *
 * Balance calculation follows Puerto Rico Labor Law (Ley 180-1998):
 * - Sick leave caps at 15 days
 * - Vacation accrual is tiered by tenure (0.50 → 0.75 → 1.00 → 1.25 days/mo)
 */

const express = require('express');
const { getDb } = require('../db');
const { runAccrualEngine, checkInactiveEmployees, SICK_BALANCE_CAP } = require('../services/accrualEngine');

const router = express.Router();

// ── GET /api/accruals/summary — All employees with balances ─────────
router.get('/summary', (req, res) => {
  try {
    const db = getDb();

    const rows = db.prepare(`
      SELECT
        e.id, e.first_name, e.last_name, e.full_name,
        e.employee_type, e.status, e.first_clock_in,
        COALESCE(SUM(a.sick_days_earned), 0)   AS total_sick_earned,
        COALESCE(SUM(a.vacation_days_earned), 0) AS total_vacation_earned,
        COALESCE(sick_taken.total, 0)  AS total_sick_taken,
        COALESCE(vac_taken.total, 0)   AS total_vacation_taken
      FROM employees e
      LEFT JOIN accruals a ON e.id = a.employee_id
      LEFT JOIN (
        SELECT employee_id, SUM(days_taken) AS total
        FROM time_off_taken WHERE type = 'sick' GROUP BY employee_id
      ) sick_taken ON e.id = sick_taken.employee_id
      LEFT JOIN (
        SELECT employee_id, SUM(days_taken) AS total
        FROM time_off_taken WHERE type = 'vacation' GROUP BY employee_id
      ) vac_taken ON e.id = vac_taken.employee_id
      GROUP BY e.id
      ORDER BY e.last_name, e.first_name
    `).all();

    const now = new Date();
    const result = rows.map(row => {
      // Tenure calculation
      let tenureDays = 0;
      if (row.first_clock_in) {
        tenureDays = Math.floor((now - new Date(row.first_clock_in)) / (1000 * 60 * 60 * 24));
      }

      // Sick balance with PR Labor Law 15-day cap
      const rawSickBalance = round2(row.total_sick_earned - row.total_sick_taken);
      const sickBalance = Math.min(rawSickBalance, SICK_BALANCE_CAP);

      return {
        ...row,
        sick_balance: sickBalance,
        sick_balance_capped: rawSickBalance > SICK_BALANCE_CAP,
        vacation_balance: round2(row.total_vacation_earned - row.total_vacation_taken),
        tenure_days: tenureDays,
        tenure_display: formatTenure(tenureDays)
      };
    });

    res.json(result);
  } catch (err) {
    console.error('Error loading accrual summary:', err.message);
    res.status(500).json({ error: 'Failed to load accrual summary' });
  }
});

// ── GET /api/accruals/detail/:employeeId — Monthly breakdown ────────
router.get('/detail/:employeeId', (req, res) => {
  try {
    const db = getDb();
    const { employeeId } = req.params;

    // Employees can only view their own data
    if (req.session.role !== 'admin' && parseInt(employeeId) !== req.session.employeeId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
    if (!employee) return res.status(404).json({ error: 'Employee not found' });

    const months = db.prepare(`
      SELECT a.year, a.month, COALESCE(mh.total_hours, 0) AS total_hours,
             a.sick_days_earned, a.vacation_days_earned, a.accrual_type
      FROM accruals a
      LEFT JOIN monthly_hours mh
        ON mh.employee_id = a.employee_id AND mh.year = a.year AND mh.month = a.month
      WHERE a.employee_id = ?
      ORDER BY a.year, a.month
    `).all(employeeId);

    const timeOff = db.prepare(
      'SELECT * FROM time_off_taken WHERE employee_id = ? ORDER BY date_taken DESC'
    ).all(employeeId);

    const requests = db.prepare(
      'SELECT * FROM time_off_requests WHERE employee_id = ? ORDER BY created_at DESC'
    ).all(employeeId);

    res.json({ employee, months, timeOff, requests });
  } catch (err) {
    console.error('Error loading employee detail:', err.message);
    res.status(500).json({ error: 'Failed to load employee detail' });
  }
});

// ── POST /api/accruals/record-timeoff — HR manual time-off entry ────
router.post('/record-timeoff', (req, res) => {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    const { employee_id, type, days_taken, date_taken, notes } = req.body;

    if (!employee_id || !type || !days_taken || !date_taken) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const db = getDb();
    db.prepare(`
      INSERT INTO time_off_taken (employee_id, type, days_taken, date_taken, notes, entered_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(employee_id, type, days_taken, date_taken, notes || null, req.session.username);

    res.json({ success: true });
  } catch (err) {
    console.error('Error recording time-off:', err.message);
    res.status(500).json({ error: 'Failed to record time-off' });
  }
});

// ── DELETE /api/accruals/time-off/:id — Remove a time-off record ─────
router.delete('/time-off/:id', (req, res) => {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    const db = getDb();
    const { id } = req.params;
    const record = db.prepare('SELECT * FROM time_off_taken WHERE id = ?').get(id);

    if (!record) return res.status(404).json({ error: 'Time-off record not found' });

    // If this was from an approved request, revert the request to pending
    const match = record.notes && record.notes.match(/Approved request #(\d+)/);
    if (match) {
      db.prepare("UPDATE time_off_requests SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL, review_notes = NULL WHERE id = ?")
        .run(match[1]);
    }

    db.prepare('DELETE FROM time_off_taken WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (err) {
    console.error('Error removing time-off record:', err.message);
    res.status(500).json({ error: 'Failed to remove time-off record' });
  }
});

// ── POST /api/accruals/recalculate — Recalculate all accruals ───────
router.post('/recalculate', (req, res) => {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    const result = runAccrualEngine();
    const flagged = checkInactiveEmployees();
    res.json({ success: true, processed: result.processed, flaggedForReview: flagged });
  } catch (err) {
    console.error('Error recalculating accruals:', err.message);
    res.status(500).json({ error: 'Accrual recalculation failed' });
  }
});

// ── Helpers ─────────────────────────────────────────────────────────

/** Round to 2 decimal places (avoids floating-point drift). */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Format tenure in days to a human-readable string (e.g. '2y 3m'). */
function formatTenure(days) {
  if (days <= 0) return 'N/A';
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  if (years > 0) return `${years}y ${months}m`;
  return `${months}m`;
}

module.exports = router;
