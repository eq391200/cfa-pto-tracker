/**
 * Excel/CSV Parser — Parses CFA wage export files into structured data.
 *
 * Supports two formats (auto-detected from column headers):
 *
 * Legacy format (wage export):
 *   FIRST_NAME, LAST_NAME, CAL_DAY, PUNCH_TYPE, START_TIME, END_TIME,
 *   PUNCH_LENGTH_AS_DECIMAL, ...
 *
 * New format (TP_PUNCHES):
 *   EMPLOYEE, PUNCHTYPE, TIMEIN, TIMEOUT, TIMEPAID, REMARKS, LAST_UPDATE_DATE
 *   - EMPLOYEE is "LastName, FirstName" (e.g. "Alfonzo Muniz, Kevin Javier")
 *   - Only "Regular" PUNCHTYPE rows count toward hours
 *   - Hours calculated from TIMEIN/TIMEOUT timestamps
 *
 * Returns:
 *   - employees: Map<fullName, { firstName, lastName }>
 *   - monthlyHours: Map<fullName, Map<"YYYY-MM", totalHours>>
 *   - earliestDate: Map<fullName, Date> (first clock-in per employee)
 */

const XLSX = require('xlsx');

/**
 * Parse a wage export file.
 *
 * @param {string} filePath - Absolute path to .xlsx or .csv file
 * @returns {{ employees: Map, monthlyHours: Map, earliestDate: Map, totalRows: number }}
 */
function parseWageExport(filePath) {
  // First pass: detect format from headers
  const wb = XLSX.readFile(filePath);
  const sheetName = wb.SheetNames[0];
  const peek = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });

  if (!peek.length) throw new Error('File is empty or has no data rows');

  const headers = Object.keys(peek[0]);
  const isNewFormat = headers.includes('EMPLOYEE') && headers.includes('TIMEIN');

  if (isNewFormat) {
    // Re-read with raw:true so XLSX doesn't convert timestamp strings to serials
    const wbRaw = XLSX.readFile(filePath, { raw: true });
    const rows = XLSX.utils.sheet_to_json(wbRaw.Sheets[wbRaw.SheetNames[0]], { defval: '' });
    return parseNewFormat(rows);
  }
  return parseLegacyFormat(peek);
}

/**
 * Parse the new TP_PUNCHES format.
 * Columns: EMPLOYEE, PUNCHTYPE, TIMEIN, TIMEOUT, TIMEPAID, REMARKS, LAST_UPDATE_DATE
 */
function parseNewFormat(rows) {
  const employees = new Map();
  const monthlyHours = new Map();
  const earliestDate = new Map();

  for (const row of rows) {
    // Only count Regular punches toward hours
    const punchType = String(row['PUNCHTYPE'] || '').trim();
    if (punchType !== 'Regular') continue;

    const rawName = String(row['EMPLOYEE'] || '').trim();
    if (!rawName) continue;

    // Parse "LastName, FirstName MiddleName" format
    const commaIdx = rawName.indexOf(',');
    let firstName, lastName;
    if (commaIdx !== -1) {
      // Title-case each word of last name for consistent DB matching (e.g. "de" -> "De")
      lastName = rawName.substring(0, commaIdx).trim()
        .split(/\s+/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      const firstPart = rawName.substring(commaIdx + 1).trim();
      // Use only the first word of firstName to match DB convention
      // (strip middle names, initials, and nicknames like "(Ale)")
      firstName = firstPart.split(/\s+/)[0].replace(/\(.*\)/, '');
    } else {
      firstName = rawName;
      lastName = '';
    }
    const fullName = firstName + ' ' + lastName;

    // Parse timestamps
    const timeIn = String(row['TIMEIN'] || '').trim();
    const timeOut = String(row['TIMEOUT'] || '').trim();
    if (!timeIn || !timeOut) continue;

    const dateIn = new Date(timeIn);
    const dateOut = new Date(timeOut);
    if (isNaN(dateIn.getTime()) || isNaN(dateOut.getTime())) continue;

    // Calculate hours from timestamps
    const diffMs = dateOut.getTime() - dateIn.getTime();
    if (diffMs <= 0) continue;
    const hours = diffMs / (1000 * 60 * 60);

    const yearMonth = `${dateIn.getFullYear()}-${String(dateIn.getMonth() + 1).padStart(2, '0')}`;

    // Track employee
    if (!employees.has(fullName)) {
      employees.set(fullName, { firstName, lastName });
    }

    // Accumulate monthly hours
    if (!monthlyHours.has(fullName)) {
      monthlyHours.set(fullName, new Map());
    }
    const empMonths = monthlyHours.get(fullName);
    empMonths.set(yearMonth, (empMonths.get(yearMonth) || 0) + hours);

    // Track earliest date per employee
    if (!earliestDate.has(fullName) || dateIn < earliestDate.get(fullName)) {
      earliestDate.set(fullName, dateIn);
    }
  }

  return { employees, monthlyHours, earliestDate, totalRows: rows.length };
}

/**
 * Parse the legacy wage export format.
 * Columns: FIRST_NAME, LAST_NAME, CAL_DAY, PUNCH_LENGTH_AS_DECIMAL, ...
 */
function parseLegacyFormat(rows) {
  const employees = new Map();
  const monthlyHours = new Map();
  const earliestDate = new Map();

  for (const row of rows) {
    const firstName = String(row['FIRST_NAME'] || '').trim();
    const lastName = String(row['LAST_NAME'] || '').trim();
    if (!firstName) continue;

    const fullName = firstName + ' ' + lastName;
    const calDay = String(row['CAL_DAY'] || '').trim();
    const punchDecimal = parseFloat(row['PUNCH_LENGTH_AS_DECIMAL']) || 0;

    if (!calDay) continue;

    // Parse date — handles both ISO strings and Excel serial numbers
    let date;
    if (calDay.includes('-')) {
      date = new Date(calDay);
    } else {
      const serial = parseFloat(calDay);
      if (!isNaN(serial)) {
        date = excelSerialToDate(serial);
      }
    }
    if (!date || isNaN(date.getTime())) continue;

    const yearMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

    // Track employee
    if (!employees.has(fullName)) {
      employees.set(fullName, { firstName, lastName });
    }

    // Accumulate monthly hours
    if (!monthlyHours.has(fullName)) {
      monthlyHours.set(fullName, new Map());
    }
    const empMonths = monthlyHours.get(fullName);
    empMonths.set(yearMonth, (empMonths.get(yearMonth) || 0) + punchDecimal);

    // Track earliest date per employee
    if (!earliestDate.has(fullName) || date < earliestDate.get(fullName)) {
      earliestDate.set(fullName, date);
    }
  }

  return { employees, monthlyHours, earliestDate, totalRows: rows.length };
}

/**
 * Convert an Excel serial date number to a JS Date.
 * Excel epoch: December 30, 1899.
 */
function excelSerialToDate(serial) {
  const epoch = new Date(1899, 11, 30);
  return new Date(epoch.getTime() + serial * 86400000);
}

module.exports = { parseWageExport };
