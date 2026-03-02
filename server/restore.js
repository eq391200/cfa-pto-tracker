#!/usr/bin/env node
/**
 * Database Restore Utility
 * Usage: node server/restore.js [backup-filename]
 *
 * Without arguments: lists available backups
 * With filename: restores that backup
 *
 * IMPORTANT: Stop the server before restoring!
 *   pm2 stop pto-tracker
 *   node server/restore.js pto-2025-06-15T02-00-00.db
 *   pm2 start pto-tracker
 */

const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'pto.db');
const BACKUP_DIR = path.join(__dirname, '..', 'data', 'backups');

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) {
    console.log('No backups directory found.');
    return;
  }

  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('pto-') && f.endsWith('.db'))
    .sort()
    .reverse();

  if (files.length === 0) {
    console.log('No backups found.');
    return;
  }

  console.log(`\nAvailable backups (${files.length}):\n`);
  console.log('  #   Filename                              Size       Date');
  console.log('  ─── ───────────────────────────────────── ────────── ──────────────────────');

  files.forEach((f, i) => {
    const stats = fs.statSync(path.join(BACKUP_DIR, f));
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    const date = stats.mtime.toISOString().replace('T', ' ').slice(0, 19);
    const num = String(i + 1).padStart(3);
    console.log(`  ${num} ${f.padEnd(41)} ${(sizeMB + ' MB').padStart(10)} ${date}`);
  });

  console.log('\nTo restore, run:');
  console.log(`  pm2 stop pto-tracker`);
  console.log(`  node server/restore.js <filename>`);
  console.log(`  pm2 start pto-tracker\n`);
}

function restore(filename) {
  const backupPath = path.join(BACKUP_DIR, filename);

  if (!fs.existsSync(backupPath)) {
    console.error(`Backup not found: ${filename}`);
    console.log(`Run 'node server/restore.js' to list available backups.`);
    process.exit(1);
  }

  // Safety: create a pre-restore backup
  const preRestoreName = `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.db`;
  const preRestorePath = path.join(BACKUP_DIR, preRestoreName);

  if (fs.existsSync(DB_PATH)) {
    console.log(`Creating pre-restore backup: ${preRestoreName}`);
    fs.copyFileSync(DB_PATH, preRestorePath);
  }

  console.log(`Restoring from: ${filename}`);
  fs.copyFileSync(backupPath, DB_PATH);

  // Also remove WAL/SHM files if they exist (stale journal)
  const walPath = DB_PATH + '-wal';
  const shmPath = DB_PATH + '-shm';
  if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
  if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);

  console.log('Restore complete!');
  console.log('Don\'t forget to restart the server: pm2 start pto-tracker');
}

// Main
const arg = process.argv[2];
if (arg) {
  restore(arg);
} else {
  listBackups();
}
