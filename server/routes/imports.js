/**
 * File import routes — upload, preview, and commit wage export data.
 *
 * Two-step flow:
 *   1. POST /preview — parse file, return preview without saving
 *   2. POST /commit  — save parsed data to DB, run accrual engine
 *
 * Accepted format: Excel (.xlsx) or CSV matching the CFA wage export schema.
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db');
const { parseWageExport } = require('../services/excelParser');
const { runAccrualEngine, checkInactiveEmployees } = require('../services/accrualEngine');

const router = express.Router();

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB max
});

// ── POST /api/import/preview — Parse uploaded file and return preview ─
router.post('/preview', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const result = parseWageExport(req.file.path);
    const preview = {
      totalRows: result.totalRows,
      employeeCount: result.employees.size,
      employees: [],
      monthRange: { earliest: null, latest: null }
    };

    for (const [fullName, info] of result.employees) {
      const months = result.monthlyHours.get(fullName);
      const monthKeys = [...months.keys()].sort();
      const earliest = result.earliestDate.get(fullName);

      preview.employees.push({
        fullName,
        firstName: info.firstName,
        lastName: info.lastName,
        monthCount: months.size,
        totalHours: [...months.values()].reduce((a, b) => a + b, 0),
        firstMonth: monthKeys[0],
        lastMonth: monthKeys[monthKeys.length - 1],
        earliestDate: earliest?.toISOString().split('T')[0]
      });

      for (const mk of monthKeys) {
        if (!preview.monthRange.earliest || mk < preview.monthRange.earliest) preview.monthRange.earliest = mk;
        if (!preview.monthRange.latest || mk > preview.monthRange.latest) preview.monthRange.latest = mk;
      }
    }

    preview.employees.sort((a, b) => a.fullName.localeCompare(b.fullName));

    // ── Duplicate detection: check which months already have data ────
    const db = getDb();
    const existingMonths = db.prepare(`
      SELECT e.full_name, mh.year, mh.month, mh.total_hours
      FROM monthly_hours mh
      JOIN employees e ON mh.employee_id = e.id
    `).all();

    const existingMap = new Map(); // "FullName|YYYY-MM" → hours
    for (const row of existingMonths) {
      const key = `${row.full_name}|${row.year}-${String(row.month).padStart(2, '0')}`;
      existingMap.set(key, row.total_hours);
    }

    let duplicateCount = 0;
    const duplicateDetails = [];

    for (const emp of preview.employees) {
      const months = result.monthlyHours.get(emp.fullName);
      for (const [yearMonth] of months) {
        const key = `${emp.fullName}|${yearMonth}`;
        if (existingMap.has(key)) {
          duplicateCount++;
          duplicateDetails.push({
            name: emp.fullName,
            month: yearMonth,
            existingHours: existingMap.get(key)
          });
        }
      }
    }

    preview.duplicates = {
      count: duplicateCount,
      details: duplicateDetails
    };

    // Keep the temp file for the commit step
    res.json({ success: true, preview, tempFile: req.file.filename });
  } catch (err) {
    // Clean up temp file on parse failure
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.status(400).json({ error: 'Failed to parse file: ' + err.message });
  }
});

// ── POST /api/import/commit — Save previewed data to database ───────
router.post('/commit', (req, res) => {
  const { tempFile } = req.body;
  if (!tempFile) return res.status(400).json({ error: 'No temp file specified' });

  // Prevent directory traversal
  const safeName = path.basename(tempFile);
  const filePath = path.join(uploadDir, safeName);
  if (!fs.existsSync(filePath)) return res.status(400).json({ error: 'Temp file not found. Please re-upload.' });

  try {
    const db = getDb();
    const result = parseWageExport(filePath);

    const upsertEmployee = db.prepare(`
      INSERT INTO employees (first_name, last_name, full_name, first_clock_in)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(full_name) DO UPDATE SET
        first_clock_in = CASE
          WHEN employees.first_clock_in IS NULL OR excluded.first_clock_in < employees.first_clock_in
          THEN excluded.first_clock_in
          ELSE employees.first_clock_in
        END
    `);

    const getEmployee = db.prepare('SELECT id FROM employees WHERE full_name = ?');

    const upsertHours = db.prepare(`
      INSERT INTO monthly_hours (employee_id, year, month, total_hours)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(employee_id, year, month) DO UPDATE SET
        total_hours = excluded.total_hours,
        imported_at = CURRENT_TIMESTAMP
    `);

    let employeesCreated = 0;
    let monthsInserted = 0;
    let monthsUpdated = 0;

    // Check existing monthly_hours for new-vs-update tracking
    const checkExisting = db.prepare(
      'SELECT 1 FROM monthly_hours WHERE employee_id = ? AND year = ? AND month = ?'
    );

    // Run everything in a transaction for atomicity
    const importAll = db.transaction(() => {
      for (const [fullName, info] of result.employees) {
        const earliest = result.earliestDate.get(fullName);
        const earliestStr = earliest ? earliest.toISOString().split('T')[0] : null;

        if (!getEmployee.get(fullName)) employeesCreated++;
        upsertEmployee.run(info.firstName, info.lastName, fullName, earliestStr);

        const emp = getEmployee.get(fullName);
        const months = result.monthlyHours.get(fullName);

        for (const [yearMonth, hours] of months) {
          const [y, m] = yearMonth.split('-').map(Number);
          if (checkExisting.get(emp.id, y, m)) {
            monthsUpdated++;
          } else {
            monthsInserted++;
          }
          upsertHours.run(emp.id, y, m, Math.round(hours * 10000) / 10000);
        }
      }
    });

    importAll();

    // Post-import: recalculate accruals and flag inactive employees
    const accrualResult = runAccrualEngine();
    const flagged = checkInactiveEmployees();

    // Clean up temp file
    try { fs.unlinkSync(filePath); } catch (_) {}

    res.json({
      success: true,
      employeesCreated,
      monthsInserted,
      monthsUpdated,
      accrualsProcessed: accrualResult.processed,
      flaggedForReview: flagged
    });
  } catch (err) {
    console.error('Import failed:', err.message);
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

module.exports = router;
