/**
 * Meal Penalty Parser — Parses Cowork "Employee Time Detail" report
 * from PDF format and detects meal penalty violations.
 *
 * Uses `pdftotext -layout` (from poppler-utils) to extract column-aligned text,
 * then parses each employee block line-by-line.
 *
 * Meal Penalty Rule (Puerto Rico):
 *   A meal penalty occurs when an employee works MORE THAN 6 consecutive
 *   hours without taking any break (Unpaid punch).
 *
 *   - Any "Unpaid" row counts as a meal break and resets the clock
 *   - "Break (Conv To Paid)" counts as WORK time (not a break)
 *   - Gaps between shifts (clock out then clock in later) reset the clock
 *   - Exactly 6:00 does NOT trigger a penalty — must be > 6:00
 */

const { execFileSync } = require('child_process');
const fs = require('fs');

// ── Regex patterns ──────────────────────────────────────────────────
const DATE_RE = /(\d{2}\/\d{2}\/\d{4})/;
const EMPLOYEE_NAME_RE = /^[A-Z][A-Za-z\u00C0-\u024F' -]+,\s*[A-Za-z\u00C0-\u024F' ().-]+$/;
const TIME_RE = /(\d{1,2}:\d{2}\s*[ap])/gi;
const SKIP_RE = /Employee\s+(Totals|Name|Time)|All Employees|Page\s+\d|Punch types|clock-in time|Total Wages|La Rambla|Employee Time Detail|^Name\s|From\s+\w+day|^\s*$/i;
const FOOTER_TS_RE = /^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}\s*(AM|PM)/i;

/**
 * Parse a time string like "2:46 p" or "10:45 a" to minutes since midnight.
 * @param {string} timeStr - e.g. "2:46 p", "12:00 a"
 * @returns {number|null} Minutes since midnight, or null if unparseable
 */
function parseTimeToMinutes(timeStr) {
  if (!timeStr) return null;
  const m = timeStr.trim().match(/(\d{1,2}):(\d{2})\s*([ap])/i);
  if (!m) return null;
  let hours = parseInt(m[1], 10);
  const mins = parseInt(m[2], 10);
  const ampm = m[3].toLowerCase();
  if (ampm === 'p' && hours !== 12) hours += 12;
  if (ampm === 'a' && hours === 12) hours = 0;
  return hours * 60 + mins;
}

/**
 * Normalize time string: "2:46 p" → "2:46 PM"
 * @param {string} timeStr
 * @returns {string}
 */
function normalizeTime(timeStr) {
  if (!timeStr) return '';
  return timeStr.trim().replace(/\s*([ap])\s*$/i, (_, ap) => ' ' + ap.toUpperCase() + 'M');
}

/**
 * Parse a total time string like "4:08" to total minutes.
 * @param {string} str - e.g. "4:08", "0:31", "24:00"
 * @returns {number} Total minutes
 */
function parseTotalTime(str) {
  if (!str) return 0;
  const m = str.trim().match(/(\d+):(\d{2})/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/**
 * Format minutes to H:MM string.
 * @param {number} mins
 * @returns {string} e.g. "6:29"
 */
function formatMinutes(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

/**
 * Convert MM/DD/YYYY to YYYY-MM-DD.
 */
function formatDateISO(mdy) {
  const parts = mdy.split('/');
  if (parts.length === 3) return `${parts[2]}-${parts[0]}-${parts[1]}`;
  return mdy;
}

/**
 * Parse a natural-language date like "Feb 15, 2026" to YYYY-MM-DD.
 */
function parseNaturalDate(str) {
  const months = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
  };
  const m = str.trim().match(/(\w{3})\w*\s+(\d{1,2}),?\s+(\d{4})/i);
  if (!m) return null;
  const month = months[m[1].toLowerCase()];
  if (!month) return null;
  const day = String(parseInt(m[2], 10)).padStart(2, '0');
  return `${m[3]}-${month}-${day}`;
}

/**
 * Determine if a trimmed line is an employee name.
 */
function isEmployeeName(trimmed) {
  if (!/^[A-Z]/.test(trimmed)) return false;
  if (SKIP_RE.test(trimmed)) return false;
  if (/^\d{2}\/\d{2}\/\d{4}/.test(trimmed)) return false;
  if (/Working Time|Overtime|Wage\s+Rate|Regular|Unpaid/i.test(trimmed)) return false;
  if (EMPLOYEE_NAME_RE.test(trimmed)) return true;
  if (/^[A-Z][A-Za-z\u00C0-\u024F' -]+$/.test(trimmed) && trimmed.length < 60) return true;
  return false;
}

/**
 * Parse an Employee Time Detail PDF file and detect meal penalties.
 *
 * @param {string} filePath - Path to the PDF file
 * @returns {object} { penalties, dateRangeStart, dateRangeEnd, summary }
 */
function parseEmployeeTimeDetail(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error('File not found: ' + filePath);
  }

  // Extract text with layout preservation
  let text;
  try {
    text = execFileSync('pdftotext', ['-layout', filePath, '-'], {
      encoding: 'utf-8',
      timeout: 30000,
      maxBuffer: 50 * 1024 * 1024
    });
  } catch (err) {
    throw new Error(
      'Failed to extract PDF text. Ensure poppler-utils is installed. ' + err.message
    );
  }

  const lines = text.split('\n');

  // ── Extract date range from header ────────────────────────────────
  let dateRangeStart = null;
  let dateRangeEnd = null;
  const rangeMatch = text.match(/From\s+\w+,\s+(\w+\s+\d{1,2},?\s+\d{4})\s+through\s+\w+,\s+(\w+\s+\d{1,2},?\s+\d{4})/i);
  if (rangeMatch) {
    dateRangeStart = parseNaturalDate(rangeMatch[1]);
    dateRangeEnd = parseNaturalDate(rangeMatch[2]);
  }

  // ── Parse all punch rows ──────────────────────────────────────────
  let currentEmployee = null;
  const punches = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (SKIP_RE.test(trimmed)) continue;
    if (FOOTER_TS_RE.test(trimmed)) continue;

    // Detect employee name
    if (isEmployeeName(trimmed)) {
      currentEmployee = trimmed;
      continue;
    }

    if (!currentEmployee) continue;

    // Must contain a date
    const dateMatch = line.match(DATE_RE);
    if (!dateMatch) continue;

    const dateStr = dateMatch[1];
    const afterDate = line.substring(line.indexOf(dateStr) + dateStr.length);

    // Extract time in / time out
    const timeMatches = [...afterDate.matchAll(TIME_RE)];
    if (timeMatches.length < 2) continue;

    const timeIn = timeMatches[0][1];
    const timeOut = timeMatches[1][1];

    // Extract total time (H:MM after the second time token)
    const afterSecondTime = afterDate.substring(
      afterDate.indexOf(timeMatches[1][1]) + timeMatches[1][1].length
    );
    const totalTimeMatch = afterSecondTime.match(/(\d+:\d{2})/);
    if (!totalTimeMatch) continue;

    const totalMinutes = parseTotalTime(totalTimeMatch[1]);

    // Determine pay type
    let payType = 'Regular';
    if (/Break\s*\(Conv\s*To?\s*Paid\)/i.test(afterSecondTime)) {
      payType = 'Break (Conv To Paid)';
    } else if (/Unpaid/i.test(afterSecondTime)) {
      payType = 'Unpaid';
    }

    punches.push({
      employeeName: currentEmployee,
      date: formatDateISO(dateStr),
      timeIn,
      timeOut,
      timeInNorm: normalizeTime(timeIn),
      timeOutNorm: normalizeTime(timeOut),
      timeInMinutes: parseTimeToMinutes(timeIn),
      timeOutMinutes: parseTimeToMinutes(timeOut),
      totalMinutes,
      payType
    });
  }

  // ── Group by employee + date ──────────────────────────────────────
  const groups = {};
  for (const p of punches) {
    const key = `${p.employeeName}|${p.date}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(p);
  }

  // ── Detect meal penalties ─────────────────────────────────────────
  const penalties = [];

  for (const [key, rows] of Object.entries(groups)) {
    const [employeeName, date] = key.split('|');

    // Sort by time in (ascending)
    rows.sort((a, b) => (a.timeInMinutes || 0) - (b.timeInMinutes || 0));

    let consecutiveWorkMinutes = 0;
    let workPeriodStart = null;
    let workPeriodEnd = null;
    let lastTimeOut = null;

    for (const row of rows) {
      if (row.payType === 'Regular' || row.payType === 'Break (Conv To Paid)') {
        // Check for gap between shifts (clock out → gap → clock in later)
        if (lastTimeOut !== null && row.timeInMinutes !== lastTimeOut) {
          consecutiveWorkMinutes = 0;
          workPeriodStart = null;
          workPeriodEnd = null;
        }

        if (workPeriodStart === null) {
          workPeriodStart = row.timeInNorm;
        }
        consecutiveWorkMinutes += row.totalMinutes;
        workPeriodEnd = row.timeOutNorm;
        lastTimeOut = row.timeOutMinutes;

        // > 6 hours (strictly greater than 360 minutes)
        if (consecutiveWorkMinutes > 360) {
          penalties.push({
            employeeName,
            date,
            workPeriodStart,
            workPeriodEnd,
            consecutiveMinutes: consecutiveWorkMinutes,
            consecutiveFormatted: formatMinutes(consecutiveWorkMinutes),
            shiftDetail: `${workPeriodStart} - ${workPeriodEnd}`
          });
          // Reset to detect additional penalties same day
          consecutiveWorkMinutes = 0;
          workPeriodStart = null;
          workPeriodEnd = null;
          lastTimeOut = null;
        }
      } else if (row.payType === 'Unpaid') {
        // ANY Unpaid break resets the clock
        consecutiveWorkMinutes = 0;
        workPeriodStart = null;
        workPeriodEnd = null;
        lastTimeOut = row.timeOutMinutes;
      }
    }
  }

  // Sort by employee name then date
  penalties.sort((a, b) => {
    if (a.employeeName !== b.employeeName) return a.employeeName.localeCompare(b.employeeName);
    return a.date.localeCompare(b.date);
  });

  // ── Build summary ─────────────────────────────────────────────────
  const allEmployees = new Set(punches.map(p => p.employeeName));
  const employeesWithPenalties = new Set(penalties.map(p => p.employeeName));

  return {
    penalties,
    dateRangeStart,
    dateRangeEnd,
    summary: {
      totalEmployees: allEmployees.size,
      totalPenalties: penalties.length,
      employeesWithPenalties: employeesWithPenalties.size,
      employeesClean: allEmployees.size - employeesWithPenalties.size
    }
  };
}

module.exports = { parseEmployeeTimeDetail };
