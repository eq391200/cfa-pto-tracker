#!/usr/bin/env node
/**
 * Monthly Employee Anniversary Check
 *
 * Cron schedule: 0 8 1 * * (1st of every month at 8:00 AM)
 * Usage: node server/anniversary-check.js
 *
 * Checks for employees reaching a milestone anniversary THIS month
 * and sends a single Slack summary DM to the admin via webhook.
 * Tracks sent notifications in milestone_notifications to prevent duplicates.
 */

require('./utils/loadEnv');

const { getDb, initDb } = require('./db');
const { sendSlackMessage, isConfigured } = require('./services/slackService');
const { MONTH_NAMES_FULL, formatDateDisplay } = require('./utils/constants');

// Milestones to check (in years)
const MILESTONES = [
  { years: 1,  key: '1_year',  label: '1-year' },
  { years: 5,  key: '5_year',  label: '5-year' },
  { years: 15, key: '15_year', label: '15-year' }
];

async function run() {
  if (!isConfigured()) {
    console.log('Slack webhook not configured. Skipping anniversary check.');
    process.exit(0);
  }

  initDb();
  const db = getDb();

  const today = new Date();
  const currentMonth = today.getMonth();       // 0-based
  const currentYear = today.getFullYear();
  const monthLabel = MONTH_NAMES_FULL[currentMonth] + ' ' + currentYear;

  const hits = [];

  for (const milestone of MILESTONES) {
    // Find active employees not yet notified for this milestone
    const candidates = db.prepare(`
      SELECT e.id, e.first_name, e.last_name, e.full_name, e.first_clock_in
      FROM employees e
      WHERE e.status = 'active'
        AND e.first_clock_in IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM milestone_notifications mn
          WHERE mn.employee_id = e.id AND mn.milestone = ?
        )
    `).all(milestone.key);

    for (const emp of candidates) {
      const hireDate = new Date(emp.first_clock_in + 'T00:00:00');
      const anniversaryDate = new Date(
        hireDate.getFullYear() + milestone.years,
        hireDate.getMonth(),
        hireDate.getDate()
      );

      // Check if the anniversary falls in the current month & year
      if (anniversaryDate.getMonth() === currentMonth && anniversaryDate.getFullYear() === currentYear) {
        hits.push({ emp, milestone, anniversaryDay: anniversaryDate.getDate() });

        // Record to prevent re-notification
        db.prepare('INSERT OR IGNORE INTO milestone_notifications (employee_id, milestone) VALUES (?, ?)')
          .run(emp.id, milestone.key);
        console.log(`✓ Recorded ${milestone.label} milestone for ${emp.full_name}`);
      }
    }
  }

  if (hits.length === 0) {
    console.log(`No upcoming anniversaries for ${monthLabel}.`);
    return;
  }

  // Build a single summary message
  const lines = hits.map(h =>
    `• ${h.emp.full_name} — ${h.milestone.label} mark on ${MONTH_NAMES_FULL[currentMonth]} ${h.anniversaryDay} ` +
    `(hired ${formatDateDisplay(h.emp.first_clock_in)})`
  );

  const message =
    `📅 Anniversary Report — ${monthLabel}\n` +
    `${hits.length} employee${hits.length > 1 ? 's' : ''} reaching a milestone this month:\n` +
    lines.join('\n');

  try {
    await sendSlackMessage(message);
    console.log(`Sent monthly anniversary summary (${hits.length} milestone(s)) for ${monthLabel}.`);
  } catch (err) {
    console.error('Failed to send Slack message:', err.message);
    process.exit(1);
  }
}

run();
