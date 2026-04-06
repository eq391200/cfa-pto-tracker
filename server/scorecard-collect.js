#!/usr/bin/env node
/**
 * Monthly Scorecard Auto-Collect
 *
 * Cron schedule: 0 8 1 * * (1st of every month at 8:00 AM)
 * Usage: node server/scorecard-collect.js [YYYY-MM]
 *
 * Automatically fetches public metrics (Google Reviews, Facebook/Instagram followers)
 * for the previous month and saves them to the scorecard. Sends a Slack summary
 * with collected values and reminders for metrics that need manual entry.
 */

require('./utils/loadEnv');

const { initDb } = require('./db');
const { runAutoCollect, formatSlackSummary } = require('./services/scorecardAutoCollect');

async function main() {
  initDb();

  // Allow manual month override via CLI argument
  const targetMonth = process.argv[2] || undefined;

  console.log('=== Scorecard Auto-Collect ===');
  console.log(`Date: ${new Date().toISOString()}`);
  if (targetMonth) console.log(`Target month (override): ${targetMonth}`);

  try {
    const result = await runAutoCollect(targetMonth);

    // Send Slack notification
    try {
      const { sendSlackToChannel, isBotConfigured } = require('./services/slackService');
      if (isBotConfigured() && process.env.SLACK_DIRECTORES_CHANNEL) {
        const msg = '📊 ' + formatSlackSummary(result);
        await sendSlackToChannel(process.env.SLACK_DIRECTORES_CHANNEL, msg);
        console.log('Slack notification sent');
      } else {
        console.log('Slack not configured — skipping notification');
      }
    } catch (slackErr) {
      console.error('Slack notification failed:', slackErr.message);
    }

    console.log('\nSummary:');
    console.log(`  Month: ${result.month}`);
    console.log(`  Collected: ${Object.keys(result.collected).length} metrics`);
    for (const [k, v] of Object.entries(result.collected)) {
      console.log(`    ${k}: ${v}`);
    }
    if (Object.keys(result.failed).length > 0) {
      console.log(`  Failed: ${Object.keys(result.failed).length} metrics`);
      for (const [k, v] of Object.entries(result.failed)) {
        console.log(`    ${k}: ${v}`);
      }
    }
    console.log(`  Saved to DB: ${result.saved}`);
    console.log('=== Done ===');
  } catch (err) {
    console.error('Auto-collect failed:', err);
    process.exit(1);
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
