/**
 * Shared constants used across the PTO Tracker application.
 * Centralizes values that were previously duplicated in multiple files.
 */

/** Full month names (0-indexed: January = 0) */
const MONTH_NAMES_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

/** Abbreviated month names (1-indexed: '' at 0, Jan = 1) — matches DB month values */
const MONTH_NAMES_SHORT = [
  '', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

/** Default application port */
const DEFAULT_PORT = 3000;

/** Session duration: 8 hours in milliseconds */
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;

/** Maximum number of database backups to retain */
const MAX_BACKUPS = 30;

/**
 * Format a YYYY-MM-DD date string for display.
 * @param {string} dateStr - ISO date string (e.g. '2025-03-22')
 * @returns {string} Human-readable date (e.g. 'March 22, 2025')
 */
function formatDateDisplay(dateStr) {
  if (!dateStr) return 'N/A';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

module.exports = {
  MONTH_NAMES_FULL,
  MONTH_NAMES_SHORT,
  DEFAULT_PORT,
  SESSION_MAX_AGE_MS,
  MAX_BACKUPS,
  formatDateDisplay
};
