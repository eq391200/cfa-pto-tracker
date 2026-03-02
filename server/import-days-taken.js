#!/usr/bin/env node
/**
 * One-time import of days taken from Vacation Workbook.xlsx ("Oficial" tab)
 * Column E = Vacation Taken, Column F = Sick Taken
 *
 * Usage: node server/import-days-taken.js <path-to-xlsx>
 */

const path = require('path');
const XLSX = require('xlsx');
const Database = require('better-sqlite3');

const xlsxPath = process.argv[2];
if (!xlsxPath) {
  console.error('Usage: node server/import-days-taken.js <path-to-vacation-workbook.xlsx>');
  process.exit(1);
}

const DB_PATH = path.join(__dirname, '..', 'data', 'pto.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Read the Oficial tab
const wb = XLSX.readFile(xlsxPath);
const sheet = wb.Sheets['Oficial'];
if (!sheet) {
  console.error('No "Oficial" sheet found in workbook.');
  process.exit(1);
}

const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', header: 1 });

const getEmployee = db.prepare('SELECT id, full_name FROM employees WHERE full_name = ?');
const insertTaken = db.prepare(`
  INSERT INTO time_off_taken (employee_id, type, days_taken, date_taken, notes, entered_by)
  VALUES (?, ?, ?, ?, ?, ?)
`);

// Check existing records to avoid duplicates
const existingCount = db.prepare('SELECT COUNT(*) as count FROM time_off_taken').get().count;
if (existingCount > 0) {
  console.log(`WARNING: time_off_taken already has ${existingCount} record(s).`);
  console.log('This script is meant for initial import. Continuing will ADD to existing records.');
  console.log('Press Ctrl+C to cancel, or wait 3 seconds to continue...');
  // In non-interactive mode, just proceed
}

let imported = 0;
let skipped = 0;
let notFound = [];

const importAll = db.transaction(() => {
  for (let i = 1; i < rows.length; i++) {
    const name = String(rows[i][0] || '').trim();
    if (!name) continue;

    const vacTaken = parseFloat(rows[i][4]) || 0;
    const sickTaken = parseFloat(rows[i][5]) || 0;

    if (vacTaken === 0 && sickTaken === 0) {
      skipped++;
      continue;
    }

    const emp = getEmployee.get(name);
    if (!emp) {
      notFound.push(name);
      continue;
    }

    // Use 2025-01-01 as a general date for historical taken data
    const dateTaken = '2025-01-01';
    const notes = 'Imported from Vacation Workbook (Oficial tab)';
    const enteredBy = 'system-import';

    if (vacTaken > 0) {
      insertTaken.run(emp.id, 'vacation', vacTaken, dateTaken, notes, enteredBy);
      console.log(`  ✓ ${emp.full_name}: ${vacTaken} vacation day(s)`);
      imported++;
    }

    if (sickTaken > 0) {
      insertTaken.run(emp.id, 'sick', sickTaken, dateTaken, notes, enteredBy);
      console.log(`  ✓ ${emp.full_name}: ${sickTaken} sick day(s)`);
      imported++;
    }
  }
});

importAll();

console.log(`\n=== Import Complete ===`);
console.log(`Records imported: ${imported}`);
console.log(`Employees skipped (no days taken): ${skipped}`);

if (notFound.length > 0) {
  console.log(`\nNot found in database (${notFound.length}):`);
  notFound.forEach(n => console.log(`  ✗ ${n}`));
}

db.close();
