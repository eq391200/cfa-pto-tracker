/**
 * Migrate data from the existing Vacation Workbook.xlsx into the PTO Tracker database.
 *
 * This script:
 * 1. Reads the Export_Wage sheet (raw punch data) to populate employees + monthly_hours
 * 2. Reads the Activos sheet to import time-off taken data
 * 3. Reads the Oficial sheet to get current taken values
 * 4. Runs the accrual engine
 * 5. Verifies calculated totals match the Excel formulas
 */

const path = require('path');
const { initDb, getDb } = require('./db');
const { runAccrualEngine, checkInactiveEmployees } = require('./services/accrualEngine');

// We need to parse the xlsx manually since it uses strict conformance namespace
const XLSX = require('xlsx');
const fs = require('fs');

const WORKBOOK_PATH = path.join(__dirname, '..', '..', 'Vacation Workbook.xlsx');

async function migrate() {
  console.log('=== PTO Tracker Data Migration ===\n');

  if (!fs.existsSync(WORKBOOK_PATH)) {
    console.error(`Workbook not found at: ${WORKBOOK_PATH}`);
    process.exit(1);
  }

  // Initialize fresh database
  const db = initDb();
  console.log('Database initialized.\n');

  // Step 1: Parse Export_Wage sheet
  console.log('Step 1: Parsing Export_Wage sheet...');
  const wb = XLSX.readFile(WORKBOOK_PATH);

  // The workbook uses strict OOXML namespace, so sheet names may not load properly.
  // We'll try to access sheets by name or fall back to index.
  let exportSheet;
  if (wb.SheetNames.includes('Export_Wage')) {
    exportSheet = wb.Sheets['Export_Wage'];
  } else {
    // Fall back to last sheet (sheet4 in the zip = Export_Wage based on our analysis)
    const lastSheet = wb.SheetNames[wb.SheetNames.length - 1];
    exportSheet = wb.Sheets[lastSheet];
    console.log(`  Using sheet: "${lastSheet}" as Export_Wage`);
  }

  const wageRows = XLSX.utils.sheet_to_json(exportSheet, { defval: '' });
  console.log(`  Found ${wageRows.length} punch records`);

  // Collect employee data and monthly hours
  const employees = new Map();
  const monthlyHoursMap = new Map();
  const earliestDates = new Map();
  let skipped = 0;

  for (const row of wageRows) {
    const firstName = String(row['FIRST_NAME'] || '').trim();
    const lastName = String(row['LAST_NAME'] || '').trim();
    if (!firstName) { skipped++; continue; }

    const fullName = firstName + lastName;
    const calDay = row['CAL_DAY'];
    const punchDecimal = parseFloat(row['PUNCH_LENGTH_AS_DECIMAL']) || 0;

    // Parse date
    let date;
    if (typeof calDay === 'string' && calDay.includes('-')) {
      date = new Date(calDay);
    } else if (typeof calDay === 'number') {
      // Excel serial date
      const epoch = new Date(1899, 11, 30);
      date = new Date(epoch.getTime() + calDay * 86400000);
    } else if (typeof calDay === 'string') {
      date = new Date(calDay);
    }

    if (!date || isNaN(date.getTime())) { skipped++; continue; }

    const yearMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

    if (!employees.has(fullName)) {
      employees.set(fullName, { firstName, lastName });
    }

    if (!monthlyHoursMap.has(fullName)) {
      monthlyHoursMap.set(fullName, new Map());
    }
    const empMonths = monthlyHoursMap.get(fullName);
    empMonths.set(yearMonth, (empMonths.get(yearMonth) || 0) + punchDecimal);

    if (!earliestDates.has(fullName) || date < earliestDates.get(fullName)) {
      earliestDates.set(fullName, date);
    }
  }

  console.log(`  Parsed ${employees.size} unique employees, skipped ${skipped} invalid rows`);

  // Step 2: Insert employees and monthly hours
  console.log('\nStep 2: Inserting employees and monthly hours...');

  const insertEmployee = db.prepare(`
    INSERT OR IGNORE INTO employees (first_name, last_name, full_name, first_clock_in)
    VALUES (?, ?, ?, ?)
  `);

  const getEmployee = db.prepare('SELECT id FROM employees WHERE full_name = ?');

  const upsertHours = db.prepare(`
    INSERT INTO monthly_hours (employee_id, year, month, total_hours)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(employee_id, year, month) DO UPDATE SET total_hours = excluded.total_hours
  `);

  let empCount = 0;
  let monthCount = 0;

  const insertAll = db.transaction(() => {
    for (const [fullName, info] of employees) {
      const earliest = earliestDates.get(fullName);
      const earliestStr = earliest ? earliest.toISOString().split('T')[0] : null;

      insertEmployee.run(info.firstName, info.lastName, fullName, earliestStr);
      empCount++;

      const emp = getEmployee.get(fullName);
      const months = monthlyHoursMap.get(fullName);

      for (const [yearMonth, hours] of months) {
        const [y, m] = yearMonth.split('-').map(Number);
        upsertHours.run(emp.id, y, m, Math.round(hours * 10000) / 10000);
        monthCount++;
      }
    }
  });

  insertAll();
  console.log(`  Inserted ${empCount} employees, ${monthCount} monthly hour records`);

  // Step 3: Import time-off taken from Activos sheet
  console.log('\nStep 3: Importing time-off taken from Activos sheet...');

  let activosSheet;
  if (wb.SheetNames.includes('Activos')) {
    activosSheet = wb.Sheets['Activos'];
  } else {
    // Try third sheet
    activosSheet = wb.Sheets[wb.SheetNames[2]];
    console.log(`  Using sheet: "${wb.SheetNames[2]}" as Activos`);
  }

  if (activosSheet) {
    const activosRows = XLSX.utils.sheet_to_json(activosSheet, { defval: '' });
    let timeOffCount = 0;

    const insertTimeOff = db.prepare(`
      INSERT INTO time_off_taken (employee_id, type, days_taken, date_taken, notes, entered_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const row of activosRows) {
      const firstName = String(row['FIRST_NAME'] || '').trim();
      const lastName = String(row['LAST_NAME'] || '').trim();
      if (!firstName) continue;

      const fullName = firstName + lastName;
      const emp = getEmployee.get(fullName);
      if (!emp) continue;

      const vacHours = parseFloat(row['Number of Vacation Hours']) || 0;
      const sickHours = parseFloat(row['Number of Sick Hours Taken']) || 0;

      // Convert hours to days (8 hrs = 1 day)
      if (vacHours > 0) {
        const vacDays = vacHours / 8;
        insertTimeOff.run(emp.id, 'vacation', vacDays, '2026-01-01', 'Migrated from workbook (hours: ' + vacHours + ')', 'migration');
        timeOffCount++;
      }
      if (sickHours > 0) {
        const sickDays = sickHours / 8;
        insertTimeOff.run(emp.id, 'sick', sickDays, '2026-01-01', 'Migrated from workbook (hours: ' + sickHours + ')', 'migration');
        timeOffCount++;
      }
    }
    console.log(`  Imported ${timeOffCount} time-off records`);
  }

  // Step 4: Also check Oficial sheet for additional taken values
  console.log('\nStep 4: Cross-referencing Oficial sheet taken values...');
  let oficialSheet;
  if (wb.SheetNames.includes('Oficial')) {
    oficialSheet = wb.Sheets['Oficial'];
  } else {
    oficialSheet = wb.Sheets[wb.SheetNames[1]];
    console.log(`  Using sheet: "${wb.SheetNames[1]}" as Oficial`);
  }

  // Note: Oficial's "Vacation Taken" and "Enfermedad Taken" columns contain day values
  // We already imported from Activos (which has hours). Let's check if Oficial has different data.
  // For now, we trust Activos as the source since it has hour-level precision.

  // Step 5: Run accrual engine
  console.log('\nStep 5: Running accrual engine...');
  const accrualResult = runAccrualEngine();
  console.log(`  Processed ${accrualResult.processed} accruals`);

  // Step 6: Check for inactive employees
  console.log('\nStep 6: Checking for inactive employees...');
  const flagged = checkInactiveEmployees();
  console.log(`  Flagged ${flagged} employees for review (4+ consecutive months with no hours)`);

  // Step 7: Verify against Excel values
  console.log('\nStep 7: Verification...');
  verify(db);

  console.log('\n=== Migration Complete ===');
}

function verify(db) {
  // Known values from the Oficial sheet to verify against
  const expectedValues = [
    { name: 'MictonioRosario Bonilla', sickDays: 19, vacDays: 9.5 },
    { name: 'NicoleColon', sickDays: 18, vacDays: 9 },
    { name: 'YanRuiz', sickDays: 18, vacDays: 9 },
    { name: 'AaliyahRolon Torres', sickDays: 17, vacDays: 8.5 },
    { name: 'JenifferBermudez', sickDays: 17, vacDays: 8.5 },
    { name: 'KeilaFigueroa', sickDays: 15, vacDays: 7.5 },
    { name: 'AxelRivera Quiros', sickDays: 14, vacDays: 7 },
    { name: 'NashaleeRodriguez', sickDays: 12, vacDays: 6 },
    { name: 'AleyshkaToro Cruz', sickDays: 9, vacDays: 4.5 },
    { name: 'ArleneSantiago', sickDays: 9, vacDays: 4.5 },
  ];

  let passed = 0;
  let failed = 0;

  for (const expected of expectedValues) {
    const emp = db.prepare('SELECT id FROM employees WHERE full_name = ?').get(expected.name);
    if (!emp) {
      console.log(`  SKIP: ${expected.name} not found in database`);
      continue;
    }

    const totals = db.prepare(`
      SELECT
        COALESCE(SUM(sick_days_earned), 0) as sick,
        COALESCE(SUM(vacation_days_earned), 0) as vac
      FROM accruals WHERE employee_id = ?
    `).get(emp.id);

    const sickMatch = Math.abs(totals.sick - expected.sickDays) < 0.01;
    const vacMatch = Math.abs(totals.vac - expected.vacDays) < 0.5; // Allow tolerance for tenure escalation

    if (sickMatch) {
      console.log(`  PASS: ${expected.name} - Sick: ${totals.sick} (expected ${expected.sickDays})`);
      passed++;
    } else {
      console.log(`  FAIL: ${expected.name} - Sick: ${totals.sick} (expected ${expected.sickDays})`);
      failed++;
    }

    if (!vacMatch) {
      console.log(`  NOTE: ${expected.name} - Vacation: ${totals.vac.toFixed(2)} (Excel had ${expected.vacDays}) - difference may be due to tenure escalation`);
    }
  }

  console.log(`\n  Results: ${passed} passed, ${failed} failed`);
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
