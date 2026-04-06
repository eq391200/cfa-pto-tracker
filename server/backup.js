#!/usr/bin/env node
/**
 * Database Backup Module
 *
 * Cron schedule: 0 2 * * * (daily at 2:00 AM)
 * Usage: node server/backup.js
 *
 * Uses better-sqlite3's backup() for safe, consistent snapshots.
 * Retains the last 30 backups and auto-cleans older files.
 * Also callable from the dashboard via the "Backup Now" button.
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const { MAX_BACKUPS } = require('./utils/constants');

const DB_PATH = path.join(__dirname, '..', 'data', 'pto.db');
const BACKUP_DIR = path.join(__dirname, '..', 'data', 'backups');
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const UPLOADS_BACKUP_DIR = path.join(BACKUP_DIR, 'uploads-latest');

/**
 * Create a timestamped backup of the database.
 * Uses better-sqlite3's native backup() for a consistent snapshot.
 *
 * Safe to call from Express route handlers — never calls process.exit().
 *
 * @returns {Promise<{ success: boolean, filename: string, sizeMB: string }>}
 * @throws {Error} On backup failure (caller handles)
 */
async function runBackup() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  if (!fs.existsSync(DB_PATH)) {
    throw new Error('Database not found at ' + DB_PATH);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupName = `pto-${timestamp}.db`;
  const backupPath = path.join(BACKUP_DIR, backupName);

  console.log(`[Backup] Starting: ${backupName}`);

  const db = new Database(DB_PATH, { readonly: true });
  try {
    await db.backup(backupPath);
  } catch (err) {
    db.close();
    throw new Error('Backup failed: ' + err.message);
  }
  db.close();

  const sizeMB = (fs.statSync(backupPath).size / (1024 * 1024)).toFixed(2);
  console.log(`[Backup] Complete: ${backupName} (${sizeMB} MB)`);

  // Verify backup integrity
  const integrityOk = verifyBackup(backupPath);
  if (!integrityOk) {
    console.error(`[Backup] INTEGRITY CHECK FAILED for ${backupName}`);
  }

  // Backup uploaded files (apprenticeship docs, invoices, etc.)
  backupUploads();

  recordBackupTime();
  cleanOldBackups();

  return { success: true, filename: backupName, sizeMB, integrityOk };
}

/**
 * Verify backup integrity by opening the backup DB and running PRAGMA integrity_check.
 * @param {string} backupPath - Path to the backup file
 * @returns {boolean} true if integrity check passes
 */
function verifyBackup(backupPath) {
  try {
    const testDb = new Database(backupPath, { readonly: true });
    const result = testDb.pragma('integrity_check');
    const ok = result && result[0] && result[0].integrity_check === 'ok';
    // Also verify core tables exist
    const tables = testDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
    const required = ['employees', 'users', 'time_off_requests'];
    const hasAll = required.every(t => tables.includes(t));
    testDb.close();
    if (!ok) console.error('[Backup] Integrity check returned:', result);
    if (!hasAll) console.error('[Backup] Missing required tables in backup');
    return ok && hasAll;
  } catch (err) {
    console.error('[Backup] Verification failed:', err.message);
    return false;
  }
}

/**
 * Backup the uploads directory (apprenticeship documents, invoices, signatures).
 * Uses rsync for efficient incremental copies.
 */
function backupUploads() {
  try {
    if (!fs.existsSync(UPLOADS_DIR)) return;
    fs.mkdirSync(UPLOADS_BACKUP_DIR, { recursive: true });
    try {
      // rsync for efficient incremental backup
      execFileSync('rsync', ['-a', '--delete', UPLOADS_DIR + '/', UPLOADS_BACKUP_DIR + '/'], { timeout: 60000 });
      console.log('[Backup] Uploads backed up successfully');
    } catch (e) {
      // Fallback to cp if rsync not available
      execFileSync('cp', ['-r', UPLOADS_DIR + '/', UPLOADS_BACKUP_DIR + '/'], { timeout: 60000 });
      console.log('[Backup] Uploads backed up (cp fallback)');
    }
  } catch (err) {
    console.warn('[Backup] Uploads backup failed:', err.message);
  }
}

/** Record the backup timestamp in notification_settings (non-fatal on failure). */
function recordBackupTime() {
  try {
    const { getDb } = require('./db');
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO notification_settings (setting_key, setting_value, updated_at)
      VALUES ('last_backup', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(setting_key) DO UPDATE SET setting_value = ?, updated_at = CURRENT_TIMESTAMP
    `).run(now, now);
  } catch (err) {
    console.warn('[Backup] Could not record timestamp:', err.message);
  }
}

/** Remove backups beyond the retention limit. */
function cleanOldBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('pto-') && f.endsWith('.db'))
      .sort()
      .reverse();

    if (files.length > MAX_BACKUPS) {
      const toDelete = files.slice(MAX_BACKUPS);
      for (const f of toDelete) {
        fs.unlinkSync(path.join(BACKUP_DIR, f));
      }
      console.log(`[Backup] Cleaned ${toDelete.length} old backup(s). Keeping ${MAX_BACKUPS}.`);
    }
  } catch (err) {
    console.warn('[Backup] Cleanup failed:', err.message);
  }
}

/** Get info about existing backups (for dashboard display). */
function getBackupInfo() {
  if (!fs.existsSync(BACKUP_DIR)) {
    return { count: 0, totalSize: 0, files: [] };
  }

  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('pto-') && f.endsWith('.db'))
    .sort()
    .reverse();

  let totalSize = 0;
  const fileList = files.map(f => {
    const stats = fs.statSync(path.join(BACKUP_DIR, f));
    totalSize += stats.size;
    return { name: f, size: stats.size, date: stats.mtime };
  });

  return { count: files.length, totalSize, files: fileList };
}

// Run if called directly (cron) — only exit here
if (require.main === module) {
  runBackup()
    .then(result => {
      console.log(`[Backup] Cron backup done: ${result.filename}`);
      process.exit(0);
    })
    .catch(err => {
      console.error('[Backup] Cron backup failed:', err.message);
      process.exit(1);
    });
}

module.exports = { runBackup, getBackupInfo, BACKUP_DIR };
