/**
 * Dashboard routes — stats overview, CSV export, backup management.
 */

const express = require('express');
const { getDb } = require('../db');
const { SICK_BALANCE_CAP } = require('../services/accrualEngine');
const { MONTH_NAMES_SHORT } = require('../utils/constants');

const router = express.Router();

// ── GET /api/dashboard/stats — Aggregate dashboard statistics ───────
router.get('/stats', (req, res) => {
  try {
    const db = getDb();

    const totalActive = db.prepare("SELECT COUNT(*) AS count FROM employees WHERE status = 'active'").get().count;
    const totalInactive = db.prepare("SELECT COUNT(*) AS count FROM employees WHERE status = 'inactive'").get().count;
    const flaggedCount = db.prepare("SELECT COUNT(*) AS count FROM employees WHERE flagged_for_review = 1 AND status = 'active' AND employee_type = 'hourly'").get().count;
    const pendingRequests = db.prepare("SELECT COUNT(*) AS count FROM time_off_requests WHERE status = 'pending'").get().count;

    const latestImport = db.prepare('SELECT MAX(imported_at) AS latest FROM monthly_hours').get().latest;

    // Data date range (earliest → latest month with hours data)
    const dataRange = db.prepare(`
      SELECT MIN(year * 100 + month) AS earliest, MAX(year * 100 + month) AS latest
      FROM monthly_hours
    `).get();

    let rangeStr = 'No data';
    if (dataRange?.earliest) {
      const earliestYear  = Math.floor(dataRange.earliest / 100);
      const earliestMonth = dataRange.earliest % 100;
      const latestYear    = Math.floor(dataRange.latest / 100);
      const latestMonth   = dataRange.latest % 100;
      rangeStr = `${MONTH_NAMES_SHORT[earliestMonth]} ${earliestYear} - ${MONTH_NAMES_SHORT[latestMonth]} ${latestYear}`;
    }

    // Days since last import (stale data warning)
    let daysSinceImport = null;
    if (latestImport) {
      daysSinceImport = Math.floor((Date.now() - new Date(latestImport).getTime()) / (1000 * 60 * 60 * 24));
    }

    // Employees approaching PTO balance limits (vacation ≥ 15 or sick ≥ 12)
    const ptoConcerns = db.prepare(`
      SELECT * FROM (
        SELECT
          e.id, e.first_name, e.last_name,
          COALESCE(a_vac.total, 0) - COALESCE(vt.total, 0) AS vac_balance,
          COALESCE(a_sick.total, 0) - COALESCE(st.total, 0) AS sick_balance
        FROM employees e
        LEFT JOIN (SELECT employee_id, SUM(vacation_days_earned) AS total FROM accruals GROUP BY employee_id) a_vac ON e.id = a_vac.employee_id
        LEFT JOIN (SELECT employee_id, SUM(sick_days_earned) AS total FROM accruals GROUP BY employee_id) a_sick ON e.id = a_sick.employee_id
        LEFT JOIN (SELECT employee_id, SUM(days_taken) AS total FROM time_off_taken WHERE type='vacation' GROUP BY employee_id) vt ON e.id = vt.employee_id
        LEFT JOIN (SELECT employee_id, SUM(days_taken) AS total FROM time_off_taken WHERE type='sick' GROUP BY employee_id) st ON e.id = st.employee_id
        WHERE e.status = 'active'
      ) WHERE vac_balance >= 15 OR sick_balance >= 12
    `).all();

    // Last backup timestamp
    let lastBackup = null;
    try {
      const row = db.prepare("SELECT setting_value FROM notification_settings WHERE setting_key = 'last_backup'").get();
      lastBackup = row?.setting_value || null;
    } catch (_) { /* table may not exist yet */ }

    res.json({
      totalActive,
      totalInactive,
      flaggedCount,
      pendingRequests,
      latestImport,
      daysSinceImport,
      dataRange: rangeStr,
      ptoConcerns: ptoConcerns.length,
      ptoConcernsList: ptoConcerns,
      lastBackup
    });
  } catch (err) {
    console.error('Error loading dashboard stats:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard stats' });
  }
});

// ── GET /api/dashboard/export — CSV export of all accrual data ──────
router.get('/export', (req, res) => {
  try {
    const db = getDb();

    const data = db.prepare(`
      SELECT
        e.first_name, e.last_name, e.full_name, e.employee_type, e.status, e.first_clock_in,
        COALESCE(SUM(a.sick_days_earned), 0) AS sick_earned,
        COALESCE(SUM(a.vacation_days_earned), 0) AS vacation_earned,
        COALESCE(sick_t.total, 0) AS sick_taken,
        COALESCE(vac_t.total, 0) AS vacation_taken
      FROM employees e
      LEFT JOIN accruals a ON e.id = a.employee_id
      LEFT JOIN (SELECT employee_id, SUM(days_taken) AS total FROM time_off_taken WHERE type = 'sick' GROUP BY employee_id) sick_t ON e.id = sick_t.employee_id
      LEFT JOIN (SELECT employee_id, SUM(days_taken) AS total FROM time_off_taken WHERE type = 'vacation' GROUP BY employee_id) vac_t ON e.id = vac_t.employee_id
      GROUP BY e.id
      ORDER BY e.last_name, e.first_name
    `).all();

    let csv = 'First Name,Last Name,Type,Status,Start Date,Sick Days Earned,Vacation Days Earned,Sick Days Taken,Vacation Days Taken,Sick Balance,Vacation Balance\n';

    for (const row of data) {
      const sickBal = Math.min(row.sick_earned - row.sick_taken, SICK_BALANCE_CAP).toFixed(2);
      const vacBal = (row.vacation_earned - row.vacation_taken).toFixed(2);
      csv += `"${row.first_name}","${row.last_name}","${row.employee_type}","${row.status}","${row.first_clock_in || ''}",${row.sick_earned.toFixed(2)},${row.vacation_earned.toFixed(2)},${row.sick_taken.toFixed(2)},${row.vacation_taken.toFixed(2)},${sickBal},${vacBal}\n`;
    }

    const today = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="pto-export-${today}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('Error exporting CSV:', err.message);
    res.status(500).json({ error: 'Failed to export CSV' });
  }
});

// ── POST /api/dashboard/backup — Trigger manual database backup ─────
router.post('/backup', async (req, res) => {
  try {
    const { runBackup } = require('../backup');
    const result = await runBackup();
    res.json({ success: true, message: 'Backup complete', ...result });
  } catch (err) {
    console.error('[Backup] Manual backup failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/dashboard/backup-status — Backup history info ──────────
router.get('/backup-status', (req, res) => {
  try {
    const { getBackupInfo } = require('../backup');
    const info = getBackupInfo();
    const db = getDb();

    let lastBackup = null;
    try {
      const row = db.prepare("SELECT setting_value FROM notification_settings WHERE setting_key = 'last_backup'").get();
      lastBackup = row?.setting_value || null;
    } catch (_) { /* table may not exist */ }

    res.json({
      lastBackup,
      count: info.count,
      totalSizeMB: (info.totalSize / (1024 * 1024)).toFixed(2),
      files: info.files.slice(0, 10).map(f => ({
        name: f.name,
        sizeMB: (f.size / (1024 * 1024)).toFixed(2),
        date: f.date
      }))
    });
  } catch (err) {
    console.error('Error loading backup status:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
