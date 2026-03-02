/**
 * Employee management routes.
 *
 * Handles CRUD for employees, status toggling, flagged-employee resolution,
 * and manual employee creation (for exempt staff not in wage exports).
 */

const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

// ── GET /api/employees — List all employees (with optional filters) ─
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const { status, type, search } = req.query;

    let sql = 'SELECT * FROM employees WHERE 1=1';
    const params = [];

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (type) {
      sql += ' AND employee_type = ?';
      params.push(type);
    }
    if (search) {
      sql += ' AND (first_name LIKE ? OR last_name LIKE ? OR full_name LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term, term);
    }

    sql += ' ORDER BY last_name, first_name';
    res.json(db.prepare(sql).all(...params));
  } catch (err) {
    console.error('Error listing employees:', err.message);
    res.status(500).json({ error: 'Failed to load employees' });
  }
});

// ── GET /api/employees/flagged — Employees flagged for inactivity review ─
router.get('/flagged', (req, res) => {
  try {
    const db = getDb();
    const flagged = db.prepare(`
      SELECT * FROM employees
      WHERE flagged_for_review = 1 AND status = 'active' AND employee_type = 'hourly'
      ORDER BY full_name
    `).all();
    res.json(flagged);
  } catch (err) {
    console.error('Error loading flagged employees:', err.message);
    res.status(500).json({ error: 'Failed to load flagged employees' });
  }
});

// ── PUT /api/employees/:id — Update employee fields ─────────────────
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const { employee_type, status, email, slack_user_id } = req.body;
    const { id } = req.params;

    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const newType = employee_type || emp.employee_type;
    const newStatus = status || emp.status;
    const newEmail = email !== undefined ? (email || null) : (emp.email || null);
    const newSlackId = slack_user_id !== undefined ? (slack_user_id || null) : (emp.slack_user_id || null);

    db.prepare(`
      UPDATE employees
      SET employee_type = ?, status = ?, email = ?, slack_user_id = ?, flagged_for_review = 0
      WHERE id = ?
    `).run(newType, newStatus, newEmail, newSlackId, id);

    res.json({ success: true });
  } catch (err) {
    console.error('Error updating employee:', err.message);
    res.status(500).json({ error: 'Failed to update employee' });
  }
});

// ── POST /api/employees/:id/resolve — Resolve a flagged employee ────
router.post('/:id/resolve', (req, res) => {
  try {
    const db = getDb();
    const { action } = req.body; // 'deactivate' or 'keep_active'
    const { id } = req.params;

    if (action === 'deactivate') {
      db.prepare("UPDATE employees SET status = 'inactive', flagged_for_review = 0 WHERE id = ?").run(id);
    } else {
      db.prepare('UPDATE employees SET flagged_for_review = 0, consecutive_empty_months = 0 WHERE id = ?').run(id);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error resolving flag:', err.message);
    res.status(500).json({ error: 'Failed to resolve employee flag' });
  }
});

// ── POST /api/employees — Create employee manually (exempt staff) ───
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const { first_name, last_name, employee_type, first_clock_in } = req.body;

    if (!first_name || !last_name) {
      return res.status(400).json({ error: 'First name and last name are required' });
    }

    // Space between first and last name (was previously missing — critical bug fix)
    const full_name = first_name.trim() + ' ' + last_name.trim();

    const existing = db.prepare('SELECT id FROM employees WHERE full_name = ?').get(full_name);
    if (existing) {
      return res.status(400).json({ error: 'An employee with this name already exists' });
    }

    const result = db.prepare(`
      INSERT INTO employees (first_name, last_name, full_name, employee_type, first_clock_in)
      VALUES (?, ?, ?, ?, ?)
    `).run(first_name.trim(), last_name.trim(), full_name, employee_type || 'exempt', first_clock_in || null);

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('Error creating employee:', err.message);
    res.status(500).json({ error: 'Failed to create employee' });
  }
});

// ── GET /api/employees/:id — Single employee detail ─────────────────
router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    res.json(emp);
  } catch (err) {
    console.error('Error loading employee:', err.message);
    res.status(500).json({ error: 'Failed to load employee' });
  }
});

module.exports = router;
