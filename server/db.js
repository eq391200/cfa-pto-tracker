/**
 * Database layer — SQLite via better-sqlite3.
 *
 * Provides a singleton connection and handles schema creation + migrations.
 * All tables use WAL journal mode for concurrent read performance.
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'pto.db');

let db;

/**
 * Get (or create) the singleton database connection.
 * Enables WAL mode and foreign keys on first call.
 */
function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

/**
 * Initialize the database schema and run any pending migrations.
 * Safe to call multiple times — uses CREATE TABLE IF NOT EXISTS.
 */
function initDb() {
  const db = getDb();

  // ── Core Tables ─────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      username            TEXT UNIQUE NOT NULL,
      password_hash       TEXT NOT NULL,
      role                TEXT NOT NULL DEFAULT 'admin',
      employee_id         INTEGER,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS employees (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name             TEXT NOT NULL,
      last_name              TEXT NOT NULL,
      full_name              TEXT NOT NULL,
      employee_type          TEXT NOT NULL DEFAULT 'hourly',
      status                 TEXT NOT NULL DEFAULT 'active',
      first_clock_in         DATE,
      consecutive_empty_months INTEGER DEFAULT 0,
      flagged_for_review     INTEGER DEFAULT 0,
      created_at             DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_full_name
      ON employees(full_name);

    CREATE TABLE IF NOT EXISTS monthly_hours (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      year        INTEGER NOT NULL,
      month       INTEGER NOT NULL,
      total_hours REAL NOT NULL DEFAULT 0,
      imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(employee_id, year, month),
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS accruals (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id          INTEGER NOT NULL,
      year                 INTEGER NOT NULL,
      month                INTEGER NOT NULL,
      sick_days_earned     REAL NOT NULL DEFAULT 0,
      vacation_days_earned REAL NOT NULL DEFAULT 0,
      hours_worked         REAL NOT NULL DEFAULT 0,
      accrual_type         TEXT NOT NULL,
      created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(employee_id, year, month),
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS time_off_taken (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      type        TEXT NOT NULL,
      days_taken  REAL NOT NULL,
      date_taken  DATE NOT NULL,
      notes       TEXT,
      entered_by  TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS time_off_requests (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id    INTEGER NOT NULL,
      type           TEXT NOT NULL,
      days_requested REAL NOT NULL,
      start_date     DATE NOT NULL,
      end_date       DATE NOT NULL,
      reason         TEXT,
      status         TEXT NOT NULL DEFAULT 'pending',
      reviewed_by    TEXT,
      reviewed_at    DATETIME,
      review_notes   TEXT,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS notification_settings (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      setting_key   TEXT UNIQUE NOT NULL,
      setting_value TEXT NOT NULL,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS milestone_notifications (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      milestone   TEXT NOT NULL,
      sent_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(employee_id, milestone),
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    );
  `);

  // ── Migrations (additive, idempotent) ───────────────────────────
  runMigrations(db);

  return db;
}

/**
 * Add columns / tables that were introduced after initial deployment.
 * Each migration checks for existence before altering.
 */
function runMigrations(db) {
  const hasColumn = (table, column) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return cols.some(c => c.name === column);
  };

  // v1.1 — must_change_password on users
  if (!hasColumn('users', 'must_change_password')) {
    db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
  }

  // v1.2 — email on employees
  if (!hasColumn('employees', 'email')) {
    db.exec('ALTER TABLE employees ADD COLUMN email TEXT');
  }

  // v1.3 — slack_user_id on employees (for DM notifications)
  if (!hasColumn('employees', 'slack_user_id')) {
    db.exec('ALTER TABLE employees ADD COLUMN slack_user_id TEXT');
  }

  // v1.4 — punch adjustment fields on time_off_requests
  if (!hasColumn('time_off_requests', 'punch_date')) {
    db.exec("ALTER TABLE time_off_requests ADD COLUMN punch_date DATE");
  }
  if (!hasColumn('time_off_requests', 'clock_in')) {
    db.exec("ALTER TABLE time_off_requests ADD COLUMN clock_in TEXT");
  }
  if (!hasColumn('time_off_requests', 'clock_out')) {
    db.exec("ALTER TABLE time_off_requests ADD COLUMN clock_out TEXT");
  }
  if (!hasColumn('time_off_requests', 'break_start')) {
    db.exec("ALTER TABLE time_off_requests ADD COLUMN break_start TEXT");
  }
  if (!hasColumn('time_off_requests', 'break_end')) {
    db.exec("ALTER TABLE time_off_requests ADD COLUMN break_end TEXT");
  }

  // v1.5 — Tardiness analysis tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS tardiness_reports (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      pay_period_start DATE NOT NULL,
      pay_period_end   DATE NOT NULL,
      total_employees  INTEGER NOT NULL DEFAULT 0,
      total_records    INTEGER NOT NULL DEFAULT 0,
      infraction_count INTEGER NOT NULL DEFAULT 0,
      flag_count       INTEGER NOT NULL DEFAULT 0,
      absence_count    INTEGER NOT NULL DEFAULT 0,
      ok_count         INTEGER NOT NULL DEFAULT 0,
      uploaded_by      TEXT,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tardiness_records (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id                 INTEGER NOT NULL,
      employee_name             TEXT NOT NULL,
      shift_date                DATE NOT NULL,
      scheduled_in              TEXT,
      scheduled_out             TEXT,
      actual_in                 TEXT,
      actual_out                TEXT,
      clockin_variance_minutes  REAL,
      clockout_variance_minutes REAL,
      classification            TEXT NOT NULL DEFAULT 'OK',
      created_at                DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (report_id) REFERENCES tardiness_reports(id)
    );

    CREATE INDEX IF NOT EXISTS idx_tardiness_records_report
      ON tardiness_records(report_id);
    CREATE INDEX IF NOT EXISTS idx_tardiness_records_classification
      ON tardiness_records(report_id, classification);
  `);

  // v1.6 — Meal penalty analysis tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS meal_penalty_reports (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      date_range_start         DATE NOT NULL,
      date_range_end           DATE NOT NULL,
      total_employees          INTEGER NOT NULL DEFAULT 0,
      total_penalties          INTEGER NOT NULL DEFAULT 0,
      employees_with_penalties INTEGER NOT NULL DEFAULT 0,
      employees_clean          INTEGER NOT NULL DEFAULT 0,
      uploaded_by              TEXT,
      created_at               DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS meal_penalty_records (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id             INTEGER NOT NULL,
      employee_name         TEXT NOT NULL,
      violation_date        DATE NOT NULL,
      work_period_start     TEXT NOT NULL,
      work_period_end       TEXT NOT NULL,
      consecutive_minutes   INTEGER NOT NULL,
      consecutive_formatted TEXT NOT NULL,
      created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (report_id) REFERENCES meal_penalty_reports(id)
    );

    CREATE INDEX IF NOT EXISTS idx_meal_penalty_records_report
      ON meal_penalty_records(report_id);
    CREATE INDEX IF NOT EXISTS idx_meal_penalty_records_employee
      ON meal_penalty_records(report_id, employee_name);
  `);
}

module.exports = { getDb, initDb };
