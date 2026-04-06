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
const { sendSlackToChannel, isBotConfigured } = require('../services/slackService');

const router = express.Router();

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB max
});

// ── Name Quality Helpers ───────────────────────────────────────────

/**
 * Normalize a name for fuzzy comparison: lowercase, strip accents,
 * collapse whitespace, remove punctuation.
 */
function normalizeName(name) {
  return name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // strip accents
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')  // remove non-alpha except spaces
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detect potential name quality issues in the parsed import data
 * by comparing against existing DB employees.
 *
 * Returns arrays of:
 *   - nearDuplicates: imported names that look very similar to existing DB names
 *     but don't match exactly (e.g. missing space, case difference, accent difference)
 *   - importDuplicates: names within the import file that normalize to the same value
 *     but have different exact strings
 */
function detectNameIssues(parsedEmployees, db) {
  const issues = {
    nearDuplicates: [],   // imported name ≈ existing DB name but not exact match
    importDuplicates: []  // two imported names normalize to the same thing
  };

  const existing = db.prepare('SELECT id, full_name FROM employees').all();

  // Build normalized lookup of existing DB names
  const dbNormMap = new Map(); // normalized → { id, full_name }
  for (const e of existing) {
    const norm = normalizeName(e.full_name);
    dbNormMap.set(norm, e);
    // Also index without spaces for catching missing-space bugs
    dbNormMap.set(norm.replace(/\s/g, ''), e);
  }

  // Build normalized lookup of imported names to detect intra-file duplicates
  const importNormMap = new Map(); // normalized → [fullName, ...]
  const importNames = [...parsedEmployees.keys()];

  for (const fullName of importNames) {
    const norm = normalizeName(fullName);
    if (!importNormMap.has(norm)) importNormMap.set(norm, []);
    importNormMap.get(norm).push(fullName);
  }

  // Check for intra-import duplicates (same normalized form, different strings)
  for (const [norm, names] of importNormMap) {
    if (names.length > 1) {
      issues.importDuplicates.push({
        normalized: norm,
        variants: names
      });
    }
  }

  // Check each imported name against DB
  const matchedDbIds = new Set(); // track which DB employees are already matched
  for (const fullName of importNames) {
    // Skip if exact match exists (that's expected — just an update)
    const exactMatch = existing.find(e => e.full_name === fullName);
    if (exactMatch) { matchedDbIds.add(exactMatch.id); continue; }

    const norm = normalizeName(fullName);
    const noSpaceNorm = norm.replace(/\s/g, '');

    // Check if normalized form matches an existing employee
    let dbMatch = dbNormMap.get(norm) || dbNormMap.get(noSpaceNorm);

    // Fuzzy fallback: edit distance ≤ 2 on normalized names
    if (!dbMatch) {
      for (const e of existing) {
        if (matchedDbIds.has(e.id)) continue;
        const eNorm = normalizeName(e.full_name);
        if (Math.abs(eNorm.length - norm.length) <= 2 && editDistance(eNorm, norm) <= 2) {
          dbMatch = e;
          break;
        }
      }
    }

    if (dbMatch && dbMatch.full_name !== fullName) {
      matchedDbIds.add(dbMatch.id);
      issues.nearDuplicates.push({
        importedName: fullName,
        existingName: dbMatch.full_name,
        existingId: dbMatch.id,
        reason: detectMismatchReason(fullName, dbMatch.full_name)
      });
    }
  }

  return issues;
}

/**
 * Determine why two names are near-duplicates but not exact matches.
 */
function detectMismatchReason(importedName, dbName) {
  const a = importedName.trim();
  const b = dbName.trim();

  // Missing or extra space
  if (a.replace(/\s/g, '').toLowerCase() === b.replace(/\s/g, '').toLowerCase()) {
    return 'spacing';
  }
  // Case difference only
  if (a.toLowerCase() === b.toLowerCase()) {
    return 'case';
  }
  // Accent difference
  const aNorm = a.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const bNorm = b.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (aNorm === bNorm) {
    return 'accents';
  }
  if (aNorm.replace(/\s/g, '') === bNorm.replace(/\s/g, '')) {
    return 'spacing+accents';
  }
  return 'similar';
}

/**
 * Simple edit distance (Levenshtein) for short strings.
 */
function editDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + (b[i - 1] === a[j - 1] ? 0 : 1)
      );
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Find active employees in the DB who have ZERO hours in the imported
 * date range — they may have left or been missed from the payroll export.
 *
 * @param {Map} parsedEmployees - from parser
 * @param {Map} parsedMonthlyHours - from parser
 * @param {Object} db - database handle
 * @param {Array} nearDuplicates - from detectNameIssues(), DB employees
 *   already matched via fuzzy name comparison
 */
function findActiveWithNoHours(parsedEmployees, parsedMonthlyHours, db, nearDuplicates) {
  // Determine the month range covered by this import
  let minYM = null, maxYM = null;
  for (const [, months] of parsedMonthlyHours) {
    for (const ym of months.keys()) {
      if (!minYM || ym < minYM) minYM = ym;
      if (!maxYM || ym > maxYM) maxYM = ym;
    }
  }
  if (!minYM) return [];

  const [minY, minM] = minYM.split('-').map(Number);
  const [maxY, maxM] = maxYM.split('-').map(Number);

  // Get all active employees from DB
  const activeEmployees = db.prepare(
    "SELECT id, full_name, employee_type, first_clock_in FROM employees WHERE status = 'active'"
  ).all();

  // Build a set of imported names (normalized) for matching
  const importedNormSet = new Set();
  const importedNormNames = []; // for edit-distance fallback
  for (const fullName of parsedEmployees.keys()) {
    const norm = normalizeName(fullName);
    importedNormSet.add(norm);
    importedNormSet.add(norm.replace(/\s/g, ''));
    importedNormNames.push(norm);
  }

  // Build set of DB employee IDs already accounted for via near-duplicate matching
  const nearDupeDbIds = new Set();
  if (nearDuplicates) {
    for (const nd of nearDuplicates) {
      nearDupeDbIds.add(nd.existingId);
    }
  }

  // Check which active employees have no hours in the import range
  const getHours = db.prepare(
    'SELECT SUM(total_hours) as total FROM monthly_hours WHERE employee_id = ? AND (year * 100 + month) BETWEEN ? AND ?'
  );

  const missing = [];
  const rangeStart = minY * 100 + minM;
  const rangeEnd = maxY * 100 + maxM;

  for (const emp of activeEmployees) {
    const empNorm = normalizeName(emp.full_name);

    // Skip if this employee IS in the current import (exact normalized match)
    if (importedNormSet.has(empNorm) || importedNormSet.has(empNorm.replace(/\s/g, ''))) continue;

    // Skip if already identified as a near-duplicate match
    if (nearDupeDbIds.has(emp.id)) continue;

    // Fuzzy fallback: skip if any imported name is within edit distance ≤ 2
    const isFuzzyMatch = importedNormNames.some(n => {
      // Quick length check to avoid expensive edit-distance on very different names
      if (Math.abs(n.length - empNorm.length) > 2) return false;
      return editDistance(n, empNorm) <= 2;
    });
    if (isFuzzyMatch) continue;

    // Skip exempt employees — they don't need punch data
    if (emp.employee_type === 'exempt') continue;

    // Check if employee was hired before this import period
    if (emp.first_clock_in) {
      const hireDate = new Date(emp.first_clock_in);
      const periodStart = new Date(minY, minM - 1, 1);
      if (hireDate > periodStart) continue; // hired after this period — expected to have no hours
    }

    // Check if they have ANY existing hours in the import range
    const existing = getHours.get(emp.id, rangeStart, rangeEnd);
    const hasExistingHours = existing && existing.total > 0;

    missing.push({
      id: emp.id,
      fullName: emp.full_name,
      hasExistingHours,
      employeeType: emp.employee_type
    });
  }

  return missing;
}

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

    // ── Name quality checks ─────────────────────────────────────────
    preview.nameIssues = detectNameIssues(result.employees, db);

    // ── Active employees not in this import ─────────────────────────
    preview.activeNoHours = findActiveWithNoHours(result.employees, result.monthlyHours, db, preview.nameIssues.nearDuplicates);

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
    let namesCorrected = 0;
    const newEmployeeNames = [];
    const correctedNames = [];

    // Check existing monthly_hours for new-vs-update tracking
    const checkExisting = db.prepare(
      'SELECT 1 FROM monthly_hours WHERE employee_id = ? AND year = ? AND month = ?'
    );

    const flagSetup = db.prepare('UPDATE employees SET needs_setup = 1 WHERE id = ?');

    // ── Pre-compute name correction map ──────────────────────────────
    // If an imported name doesn't match any DB name exactly but matches
    // a normalized version, redirect hours to the existing employee
    // instead of creating a duplicate.
    const nameIssues = detectNameIssues(result.employees, db);
    const nameRedirectMap = new Map(); // importedName → existingDbName
    for (const nd of nameIssues.nearDuplicates) {
      nameRedirectMap.set(nd.importedName, nd.existingName);
    }

    // Run everything in a transaction for atomicity
    const importAll = db.transaction(() => {
      for (const [fullName, info] of result.employees) {
        const earliest = result.earliestDate.get(fullName);
        const earliestStr = earliest ? earliest.toISOString().split('T')[0] : null;

        // Apply name correction if a near-duplicate was detected
        let resolvedName = fullName;
        if (nameRedirectMap.has(fullName)) {
          resolvedName = nameRedirectMap.get(fullName);
          namesCorrected++;
          correctedNames.push({ from: fullName, to: resolvedName });
          console.log(`  Import name corrected: "${fullName}" → "${resolvedName}"`);
        }

        const isNew = !getEmployee.get(resolvedName);
        if (isNew) {
          employeesCreated++;
          // Use the resolved name (possibly corrected) for insert
          const spaceIdx = resolvedName.indexOf(' ');
          const rFirst = spaceIdx > 0 ? resolvedName.substring(0, spaceIdx) : resolvedName;
          const rLast = spaceIdx > 0 ? resolvedName.substring(spaceIdx + 1) : '';
          upsertEmployee.run(rFirst, rLast, resolvedName, earliestStr);
        } else {
          // Update first_clock_in if needed (using resolved name)
          upsertEmployee.run(info.firstName, info.lastName, resolvedName, earliestStr);
        }

        const emp = getEmployee.get(resolvedName);

        // Flag new employees as needing setup (no portal account)
        if (isNew) {
          flagSetup.run(emp.id);
          newEmployeeNames.push(resolvedName);
        }

        const months = result.monthlyHours.get(fullName); // original name in parsed data

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

    // Send Slack notification to Directores channel for new employees
    if (newEmployeeNames.length > 0 && isBotConfigured() && process.env.SLACK_DIRECTORES_CHANNEL) {
      const msg = `📋 *Nuevos empleados detectados en importación de nómina*\n\n` +
        `Se crearon *${newEmployeeNames.length}* empleado(s) nuevo(s) que necesitan configuración de portal:\n\n` +
        newEmployeeNames.map(n => `• ${n}`).join('\n') +
        `\n\n⚠️ *Acción requerida:* Ir a Employees → buscar los empleados con badge "Setup Required" → asignar PIN, departamento, rol y Slack ID.`;
      sendSlackToChannel(process.env.SLACK_DIRECTORES_CHANNEL, msg).catch(err => {
        console.error('Failed to send new employee Slack notification:', err.message);
      });
    }

    // Clean up temp file
    try { fs.unlinkSync(filePath); } catch (_) {}

    // ── Active employees missing from this import ──────────────────
    const activeNoHours = findActiveWithNoHours(result.employees, result.monthlyHours, db, nameIssues.nearDuplicates);

    res.json({
      success: true,
      employeesCreated,
      newEmployeeNames,
      monthsInserted,
      monthsUpdated,
      namesCorrected,
      correctedNames,
      accrualsProcessed: accrualResult.processed,
      flaggedForReview: flagged,
      activeNoHours
    });
  } catch (err) {
    console.error('Import failed:', err.message);
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

module.exports = router;
