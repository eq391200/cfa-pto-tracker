/**
 * Employee management routes.
 *
 * Handles CRUD for employees, status toggling, flagged-employee resolution,
 * and manual employee creation (for exempt staff not in wage exports).
 */

const express = require('express');
const bcrypt = require('bcrypt');
const { getDb } = require('../db');
const { sendSlackDM, isBotConfigured } = require('../services/slackService');

const router = express.Router();

// ── GET /api/employees — List all employees (with optional filters) ─
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const { status, type, search, department } = req.query;

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
    if (department) {
      sql += ' AND department = ?';
      params.push(department);
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

// ── PUT /api/employees/:id — Update employee fields + optional portal setup ──
router.put('/:id', async (req, res) => {
  try {
    const db = getDb();
    const { employee_type, status, email, slack_user_id, department, role, pin } = req.body;
    const { id } = req.params;

    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const newType = employee_type || emp.employee_type;
    const newStatus = status || emp.status;
    const newEmail = email !== undefined ? (email || null) : (emp.email || null);
    const newSlackId = slack_user_id !== undefined ? (slack_user_id || null) : (emp.slack_user_id || null);
    const newDept = department || emp.department || 'FOH';
    const newRole = role || emp.role || 'Team Member';

    let accountCreated = false;

    // If PIN provided and employee needs setup, create the portal account
    if (pin && /^\d{4,8}$/.test(pin)) {
      const existingUser = db.prepare('SELECT id FROM users WHERE employee_id = ?').get(id);
      const existingPin = db.prepare('SELECT id FROM users WHERE username = ?').get(pin);
      if (existingUser) {
        return res.status(400).json({ error: 'This employee already has a portal account' });
      }
      if (existingPin) {
        return res.status(400).json({ error: 'A user with this PIN already exists' });
      }

      const passwordHash = await bcrypt.hash(pin, 10);
      db.prepare('INSERT INTO users (username, password_hash, role, employee_id, must_change_password) VALUES (?, ?, ?, ?, 1)')
        .run(pin, passwordHash, 'employee', id);
      accountCreated = true;
    }

    db.prepare(`
      UPDATE employees
      SET employee_type = ?, status = ?, email = ?, slack_user_id = ?, department = ?, role = ?,
          flagged_for_review = 0, needs_setup = CASE WHEN ? THEN 0 ELSE needs_setup END
      WHERE id = ?
    `).run(newType, newStatus, newEmail, newSlackId, newDept, newRole, accountCreated ? 1 : 0, id);

    // Send welcome Slack DM if account was just created
    if (accountCreated && newSlackId && isBotConfigured()) {
      const msg = `👋 *¡Bienvenido/a a Chick-fil-A La Rambla, ${emp.first_name}!*\n\n` +
        `Tu cuenta del portal de empleados ha sido creada.\n\n` +
        `🔑 *Tu PIN de acceso:* \`${pin}\`\n` +
        `🌐 *Portal:* https://cfalarambla.com\n\n` +
        `Usa tu PIN como usuario y contraseña para ingresar por primera vez. Se te pedirá cambiar tu contraseña.\n\n` +
        `¡Estamos felices de tenerte en el equipo! 🐔❤️`;
      sendSlackDM(newSlackId, msg).catch(err => {
        console.error('Failed to send welcome Slack DM:', err.message);
      });
    }

    res.json({ success: true, account_created: accountCreated });
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

// ── POST /api/employees — Create employee with user account + welcome DM ───
router.post('/', async (req, res) => {
  try {
    const db = getDb();
    const { first_name, last_name, employee_type, first_clock_in, department, role, pin, slack_user_id } = req.body;

    if (!first_name || !last_name) {
      return res.status(400).json({ error: 'First name and last name are required' });
    }
    if (!pin || !/^\d{4,8}$/.test(pin)) {
      return res.status(400).json({ error: 'PIN must be 4-8 digits' });
    }

    const full_name = first_name.trim() + ' ' + last_name.trim();

    const existing = db.prepare('SELECT id FROM employees WHERE full_name = ?').get(full_name);
    if (existing) {
      return res.status(400).json({ error: 'An employee with this name already exists' });
    }

    const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get(pin);
    if (existingUser) {
      return res.status(400).json({ error: 'A user with this PIN already exists' });
    }

    // Create employee + user account in a transaction
    const passwordHash = await bcrypt.hash(pin, 10);
    let employeeId;

    db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO employees (first_name, last_name, full_name, employee_type, first_clock_in, department, role, slack_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(first_name.trim(), last_name.trim(), full_name, employee_type || 'exempt', first_clock_in || null, department || 'FOH', role || 'Team Member', slack_user_id || null);

      employeeId = result.lastInsertRowid;

      // Create user account: PIN as username, PIN as temp password, must change on first login
      db.prepare(`
        INSERT INTO users (username, password_hash, role, employee_id, must_change_password)
        VALUES (?, ?, 'employee', ?, 1)
      `).run(pin, passwordHash, employeeId);
    })();

    // Send Slack welcome DM (async, don't block response)
    if (slack_user_id && isBotConfigured()) {
      const msg = `👋 *¡Bienvenido/a a Chick-fil-A La Rambla, ${first_name.trim()}!*\n\n` +
        `Tu cuenta del portal de empleados ha sido creada.\n\n` +
        `🔑 *Tu PIN de acceso:* \`${pin}\`\n` +
        `🌐 *Portal:* https://cfalarambla.com\n\n` +
        `Usa tu PIN como usuario y contraseña para ingresar por primera vez. Se te pedirá cambiar tu contraseña.\n\n` +
        `¡Estamos felices de tenerte en el equipo! 🐔❤️`;
      sendSlackDM(slack_user_id, msg).catch(err => {
        console.error('Failed to send welcome Slack DM:', err.message);
      });
    }

    res.json({ success: true, id: employeeId, pin });
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
