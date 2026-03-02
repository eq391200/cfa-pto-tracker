/**
 * Notification settings routes — admin preferences for email alerts.
 */

const express = require('express');
const { getDb } = require('../db');
const { sendTestEmail, isConfigured } = require('../services/emailService');

const router = express.Router();

// ── GET /api/notifications/settings — Retrieve all notification settings ─
router.get('/settings', (req, res) => {
  try {
    const db = getDb();
    const settings = db.prepare('SELECT * FROM notification_settings').all();
    const result = {};
    for (const s of settings) result[s.setting_key] = s.setting_value;
    result.email_configured = isConfigured();
    res.json(result);
  } catch (err) {
    console.error('Error loading notification settings:', err.message);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// ── PUT /api/notifications/settings — Update a single setting ───────
router.put('/settings', (req, res) => {
  try {
    const db = getDb();
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'Setting key required' });

    db.prepare(`
      INSERT INTO notification_settings (setting_key, setting_value)
      VALUES (?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET
        setting_value = excluded.setting_value,
        updated_at = CURRENT_TIMESTAMP
    `).run(key, value || '');

    res.json({ success: true });
  } catch (err) {
    console.error('Error saving notification setting:', err.message);
    res.status(500).json({ error: 'Failed to save setting' });
  }
});

// ── POST /api/notifications/test — Send a test email ────────────────
router.post('/test', async (req, res) => {
  try {
    const db = getDb();
    const adminEmail = db.prepare("SELECT setting_value FROM notification_settings WHERE setting_key = 'admin_email'").get();

    if (!adminEmail?.setting_value) {
      return res.status(400).json({ error: 'No admin email configured. Save your email first.' });
    }

    await sendTestEmail(adminEmail.setting_value);
    res.json({ success: true, message: `Test email sent to ${adminEmail.setting_value}` });
  } catch (err) {
    console.error('Error sending test email:', err.message);
    res.status(500).json({ error: 'Email failed: ' + err.message });
  }
});

module.exports = router;
