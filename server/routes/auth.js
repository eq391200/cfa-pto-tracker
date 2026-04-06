/**
 * Authentication routes — login, logout, password management, user accounts.
 *
 * Two account types:
 *   - admin: full dashboard access, manages employees and settings
 *   - employee: limited to viewing own PTO balance and submitting requests
 *
 * Employee accounts use a PIN as username + temporary password.
 * On first login, employees must set a permanent password.
 */

const express = require('express');
const bcrypt = require('bcrypt');
const { getDb } = require('../db');

const router = express.Router();
const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 6;

// ── POST /api/auth/login — Authenticate user ────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    // Establish session
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.employeeId = user.employee_id;

    const response = { success: true, role: user.role, username: user.username };
    if (user.must_change_password) response.mustChangePassword = true;

    res.json(response);
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── POST /api/auth/set-password — Employee sets password on first login ─
router.post('/set-password', async (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    const db = getDb();
    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
      .run(hash, req.session.userId);

    res.json({ success: true, role: req.session.role });
  } catch (err) {
    console.error('Set-password error:', err.message);
    res.status(500).json({ error: 'Failed to set password' });
  }
});

// ── POST /api/auth/reset-to-pin — Self-service password reset ───────
// Public endpoint (no auth). Resets password back to PIN and forces password change.
router.post('/reset-to-pin', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) {
      return res.status(400).json({ error: 'PIN is required' });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
      // Don't reveal whether the account exists
      return res.json({ success: true });
    }

    // Reset password to the PIN (username) and require change on next login
    const hash = await bcrypt.hash(user.username, BCRYPT_ROUNDS);
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?')
      .run(hash, user.id);

    res.json({ success: true });
  } catch (err) {
    console.error('Reset-to-pin error:', err.message);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ── POST /api/auth/logout — Destroy session ─────────────────────────
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// ── GET /api/auth/me — Current session info ─────────────────────────
router.get('/me', (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const response = {
    userId: req.session.userId,
    username: req.session.username,
    role: req.session.role,
    employeeId: req.session.employeeId
  };
  // Include employee role (Director, etc.) for permission checks
  if (req.session.employeeId) {
    const db = getDb();
    const emp = db.prepare('SELECT role AS employee_role, department FROM employees WHERE id = ?').get(req.session.employeeId);
    if (emp) {
      response.employeeRole = emp.employee_role;
      response.department = emp.department;
    }
  }
  res.json(response);
});

// ── POST /api/auth/change-password — Admin changes own password ─────
// Uses POST instead of PUT for mobile proxy compatibility.
router.post('/change-password', async (req, res) => {
  if (!req.session?.userId || req.session?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.session.userId);
    res.json({ success: true });
  } catch (err) {
    console.error('Change-password error:', err.message);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// ── GET /api/auth/users — List all user accounts (admin only) ───────
router.get('/users', (req, res) => {
  if (req.session?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    const db = getDb();
    const users = db.prepare(`
      SELECT u.id, u.username, u.role, u.employee_id, u.must_change_password,
             e.first_name, e.last_name
      FROM users u
      LEFT JOIN employees e ON u.employee_id = e.id
      WHERE e.status = 'active' OR e.id IS NULL
      ORDER BY u.username
    `).all();
    res.json(users);
  } catch (err) {
    console.error('Error listing users:', err.message);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// ── POST /api/auth/users — Create an employee user account ──────────
router.post('/users', async (req, res) => {
  if (req.session?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    const { username, employee_id } = req.body;
    if (!username || !employee_id) {
      return res.status(400).json({ error: 'Username/PIN and employee are required' });
    }

    const db = getDb();

    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
      return res.status(400).json({ error: 'Username already taken' });
    }

    const existingLink = db.prepare('SELECT id, username FROM users WHERE employee_id = ?').get(employee_id);
    if (existingLink) {
      return res.status(400).json({ error: `This employee already has an account: ${existingLink.username}` });
    }

    // PIN is both username and temporary password; must_change_password forces reset on first login
    const hash = await bcrypt.hash(username, BCRYPT_ROUNDS);
    const result = db.prepare(`
      INSERT INTO users (username, password_hash, role, employee_id, must_change_password)
      VALUES (?, ?, 'employee', ?, 1)
    `).run(username, hash, employee_id);

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('Error creating user:', err.message);
    res.status(500).json({ error: 'Failed to create user account' });
  }
});

// ── DELETE /api/auth/users/:id — Delete an employee account ─────────
router.delete('/users/:id', (req, res) => {
  if (req.session?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'admin') return res.status(400).json({ error: 'Cannot delete admin accounts' });

    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting user:', err.message);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// ── PUT /api/auth/users/:id/reset — Reset employee password to PIN ──
router.put('/users/:id/reset', async (req, res) => {
  if (req.session?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const hash = await bcrypt.hash(user.username, BCRYPT_ROUNDS);
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?')
      .run(hash, req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Error resetting password:', err.message);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

module.exports = router;
