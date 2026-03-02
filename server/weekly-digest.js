#!/usr/bin/env node
/**
 * Weekly PTO Digest Email
 *
 * Cron schedule: 0 9 * * 1 (every Monday at 9:00 AM)
 * Usage: node server/weekly-digest.js
 *
 * Sends a summary email to the admin with pending request counts,
 * active employee stats, and flagged employee alerts.
 * Respects the 'weekly_digest' toggle in notification_settings.
 */

require('./utils/loadEnv');

const { getDb, initDb } = require('./db');
const { sendWeeklyDigest, isConfigured } = require('./services/emailService');

async function run() {
  if (!isConfigured()) {
    console.log('Email not configured. Skipping weekly digest.');
    process.exit(0);
  }

  initDb();
  const db = getDb();

  // Check if weekly digest is enabled
  const digestSetting = db.prepare("SELECT setting_value FROM notification_settings WHERE setting_key = 'weekly_digest'").get();
  if (digestSetting?.setting_value === 'false') {
    console.log('Weekly digest is disabled. Skipping.');
    process.exit(0);
  }

  // Get admin email
  const adminEmailSetting = db.prepare("SELECT setting_value FROM notification_settings WHERE setting_key = 'admin_email'").get();
  if (!adminEmailSetting?.setting_value) {
    console.log('No admin email configured. Skipping weekly digest.');
    process.exit(0);
  }

  const adminEmail = adminEmailSetting.setting_value;

  // Gather stats
  const totalActive = db.prepare("SELECT COUNT(*) AS count FROM employees WHERE status = 'active'").get().count;
  const flaggedCount = db.prepare("SELECT COUNT(*) AS count FROM employees WHERE flagged_for_review = 1 AND status = 'active'").get().count;
  const pendingCount = db.prepare("SELECT COUNT(*) AS count FROM time_off_requests WHERE status = 'pending'").get().count;

  const pendingRequests = db.prepare(`
    SELECT r.*, e.first_name, e.last_name
    FROM time_off_requests r
    JOIN employees e ON r.employee_id = e.id
    WHERE r.status = 'pending'
    ORDER BY r.created_at DESC
  `).all();

  const stats = { totalActive, flaggedCount, pendingRequests: pendingCount };

  try {
    await sendWeeklyDigest(adminEmail, pendingRequests, stats);
    console.log(`Weekly digest sent to ${adminEmail}`);
  } catch (err) {
    console.error('Failed to send weekly digest:', err.message);
    process.exit(1);
  }
}

run();
