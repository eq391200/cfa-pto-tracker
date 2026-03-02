/**
 * One-time script to mark employees as inactive based on the original Excel Activos sheet.
 * Employees listed in Activos/Oficial sheets are considered active; all others are inactive.
 */
const XLSX = require('xlsx');
const path = require('path');
const { initDb, getDb } = require('./db');

const WORKBOOK_PATH = path.join(__dirname, '..', '..', 'Vacation Workbook.xlsx');

initDb();
const db = getDb();

const wb = XLSX.readFile(WORKBOOK_PATH);

// Get active employee names from Activos sheet
let activosSheet = wb.SheetNames.includes('Activos') ? wb.Sheets['Activos'] : wb.Sheets[wb.SheetNames[2]];
const activosRows = XLSX.utils.sheet_to_json(activosSheet, { defval: '' });

const activeNames = new Set();
for (const row of activosRows) {
  const name = String(row['Nombre completo'] || '').trim();
  if (name) activeNames.add(name);
}

// Also check Oficial sheet
let oficialSheet = wb.SheetNames.includes('Oficial') ? wb.Sheets['Oficial'] : wb.Sheets[wb.SheetNames[1]];
const oficialRows = XLSX.utils.sheet_to_json(oficialSheet, { defval: '' });
for (const row of oficialRows) {
  const name = String(row['Nombre'] || '').trim();
  if (name) activeNames.add(name);
}

console.log('Active employees from Excel:', activeNames.size);

// Get all employees from DB
const allEmployees = db.prepare('SELECT id, full_name, status FROM employees').all();
console.log('Total employees in DB:', allEmployees.length);

let markedInactive = 0;
const inactiveList = [];

for (const emp of allEmployees) {
  if (!activeNames.has(emp.full_name)) {
    db.prepare("UPDATE employees SET status = 'inactive', flagged_for_review = 0 WHERE id = ?").run(emp.id);
    markedInactive++;
    inactiveList.push(emp.full_name);
  }
}

console.log('\nMarked', markedInactive, 'employees as inactive:');
inactiveList.forEach(n => console.log('  -', n));

const active = db.prepare("SELECT COUNT(*) as c FROM employees WHERE status = 'active'").get();
const inactive = db.prepare("SELECT COUNT(*) as c FROM employees WHERE status = 'inactive'").get();
const flagged = db.prepare("SELECT COUNT(*) as c FROM employees WHERE flagged_for_review = 1").get();
console.log('\nFinal counts: Active:', active.c, '| Inactive:', inactive.c, '| Flagged for review:', flagged.c);
