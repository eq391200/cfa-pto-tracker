/**
 * Shared .env loader for standalone scripts (cron jobs, CLI tools).
 *
 * The Express server loads env via this same mechanism in index.js.
 * Cron scripts that run outside Express (backup, weekly-digest,
 * anniversary-check) call this once at startup.
 *
 * Usage:
 *   require('./utils/loadEnv');          // from server/
 *   require('../server/utils/loadEnv');  // from project root scripts
 */

const path = require('path');
const fs = require('fs');

const envPath = path.join(__dirname, '..', '..', '.env');

if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue; // skip blanks & comments
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (key) process.env[key] = value;
  }
}
