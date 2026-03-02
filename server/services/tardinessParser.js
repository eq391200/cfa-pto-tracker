/**
 * Tardiness Report Parser — Parses Cowork "Actual Vs. Scheduled Punch Variance Report"
 * from PDF format into structured tardiness data.
 *
 * Uses `pdftotext -layout` (from poppler-utils) to extract column-aligned text,
 * then parses each employee block line-by-line.
 *
 * Classification rules (clock-in variance only):
 *   INFRACTION: >= 10 minutes late
 *   FLAG:       > 5 and < 10 minutes late
 *   ABSENCE:    No actual clock-in recorded (scheduled only)
 *   OK:         <= 5 minutes late, or early
 */

const { execFileSync } = require('child_process');
const fs = require('fs');

// ── Regex patterns ──────────────────────────────────────────────────
const DATE_RE = /\b(\d{2}\/\d{2}\/\d{4})\b/;
const TIME_RE = /\d{1,2}:\d{2}\s*[AP]M/g;
const VARIANCE_RE = /\((\d+:\d{2})\)|(?<!\$)(\d+:\d{2})(?!\s*[AP]M)|(?<=\s)(--)/g;
const DOLLAR_RE = /\(\$[\d,.]+\)|\$[\d,.]+/g;
const EMPLOYEE_NAME_RE = /^[A-Z][A-Za-z\u00C0-\u024F' -]+,\s*[A-Za-z\u00C0-\u024F' ().-]+$/;
const PAGE_RE = /Page\s+\d+\s+of\s+\d+/;
const HEADER_RE = /Employee\s+Name|Actual\s+Vs\.|Actual\s+Time|Scheduled\s+Time|Clock-In|Clock-Out|La Rambla|^Variance|^Overage|^Shortage/;
const TOTALS_RE = /Overage Total:|Shortage Total:|Total Time:/;

/**
 * Parse a PDF punch variance report file.
 * @param {string} filePath - Path to the PDF file
 * @returns {object} Parsed data with records, pay period, summary
 */
function parsePunchVarianceReport(filePath) {
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
      'Failed to extract PDF text. Ensure poppler-utils is installed (apt-get install poppler-utils). ' +
      err.message
    );
  }

  const lines = text.split('\n');
  const records = [];
  let currentEmployee = null;
  let pendingRow = null; // Holds first line of a 2-line shift row

  // Extract pay period from header (line like "02/01/2026 - 02/25/2026")
  let payPeriodStart = null;
  let payPeriodEnd = null;
  const ppMatch = text.match(/(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{2}\/\d{4})/);
  if (ppMatch) {
    payPeriodStart = formatDate(ppMatch[1]);
    payPeriodEnd = formatDate(ppMatch[2]);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines, page markers, headers, totals
    if (!trimmed) continue;
    if (PAGE_RE.test(trimmed)) continue;
    if (HEADER_RE.test(trimmed)) continue;
    if (TOTALS_RE.test(trimmed)) {
      // Flush any pending row before moving on
      if (pendingRow) {
        records.push(finishRow(pendingRow, null));
        pendingRow = null;
      }
      continue;
    }

    // Detect employee name line
    if (isEmployeeName(trimmed)) {
      // Flush pending
      if (pendingRow) {
        records.push(finishRow(pendingRow, null));
        pendingRow = null;
      }
      currentEmployee = trimmed;
      continue;
    }

    if (!currentEmployee) continue;

    // Check if line contains a date (data line)
    const dateMatch = line.match(DATE_RE);
    if (dateMatch) {
      // Check if this is a page footer date (e.g., "02/25/2026 06:15:04 PM")
      if (/^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}\s*(AM|PM)/i.test(trimmed)) continue;

      // Flush previous pending row
      if (pendingRow) {
        records.push(finishRow(pendingRow, null));
      }

      // Parse this data line
      pendingRow = parseDataLine(line, dateMatch[1], currentEmployee);
    } else if (pendingRow) {
      // Continuation line (clock-out times)
      const outTimes = extractTimes(line);
      records.push(finishRow(pendingRow, outTimes));
      pendingRow = null;
    }
  }

  // Flush any remaining pending row
  if (pendingRow) {
    records.push(finishRow(pendingRow, null));
  }

  // Build summary
  const employeeNames = new Set(records.map(r => r.employeeName));
  const infractions = records.filter(r => r.classification === 'INFRACTION').length;
  const flags = records.filter(r => r.classification === 'FLAG').length;
  const absences = records.filter(r => r.classification === 'ABSENCE').length;
  const ok = records.filter(r => r.classification === 'OK').length;

  return {
    records,
    payPeriodStart,
    payPeriodEnd,
    totalRows: records.length,
    summary: {
      totalEmployees: employeeNames.size,
      infractions,
      flags,
      absences,
      ok,
      employeesWithInfractions: new Set(
        records.filter(r => r.classification === 'INFRACTION').map(r => r.employeeName)
      ).size,
      employeesWithFlags: new Set(
        records.filter(r => r.classification === 'FLAG').map(r => r.employeeName)
      ).size,
      employeesWithAnyIssue: new Set(
        records.filter(r => r.classification !== 'OK').map(r => r.employeeName)
      ).size,
      cleanEmployees: employeeNames.size - new Set(
        records.filter(r => r.classification !== 'OK').map(r => r.employeeName)
      ).size
    }
  };
}

/**
 * Determine if a trimmed line is an employee name.
 */
function isEmployeeName(trimmed) {
  // Must start with a capital letter
  if (!/^[A-Z]/.test(trimmed)) return false;
  // Must not be a known header/footer/totals line
  if (TOTALS_RE.test(trimmed) || HEADER_RE.test(trimmed) || PAGE_RE.test(trimmed)) return false;
  // Must not start with a date
  if (/^\d{2}\/\d{2}\/\d{4}/.test(trimmed)) return false;
  // Must not contain "Working Time"
  if (/Working Time/i.test(trimmed)) return false;
  // Must contain a comma (Last, First) or be a single name block
  // Employee names: "Last, First" or "Last, First Middle (Nickname)"
  if (EMPLOYEE_NAME_RE.test(trimmed)) return true;
  // Also handle names without comma that start a block (rare but possible)
  // If it's just alpha + spaces + common name chars, treat as name
  if (/^[A-Z][A-Za-z\u00C0-\u024F' -]+$/.test(trimmed) && trimmed.length < 60) return true;
  return false;
}

/**
 * Parse a data line that contains a date.
 * Returns a partial row object (missing clock-out times).
 */
function parseDataLine(line, dateStr, employeeName) {
  // Find position of date in the line
  const dateIdx = line.indexOf(dateStr);
  const afterDate = line.substring(dateIdx + dateStr.length);

  // Extract times from after the date
  const times = extractTimes(afterDate);

  // Determine if this is an absence by checking the gap between date and first time
  const afterDateTrimStart = afterDate.search(/\S/);
  const firstTimeMatch = afterDate.match(/\d{1,2}:\d{2}\s*[AP]M/);
  let isAbsence = false;
  let actualIn = null;
  let scheduledIn = null;

  if (!firstTimeMatch) {
    // No times at all — might be a line we can't parse
    isAbsence = true;
  } else if (times.length >= 2) {
    // Two times: actual and scheduled
    actualIn = times[0];
    scheduledIn = times[1];
  } else if (times.length === 1) {
    // One time: determine if it's actual or scheduled
    // Check the gap — if there's a large gap (>12 chars of space) between
    // date end and the time, the actual column is empty (absence)
    const timeIdx = afterDate.indexOf(firstTimeMatch[0]);
    const gapBeforeTime = afterDate.substring(0, timeIdx);
    const spaceCount = (gapBeforeTime.match(/\s/g) || []).length;

    if (spaceCount > 14) {
      // Large gap → absence, time is scheduled
      isAbsence = true;
      scheduledIn = times[0];
    } else {
      // Small gap → time is actual (split shift second half)
      actualIn = times[0];
    }
  }

  // Extract variances (after times)
  const variances = extractVariances(afterDate);
  const clockInVar = variances.length > 0 ? variances[0] : null;
  const clockOutVar = variances.length > 1 ? variances[1] : null;

  const clockInMinutes = parseVarianceToMinutes(clockInVar);

  return {
    employeeName,
    date: formatDate(dateStr),
    actualIn,
    scheduledIn,
    actualOut: null,
    scheduledOut: null,
    clockInVariance: clockInVar,
    clockOutVariance: clockOutVar,
    clockInMinutes,
    isAbsence
  };
}

/**
 * Finalize a row by adding clock-out times from continuation line.
 */
function finishRow(row, outTimes) {
  if (outTimes && outTimes.length > 0) {
    if (row.isAbsence) {
      // For absences, out times are scheduled out
      row.scheduledOut = outTimes[0];
    } else if (outTimes.length >= 2) {
      row.actualOut = outTimes[0];
      row.scheduledOut = outTimes[1];
    } else {
      row.actualOut = outTimes[0];
    }
  }

  // Classify
  let classification;
  if (row.isAbsence && !row.actualIn) {
    classification = 'ABSENCE';
  } else if (row.clockInMinutes !== null && row.clockInMinutes <= -10) {
    classification = 'INFRACTION';
  } else if (row.clockInMinutes !== null && row.clockInMinutes < -5) {
    classification = 'FLAG';
  } else {
    classification = 'OK';
  }

  return {
    employeeName: row.employeeName,
    date: row.date,
    actualIn: row.actualIn || null,
    actualOut: row.actualOut || null,
    scheduledIn: row.scheduledIn || null,
    scheduledOut: row.scheduledOut || null,
    clockInVarianceMinutes: row.clockInMinutes,
    clockOutVarianceMinutes: null, // not needed for tardiness
    classification
  };
}

/**
 * Extract time tokens (HH:MM AM/PM) from a string.
 */
function extractTimes(str) {
  const matches = [];
  let m;
  const re = /\d{1,2}:\d{2}\s*[AP]M/g;
  while ((m = re.exec(str)) !== null) {
    matches.push(m[0].replace(/\s+/g, ' '));
  }
  return matches;
}

/**
 * Extract variance tokens from a string.
 * Returns raw strings like "(2:23)", "0:05", "--"
 */
function extractVariances(str) {
  // Remove times first to avoid matching time-like patterns
  const cleaned = str.replace(/\d{1,2}:\d{2}\s*[AP]M/g, '   ');
  // Remove dollar amounts
  const noDollars = cleaned.replace(/\(\$[\d,.]+\)|\$[\d,.]+/g, '   ');

  const matches = [];
  // Match parenthesized variance like (2:23) or (0:01)
  // Match plain variance like 0:05 or 1:02
  // Match -- (no variance)
  const re = /\((\d+:\d{2})\)|(\d+:\d{2})|(?<=\s)(--)/g;
  let m;
  while ((m = re.exec(noDollars)) !== null) {
    matches.push(m[0]);
  }
  return matches;
}

/**
 * Parse a variance string to minutes.
 * "(2:23)" → -143 (late), "0:05" → 5 (early), "--" → 0
 */
function parseVarianceToMinutes(value) {
  if (!value || value === '--') return 0;
  const str = value.trim();

  const isLate = str.startsWith('(') && str.endsWith(')');
  const cleaned = str.replace(/[()]/g, '');

  const parts = cleaned.split(':');
  if (parts.length === 2) {
    const hours = parseInt(parts[0], 10) || 0;
    const mins = parseInt(parts[1], 10) || 0;
    const total = hours * 60 + mins;
    return isLate ? -total : total;
  }

  return 0;
}

/**
 * Convert MM/DD/YYYY to YYYY-MM-DD.
 */
function formatDate(mdy) {
  const parts = mdy.split('/');
  if (parts.length === 3) {
    return `${parts[2]}-${parts[0]}-${parts[1]}`;
  }
  return mdy;
}

module.exports = { parsePunchVarianceReport };
