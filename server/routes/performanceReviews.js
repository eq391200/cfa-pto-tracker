/**
 * Performance Reviews — CRUD + Excel export.
 *
 * Admin can create/update/delete reviews; employees can read their own.
 * Each employee gets one review per quarter (UNIQUE constraint).
 */

const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

const CATEGORIES = ['operations', 'cfa_values', 'communication', 'guest_obsession', 'responsibility', 'culture'];
const BOH_SUBSECTIONS = ['boh_primaria', 'boh_secundaria', 'boh_maquinas', 'boh_breading', 'boh_fileteo', 'boh_prep', 'boh_desayuno'];

// ── Helpers ──────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (req.session?.role === 'admin') return next();
  res.status(403).json({ error: 'Admin access required' });
}

function requireAdminOrDirector(req, res, next) {
  if (req.session?.role === 'admin') return next();
  // Check if employee has Director or Senior Director role
  if (req.session?.employeeId) {
    const db = getDb();
    const emp = db.prepare('SELECT role FROM employees WHERE id = ?').get(req.session.employeeId);
    if (emp && ['Director', 'Senior Director', 'Shift Leader'].includes(emp.role)) {
      return next();
    }
  }
  res.status(403).json({ error: 'Director access required' });
}

function calcAverage(row) {
  const sum = CATEGORIES.reduce((s, c) => s + row[c], 0);
  return Math.round((sum / CATEGORIES.length) * 100) / 100;
}

function isBohEmployee(employeeId) {
  const db = getDb();
  const emp = db.prepare('SELECT department FROM employees WHERE id = ?').get(employeeId);
  return emp && (emp.department === 'BOH' || emp.department === 'BOH/FOH');
}

function calcBohOperations(body) {
  const scores = BOH_SUBSECTIONS.map(s => parseInt(body[s], 10));
  if (scores.some(v => isNaN(v))) return null;
  return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100;
}

function validateScores(body) {
  for (const cat of CATEGORIES) {
    // For BOH employees, operations score is auto-calculated from subsections
    if (cat === 'operations' && body._is_boh) continue;
    const v = parseInt(body[cat], 10);
    if (isNaN(v) || v < 1 || v > 5) return `${cat} must be an integer between 1 and 5`;
  }
  // Validate BOH subsections if applicable
  if (body._is_boh) {
    for (const sub of BOH_SUBSECTIONS) {
      const v = parseInt(body[sub], 10);
      if (isNaN(v) || v < 1 || v > 5) return `${sub} must be an integer between 1 and 5`;
    }
  }
  const q = parseInt(body.quarter, 10);
  if (isNaN(q) || q < 1 || q > 4) return 'quarter must be 1-4';
  const y = parseInt(body.year, 10);
  if (isNaN(y) || y < 2020) return 'invalid year';
  if (!body.employee_id) return 'employee_id is required';
  return null;
}

// ── GET /  — list all reviews (admin) ────────────────────────────────
router.get('/', requireAdminOrDirector, (req, res) => {
  try {
    const db = getDb();
    const { year, quarter, department } = req.query;

    let sql = `
      SELECT pr.*, e.full_name AS employee_name, e.department AS employee_department
      FROM performance_reviews pr
      JOIN employees e ON e.id = pr.employee_id
      WHERE 1=1
    `;
    const params = [];

    if (year) { sql += ' AND pr.year = ?'; params.push(parseInt(year, 10)); }
    if (quarter) { sql += ' AND pr.quarter = ?'; params.push(parseInt(quarter, 10)); }
    if (department) { sql += ' AND (e.department = ? OR e.department = ?)'; params.push(department, 'BOH/FOH'); }

    sql += ' ORDER BY pr.year DESC, pr.quarter DESC, e.full_name';
    const rows = db.prepare(sql).all(...params);
    res.json(rows.map(r => ({ ...r, average: calcAverage(r) })));
  } catch (err) {
    console.error('Error listing reviews:', err.message);
    res.status(500).json({ error: 'Failed to load reviews' });
  }
});

// ── GET /team-averages — team averages by department for a quarter ─────
router.get('/team-averages', (req, res) => {
  try {
    const db = getDb();
    const { year, quarter } = req.query;
    if (!year || !quarter) return res.status(400).json({ error: 'year and quarter required' });

    const rows = db.prepare(`
      SELECT e.department,
        AVG(pr.operations) as operations,
        AVG(pr.cfa_values) as cfa_values,
        AVG(pr.communication) as communication,
        AVG(pr.guest_obsession) as guest_obsession,
        AVG(pr.responsibility) as responsibility,
        AVG(pr.culture) as culture,
        COUNT(*) as count
      FROM performance_reviews pr
      JOIN employees e ON e.id = pr.employee_id
      WHERE pr.year = ? AND pr.quarter = ?
      GROUP BY e.department
    `).all(parseInt(year), parseInt(quarter));

    // Also compute overall team average
    const overall = db.prepare(`
      SELECT AVG(pr.operations) as operations,
        AVG(pr.cfa_values) as cfa_values,
        AVG(pr.communication) as communication,
        AVG(pr.guest_obsession) as guest_obsession,
        AVG(pr.responsibility) as responsibility,
        AVG(pr.culture) as culture,
        COUNT(*) as count
      FROM performance_reviews pr
      WHERE pr.year = ? AND pr.quarter = ?
    `).get(parseInt(year), parseInt(quarter));

    const result = {};
    rows.forEach(r => {
      result[r.department] = {
        operations: +r.operations?.toFixed(2) || 0,
        cfa_values: +r.cfa_values?.toFixed(2) || 0,
        communication: +r.communication?.toFixed(2) || 0,
        guest_obsession: +r.guest_obsession?.toFixed(2) || 0,
        responsibility: +r.responsibility?.toFixed(2) || 0,
        culture: +r.culture?.toFixed(2) || 0,
        count: r.count
      };
    });
    result.all = {
      operations: +overall.operations?.toFixed(2) || 0,
      cfa_values: +overall.cfa_values?.toFixed(2) || 0,
      communication: +overall.communication?.toFixed(2) || 0,
      guest_obsession: +overall.guest_obsession?.toFixed(2) || 0,
      responsibility: +overall.responsibility?.toFixed(2) || 0,
      culture: +overall.culture?.toFixed(2) || 0,
      count: overall.count
    };
    res.json(result);
  } catch (err) {
    console.error('Error loading team averages:', err.message);
    res.status(500).json({ error: 'Failed to load team averages' });
  }
});

// ── GET /employee/:id  — reviews for one employee ────────────────────
router.get('/employee/:id', (req, res) => {
  try {
    const db = getDb();
    const employeeId = parseInt(req.params.id, 10);

    // Non-admins can only view their own
    if (req.session.role !== 'admin' && req.session.employeeId !== employeeId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const rows = db.prepare(`
      SELECT * FROM performance_reviews
      WHERE employee_id = ?
      ORDER BY year ASC, quarter ASC
    `).all(employeeId);

    res.json(rows.map(r => ({ ...r, average: calcAverage(r) })));
  } catch (err) {
    console.error('Error fetching employee reviews:', err.message);
    res.status(500).json({ error: 'Failed to load reviews' });
  }
});

// ── POST /  — create or replace a review (admin) ─────────────────────
router.post('/', requireAdminOrDirector, (req, res) => {
  try {
    const db = getDb();
    const { employee_id, year, quarter, overall_override, comments } = req.body;

    // Check if this is a BOH review — client sends is_boh flag for BOH/FOH employees
    // Handle both boolean and string 'true'/'false' from JSON
    let empIsBoh;
    if (req.body.is_boh !== undefined) {
      empIsBoh = req.body.is_boh === true || req.body.is_boh === 'true';
    } else {
      empIsBoh = isBohEmployee(employee_id);
    }
    req.body._is_boh = empIsBoh;

    // Strip BOH subsection values if not a BOH review to prevent validation errors
    if (!empIsBoh) {
      for (const sub of BOH_SUBSECTIONS) { delete req.body[sub]; }
    }

    const err = validateScores(req.body);
    if (err) return res.status(400).json({ error: err });

    // For BOH, auto-calculate operations from subsections (rounded to nearest int for storage)
    let opsScore = parseInt(req.body.operations, 10);
    if (empIsBoh) {
      const avg = calcBohOperations(req.body);
      opsScore = Math.round(avg);
    }

    const stmt = db.prepare(`
      INSERT INTO performance_reviews
        (employee_id, year, quarter, operations, cfa_values, communication,
         guest_obsession, responsibility, culture, overall_override, comments, submitted_by,
         boh_primaria, boh_secundaria, boh_maquinas, boh_breading, boh_fileteo, boh_prep, boh_desayuno,
         updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(employee_id, year, quarter) DO UPDATE SET
        operations = excluded.operations,
        cfa_values = excluded.cfa_values,
        communication = excluded.communication,
        guest_obsession = excluded.guest_obsession,
        responsibility = excluded.responsibility,
        culture = excluded.culture,
        overall_override = excluded.overall_override,
        comments = excluded.comments,
        submitted_by = excluded.submitted_by,
        boh_primaria = excluded.boh_primaria,
        boh_secundaria = excluded.boh_secundaria,
        boh_maquinas = excluded.boh_maquinas,
        boh_breading = excluded.boh_breading,
        boh_fileteo = excluded.boh_fileteo,
        boh_prep = excluded.boh_prep,
        boh_desayuno = excluded.boh_desayuno,
        updated_at = CURRENT_TIMESTAMP
    `);

    const overrideVal = overall_override != null && overall_override !== '' ? parseFloat(overall_override) : null;
    const bohVals = empIsBoh
      ? BOH_SUBSECTIONS.map(s => parseInt(req.body[s], 10))
      : BOH_SUBSECTIONS.map(() => null);

    const result = stmt.run(
      parseInt(employee_id, 10),
      parseInt(year, 10),
      parseInt(quarter, 10),
      opsScore,
      parseInt(req.body.cfa_values, 10),
      parseInt(req.body.communication, 10),
      parseInt(req.body.guest_obsession, 10),
      parseInt(req.body.responsibility, 10),
      parseInt(req.body.culture, 10),
      overrideVal,
      comments || null,
      req.session.username || 'admin',
      ...bohVals
    );

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('Error saving review:', err.message);
    res.status(500).json({ error: 'Failed to save review' });
  }
});

// ── DELETE /:id  — remove a review (admin) ───────────────────────────
router.delete('/:id', requireAdminOrDirector, (req, res) => {
  try {
    const db = getDb();
    db.prepare('DELETE FROM performance_reviews WHERE id = ?').run(parseInt(req.params.id, 10));
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting review:', err.message);
    res.status(500).json({ error: 'Failed to delete review' });
  }
});

// ── GET /export  — download all reviews as Excel (admin) ─────────────
router.get('/export', requireAdminOrDirector, (req, res) => {
  try {
    const XLSX = require('xlsx');
    const db = getDb();

    const rows = db.prepare(`
      SELECT pr.*, e.full_name AS employee_name
      FROM performance_reviews pr
      JOIN employees e ON e.id = pr.employee_id
      ORDER BY pr.year DESC, pr.quarter DESC, e.full_name
    `).all();

    const data = rows.map(r => ({
      'Employee': r.employee_name,
      'Year': r.year,
      'Quarter': `Q${r.quarter}`,
      'Conoce y Ejecuta la Operación': r.operations,
      'Vive los Valores de CFA': r.cfa_values,
      'Se Comunica con Claridad': r.communication,
      'Obsesión por el Invitado': r.guest_obsession,
      'Demuestra Responsabilidad': r.responsibility,
      'Protege la Cultura y Actitud Positiva': r.culture,
      'Average': calcAverage(r),
      'Overall Score': r.overall_override != null ? r.overall_override : calcAverage(r),
      'Comments': r.comments || '',
      'Submitted By': r.submitted_by || '',
      'Date': r.updated_at || r.created_at
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);

    // Set column widths
    ws['!cols'] = [
      { wch: 25 }, { wch: 6 }, { wch: 6 },
      { wch: 12 }, { wch: 12 }, { wch: 12 },
      { wch: 12 }, { wch: 12 }, { wch: 12 },
      { wch: 8 }, { wch: 10 }, { wch: 30 },
      { wch: 12 }, { wch: 18 }
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'Performance Reviews');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="performance-reviews.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error('Error exporting reviews:', err.message);
    res.status(500).json({ error: 'Failed to export reviews' });
  }
});

module.exports = router;
