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
    // Validate table name to prevent SQL injection (PRAGMA can't use parameters)
    if (!/^[a-z_]+$/i.test(table)) throw new Error('Invalid table name: ' + table);
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

  // v1.7 — Reconciliation reports (metadata only; report is an HTML file on disk)
  db.exec(`
    CREATE TABLE IF NOT EXISTS reconciliation_reports (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      month         INTEGER NOT NULL,
      year          INTEGER NOT NULL,
      period_label  TEXT NOT NULL,
      output_file   TEXT NOT NULL,
      file_size     INTEGER NOT NULL DEFAULT 0,
      uploaded_by   TEXT,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(year, month)
    );
  `);

  // v1.8 — Quarterly performance reviews
  db.exec(`
    CREATE TABLE IF NOT EXISTS performance_reviews (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id       INTEGER NOT NULL,
      year              INTEGER NOT NULL,
      quarter           INTEGER NOT NULL CHECK(quarter BETWEEN 1 AND 4),
      operations        INTEGER NOT NULL CHECK(operations BETWEEN 1 AND 5),
      cfa_values        INTEGER NOT NULL CHECK(cfa_values BETWEEN 1 AND 5),
      communication     INTEGER NOT NULL CHECK(communication BETWEEN 1 AND 5),
      guest_obsession   INTEGER NOT NULL CHECK(guest_obsession BETWEEN 1 AND 5),
      responsibility    INTEGER NOT NULL CHECK(responsibility BETWEEN 1 AND 5),
      culture           INTEGER NOT NULL CHECK(culture BETWEEN 1 AND 5),
      overall_override  REAL,
      comments          TEXT,
      submitted_by      TEXT,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_id) REFERENCES employees(id),
      UNIQUE(employee_id, year, quarter)
    );
  `);

  // v1.9 — department (BOH / FOH) on employees
  if (!hasColumn('employees', 'department')) {
    db.exec("ALTER TABLE employees ADD COLUMN department TEXT NOT NULL DEFAULT 'FOH'");
  }

  // v1.10 — role on employees
  if (!hasColumn('employees', 'role')) {
    db.exec("ALTER TABLE employees ADD COLUMN role TEXT NOT NULL DEFAULT 'Team Member'");
  }

  // v1.11 — BOH operations subsections on performance_reviews
  const bohSubsections = ['boh_primaria', 'boh_secundaria', 'boh_maquinas', 'boh_breading', 'boh_fileteo', 'boh_prep', 'boh_desayuno'];
  for (const col of bohSubsections) {
    if (!hasColumn('performance_reviews', col)) {
      db.exec(`ALTER TABLE performance_reviews ADD COLUMN ${col} INTEGER`);
    }
  }

  // v1.12 — Attentive & Courteous evaluations
  db.exec(`
    CREATE TABLE IF NOT EXISTS ac_evaluations (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id      INTEGER NOT NULL,
      evaluator_id     INTEGER NOT NULL,
      eval_date        DATE NOT NULL,
      eval_type        TEXT NOT NULL CHECK(eval_type IN ('order_taking', 'meal_delivery')),
      location         TEXT NOT NULL CHECK(location IN ('front_counter', 'drive_thru')),
      responses        TEXT NOT NULL,
      yes_count        INTEGER NOT NULL DEFAULT 0,
      no_count         INTEGER NOT NULL DEFAULT 0,
      na_count         INTEGER NOT NULL DEFAULT 0,
      total_applicable INTEGER NOT NULL DEFAULT 0,
      score_pct        REAL NOT NULL DEFAULT 0,
      comments         TEXT,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_id) REFERENCES employees(id),
      FOREIGN KEY (evaluator_id) REFERENCES employees(id)
    );
  `);

  // v1.13 — Performance indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_time_off_requests_emp_status
      ON time_off_requests(employee_id, type, status);
    CREATE INDEX IF NOT EXISTS idx_ac_evaluations_date
      ON ac_evaluations(eval_date, employee_id);
    CREATE INDEX IF NOT EXISTS idx_ac_evaluations_evaluator
      ON ac_evaluations(evaluator_id);
    CREATE INDEX IF NOT EXISTS idx_performance_reviews_emp
      ON performance_reviews(employee_id, year, quarter);
  `);

  // v1.14 — Leadership Academy
  db.exec(`
    CREATE TABLE IF NOT EXISTS la_competency_areas (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      slug       TEXT UNIQUE NOT NULL,
      description TEXT,
      icon       TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS la_checkpoints (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      competency_area_id INTEGER NOT NULL,
      tier               INTEGER NOT NULL CHECK(tier BETWEEN 1 AND 3),
      code               TEXT NOT NULL,
      title              TEXT NOT NULL,
      description        TEXT,
      evidence_required  TEXT,
      sort_order         INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (competency_area_id) REFERENCES la_competency_areas(id)
    );

    CREATE TABLE IF NOT EXISTS la_candidates (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id     INTEGER NOT NULL UNIQUE,
      current_tier    INTEGER NOT NULL DEFAULT 1 CHECK(current_tier BETWEEN 1 AND 3),
      status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','on_hold','graduated','withdrawn')),
      enrolled_by     TEXT,
      enrolled_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      target_ldp_date DATE,
      graduated_at    DATETIME,
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS la_checkpoint_progress (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id   INTEGER NOT NULL,
      checkpoint_id  INTEGER NOT NULL,
      status         TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','in_progress','completed','na','skill_1','skill_2','skill_3','skill_4','skill_5')),
      rating         INTEGER CHECK(rating BETWEEN 1 AND 4),
      target_date    DATE,
      completed_date DATE,
      evidence_notes TEXT,
      leader_notes   TEXT,
      approved_by    INTEGER,
      approved_at    DATETIME,
      FOREIGN KEY (candidate_id) REFERENCES la_candidates(id),
      FOREIGN KEY (checkpoint_id) REFERENCES la_checkpoints(id),
      UNIQUE(candidate_id, checkpoint_id)
    );

    CREATE TABLE IF NOT EXISTS la_learning_resources (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      title          TEXT NOT NULL,
      author         TEXT,
      type           TEXT NOT NULL CHECK(type IN ('book','video','podcast','article','ted_talk')),
      url            TEXT,
      description    TEXT,
      tier           INTEGER CHECK(tier BETWEEN 1 AND 3),
      required       INTEGER NOT NULL DEFAULT 0,
      thought_leader TEXT,
      sort_order     INTEGER NOT NULL DEFAULT 0,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS la_resource_progress (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      resource_id  INTEGER NOT NULL,
      completed    INTEGER NOT NULL DEFAULT 0,
      completed_at DATETIME,
      FOREIGN KEY (candidate_id) REFERENCES la_candidates(id),
      FOREIGN KEY (resource_id) REFERENCES la_learning_resources(id),
      UNIQUE(candidate_id, resource_id)
    );

    CREATE INDEX IF NOT EXISTS idx_la_checkpoint_progress_candidate ON la_checkpoint_progress(candidate_id);
    CREATE INDEX IF NOT EXISTS idx_la_checkpoint_progress_checkpoint ON la_checkpoint_progress(checkpoint_id);
    CREATE INDEX IF NOT EXISTS idx_la_resource_progress_candidate ON la_resource_progress(candidate_id);
    CREATE INDEX IF NOT EXISTS idx_la_candidates_employee ON la_candidates(employee_id);
  `);

  // Seed competency areas + checkpoints + resources (only if empty)
  const areaCount = db.prepare('SELECT COUNT(*) as c FROM la_competency_areas').get().c;
  if (areaCount === 0) {
    db.transaction(() => {
      // ── 4 Competency Areas ──
      const insertArea = db.prepare('INSERT INTO la_competency_areas (name, slug, description, icon, sort_order) VALUES (?, ?, ?, ?, ?)');
      insertArea.run('People Leadership', 'people', 'Recruit, develop, and retain high-performing teams while maintaining compliance with employment laws and CFA standards.', 'Users', 1);
      insertArea.run('Operations & Brand Standards', 'operations', 'Food safety systems, equipment management, facility standards, and operational consistency. Protect the brand.', 'Shield', 2);
      insertArea.run('Financial Acumen & Business Planning', 'financial', 'Analyze financial data, develop business plans, and make decisions that maximize the restaurant\'s financial return.', 'TrendingUp', 3);
      insertArea.run('Hospitality', 'hospitality', 'Winning Hearts Every Day strategy execution. Enhance guest experience, analyze CEM data, and drive sales growth.', 'Heart', 4);

      const areaIds = {};
      db.prepare('SELECT id, slug FROM la_competency_areas').all().forEach(a => { areaIds[a.slug] = a.id; });

      const insertCP = db.prepare('INSERT INTO la_checkpoints (competency_area_id, tier, code, title, description, evidence_required, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');

      // ── People Leadership: Tier 1 (6) ──
      insertCP.run(areaIds.people, 1, '1.1', 'Winning Hearts Every Day Strategy', 'Demonstrate understanding of CFA\'s Winning Hearts Every Day strategy', 'Written reflection or presentation', 1);
      insertCP.run(areaIds.people, 1, '1.2', 'Complete Pathway Training', 'Complete all Pathway training modules assigned to Team Members', 'Pathway completion certificate', 2);
      insertCP.run(areaIds.people, 1, '1.3', 'Shadow a Trainer', 'Shadow a Trainer for 2+ weeks and document learning observations', 'Shadow log with key takeaways', 3);
      insertCP.run(areaIds.people, 2, '1.4', 'Train a New Team Member', 'Successfully train a new Team Member using Pathway standards', 'Trainer evaluation form', 4);
      insertCP.run(areaIds.people, 1, '1.5', 'Shift Communication', 'Demonstrate clear communication skills during shift (huddles, handoffs)', 'Leader observation checklist', 5);
      insertCP.run(areaIds.people, 1, '1.6', 'Onboarding Compliance', 'Understand basic new-hire paperwork and onboarding compliance', 'Quiz or walkthrough assessment', 6);

      // ── People Leadership: Tier 2 (8) ──
      insertCP.run(areaIds.people, 2, '2.1', 'Lead Recruiting Process', 'Post positions, screen applicants, conduct interviews', 'Completed hiring packet for 3+ hires', 7);
      insertCP.run(areaIds.people, 2, '2.2', 'New-Hire Paperwork', 'Complete all new-hire and payroll paperwork accurately', 'Audit of 5 onboarding files with zero errors', 8);
      insertCP.run(areaIds.people, 2, '2.3', 'Labor Scheduling', 'Build and manage a weekly labor schedule meeting business needs and budget', 'Schedule samples with labor % analysis', 9);
      insertCP.run(areaIds.people, 2, '2.4', 'Performance Reviews', 'Conduct 5+ Team Member performance reviews using standardized criteria', 'Completed review forms with action plans', 10);
      insertCP.run(areaIds.people, 2, '2.5', 'Performance Management Plan', 'Create and implement a PMP for an underperforming Team Member', 'Documented PMP with follow-up notes', 11);
      insertCP.run(areaIds.people, 2, '2.6', 'Employment Law Knowledge', 'Demonstrate knowledge of key employment laws (FLSA, ADA, EEOC)', 'Pass employment law assessment (80%+)', 12);
      insertCP.run(areaIds.people, 2, '2.7', 'Role Clarity & Communication', 'Facilitate clear role clarity and communication systems for the team', 'Role clarity document and team feedback survey', 13);
      insertCP.run(areaIds.people, 2, '2.8', 'Supervise Trainers', 'Supervise and coach Trainers, ensuring Pathway standards are met', 'Trainer coaching log with improvement metrics', 14);

      // ── People Leadership: Tier 3 (6) ──
      insertCP.run(areaIds.people, 3, '3.1', 'Recruiting Pipeline Strategy', 'Develop and execute a full recruiting pipeline (sourcing through retention)', 'Recruiting strategy document with KPIs', 15);
      insertCP.run(areaIds.people, 3, '3.2', 'Payroll Processing', 'Manage biweekly payroll processing accurately and on time', 'Payroll accuracy log (3+ cycles)', 16);
      insertCP.run(areaIds.people, 3, '3.3', 'Compliance Processes', 'Develop compliance processes ensuring all documents meet legal requirements', 'Compliance audit results', 17);
      insertCP.run(areaIds.people, 3, '3.4', 'FTS Coordination', 'Recruit, select, and schedule Field Talent Staff as needed', 'FTS coordination log', 18);
      insertCP.run(areaIds.people, 3, '3.5', 'Lead Team of 20+', 'Lead a team of 20+ Team Members independently for 4+ consecutive weeks', 'Operations report and leader assessment', 19);
      insertCP.run(areaIds.people, 3, '3.6', 'State of the People Assessment', 'Present a data-driven "State of the People" assessment', 'Presentation to Operator', 20);

      // ── Operations & Brand: Tier 1 (6) ──
      insertCP.run(areaIds.operations, 1, '1.1', 'ServSafe Food Handler', 'Pass ServSafe Food Handler certification', 'Certificate', 1);
      insertCP.run(areaIds.operations, 1, '1.2', 'LEAN Chicken Procedures', 'Demonstrate proficiency in LEAN Chicken procedures', 'Practical assessment by leader', 2);
      insertCP.run(areaIds.operations, 1, '1.3', 'SAFE Daily Critical', 'Complete SAFE Daily Critical checklist accurately for 5+ consecutive days', 'Completed checklists reviewed by leader', 3);
      insertCP.run(areaIds.operations, 1, '1.4', 'Equipment Knowledge', 'Identify and explain all key equipment and basic troubleshooting', 'Equipment knowledge quiz (85%+)', 4);
      insertCP.run(areaIds.operations, 1, '1.5', 'Cleanliness Standards', 'Maintain station cleanliness standards consistently for 30+ days', 'Cleanliness audit scores', 5);
      insertCP.run(areaIds.operations, 1, '1.6', 'Brand Standards', 'Understand and follow all CFA brand standards at your assigned station', 'Brand standards observation checklist', 6);

      // ── Operations & Brand: Tier 2 (7) ──
      insertCP.run(areaIds.operations, 2, '2.1', 'ServSafe Manager', 'Obtain ServSafe Manager certification', 'Certificate', 7);
      insertCP.run(areaIds.operations, 2, '2.2', 'eRQA Daily Evaluation', 'Complete eRQA daily and evaluate results for 30+ consecutive days', 'eRQA log with corrective actions documented', 8);
      insertCP.run(areaIds.operations, 2, '2.3', 'Food Safety System', 'Create a sustainable food safety system (LEAN Chicken focus)', 'Written system with SOPs', 9);
      insertCP.run(areaIds.operations, 2, '2.4', 'Equipment Assessment', 'Assess equipment and smallwares needs; submit recommendation', 'Equipment assessment report', 10);
      insertCP.run(areaIds.operations, 2, '2.5', 'Cleanliness System', 'Develop and implement a restaurant cleanliness system with accountability', 'Cleanliness system document and audit results', 11);
      insertCP.run(areaIds.operations, 2, '2.6', 'Resolve Bottlenecks', 'Identify and resolve 3+ operational bottlenecks with documented solutions', 'Bottleneck analysis with before/after metrics', 12);
      insertCP.run(areaIds.operations, 2, '2.7', 'Brand Compliance', 'Ensure brand standards consistently met across all stations during managed shifts', 'Brand compliance scores (90%+) over 30 days', 13);

      // ── Operations & Brand: Tier 3 (6) ──
      insertCP.run(areaIds.operations, 3, '3.1', 'Team ServSafe Tracking', 'Ensure all Restaurant Leaders maintain current ServSafe certification', 'Certification tracking log', 14);
      insertCP.run(areaIds.operations, 3, '3.2', 'Vendor Evaluation', 'Evaluate vendor performance and make data-driven recommendations', 'Vendor scorecard and recommendation report', 15);
      insertCP.run(areaIds.operations, 3, '3.3', 'Inventory & Ordering', 'Implement and oversee inventory/ordering processes; train Team Members', 'Inventory SOP and training completion log', 16);
      insertCP.run(areaIds.operations, 3, '3.4', 'Throughput Improvement', 'Innovate a throughput improvement that increases speed of service', 'Throughput project with data (before/after)', 17);
      insertCP.run(areaIds.operations, 3, '3.5', 'Facility Maintenance', 'Lead a facility maintenance assessment and create preventive calendar', 'Maintenance plan document', 18);
      insertCP.run(areaIds.operations, 3, '3.6', 'State of Operations', 'Present a comprehensive "State of Operations" assessment to Operator', 'Presentation with data and action plan', 19);

      // ── Financial Acumen: Tier 1 (3) ──
      insertCP.run(areaIds.financial, 1, '1.1', 'Financial Concepts', 'Understand basic restaurant financial concepts (revenue, COGS, labor, profit)', 'Financial literacy quiz (80%+)', 1);
      insertCP.run(areaIds.financial, 1, '1.2', 'Daily Sales Tracking', 'Track and report daily sales figures accurately for 2+ weeks', 'Daily sales tracking sheet', 2);
      insertCP.run(areaIds.financial, 1, '1.3', 'Labor & Scheduling', 'Understand the relationship between labor scheduling and labor cost %', 'Written explanation or discussion', 3);

      // ── Financial Acumen: Tier 2 (4) ──
      insertCP.run(areaIds.financial, 2, '2.1', 'EOM Analysis', 'Analyze End-of-Month package and identify 3+ actionable insights', 'EOM analysis document', 4);
      insertCP.run(areaIds.financial, 2, '2.2', '30-Day Business Plan', 'Develop a 30-day business plan for a specific area of the restaurant', '30-day plan with goals, actions, and metrics', 5);
      insertCP.run(areaIds.financial, 2, '2.3', 'Inventory & Waste Reduction', 'Manage inventory levels and ordering to reduce waste measurably', 'Waste tracking data and improvement metrics', 6);
      insertCP.run(areaIds.financial, 2, '2.4', 'Labor Budget', 'Create a labor budget for 2 weeks and manage actual within 1% of target', 'Budget vs. actual labor report', 7);

      // ── Financial Acumen: Tier 3 (5) ──
      insertCP.run(areaIds.financial, 3, '3.1', '30-60-90 Business Plan', 'Develop a comprehensive 30-60-90 day business plan', 'Full business plan document', 8);
      insertCP.run(areaIds.financial, 3, '3.2', 'Financial Trend Analysis', 'Analyze 3+ months of EOM data and present trends with recommendations', 'Financial trend analysis presentation', 9);
      insertCP.run(areaIds.financial, 3, '3.3', 'P&L Management', 'Manage full P&L responsibility for a simulated or actual 4-week period', 'P&L report with variance analysis', 10);
      insertCP.run(areaIds.financial, 3, '3.4', 'Sales Forecasting', 'Forecast sales for a 4-week period within 5% accuracy', 'Forecast vs. actual comparison', 11);
      insertCP.run(areaIds.financial, 3, '3.5', 'Transition Readiness', 'Ensure restaurant readiness for a smooth operational transition', 'Transition checklist and readiness report', 12);

      // ── Hospitality: Tier 1 (3) ──
      insertCP.run(areaIds.hospitality, 1, '1.1', 'CEM Score Excellence', 'Achieve consistent "Highly Satisfied" mystery shop or CEM scores', 'CEM score tracking', 1);
      insertCP.run(areaIds.hospitality, 1, '1.2', 'Hospitality Model', 'Demonstrate CFA hospitality model (Core 4, Second Mile Service)', 'Leader observation and guest feedback', 2);
      insertCP.run(areaIds.hospitality, 1, '1.3', 'Guest Recovery', 'Handle 5+ guest recovery situations with positive outcomes', 'Guest recovery log', 3);

      // ── Hospitality: Tier 2 (4) ──
      insertCP.run(areaIds.hospitality, 2, '2.1', 'CEM Analysis', 'Analyze CEM survey results and identify top 3 opportunities', 'CEM analysis report', 4);
      insertCP.run(areaIds.hospitality, 2, '2.2', 'CEM Improvement Strategy', 'Create and implement a strategy to improve one CEM metric by 5+ points', 'Strategy document with results', 5);
      insertCP.run(areaIds.hospitality, 2, '2.3', 'Guest Experience Coaching', 'Coach 3+ Team Members on guest experience improvement based on CEM data', 'Coaching logs with before/after metrics', 6);
      insertCP.run(areaIds.hospitality, 2, '2.4', 'Community Engagement', 'Develop a local marketing or community engagement initiative', 'Initiative plan and execution summary', 7);

      // ── Hospitality: Tier 3 (4) ──
      insertCP.run(areaIds.hospitality, 3, '3.1', 'Customer Experience Strategy', 'Develop a comprehensive CX strategy aligned with Winning Hearts Every Day', 'CX strategy document', 8);
      insertCP.run(areaIds.hospitality, 3, '3.2', 'Sales Growth Plan', 'Analyze sales trends and create a sales growth plan for next quarter', 'Sales growth plan with projections', 9);
      insertCP.run(areaIds.hospitality, 3, '3.3', 'Team CEM Initiative', 'Lead a team-wide CEM improvement initiative with measurable results', 'Project summary with data', 10);
      insertCP.run(areaIds.hospitality, 3, '3.4', 'State of Hospitality', 'Present a "State of the Customer Experience" assessment to Operator', 'Presentation with data and action plan', 11);

      // ── Learning Resources (18+) ──
      const insertRes = db.prepare('INSERT INTO la_learning_resources (title, author, type, url, description, tier, required, thought_leader, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');

      // Tier 1 Required
      insertRes.run('Cómo Dar un Feedback Efectivo', null, 'book', null, 'Master the art of giving effective feedback (Spanish)', 1, 1, null, 1);
      insertRes.run('Hospitalidad Irracional (Unreasonable Hospitality)', 'Will Guidara', 'book', null, 'Elevate your understanding of what extraordinary hospitality looks like', 1, 1, null, 2);
      insertRes.run('Why Good Leaders Make You Feel Safe', 'Simon Sinek', 'ted_talk', 'https://www.youtube.com/watch?v=lmyZMtPVodo', 'The foundation of the Circle of Safety', 1, 1, 'Sinek', 3);
      insertRes.run('Sharpening Your Communication Skills: Part 1', 'Craig Groeschel', 'podcast', 'https://youtu.be/6nNnB1Un774', 'Become a clearer, more compelling communicator', 1, 1, 'Groeschel', 4);
      insertRes.run('Sharpening Your Communication Skills: Part 2', 'Craig Groeschel', 'podcast', 'https://youtu.be/sjKnrG8avbQ', 'Continue developing communication mastery', 1, 1, 'Groeschel', 5);
      insertRes.run('Start With Why', 'Simon Sinek', 'book', null, 'Understand the power of purpose-driven leadership', 1, 1, 'Sinek', 6);

      // Tier 1 Recommended
      insertRes.run('The Servant', 'James C. Hunter', 'book', null, 'An accessible introduction to servant leadership principles', 1, 0, 'Greenleaf', 7);
      insertRes.run('Good to Great', 'Jim Collins', 'book', null, 'What separates good organizations from great ones', 1, 0, null, 8);
      insertRes.run('QBQ! The Question Behind the Question', 'John G. Miller', 'book', null, 'Personal accountability in leadership', 1, 0, null, 9);

      // Tier 2 Required
      insertRes.run('The 5 Levels of Leadership', 'John Maxwell', 'book', null, 'Understand your leadership level and how to grow', 2, 1, 'Maxwell', 10);
      insertRes.run('Leaders Eat Last', 'Simon Sinek', 'book', null, 'Build a Circle of Safety for your team', 2, 1, 'Sinek', 11);
      insertRes.run('The Servant as Leader', 'Robert K. Greenleaf', 'article', null, 'The original servant leadership manifesto', 2, 1, 'Greenleaf', 12);

      // Tier 2 Recommended
      insertRes.run('Developing the Leader Within You 2.0', 'John Maxwell', 'book', null, 'Practical leadership growth strategies', 2, 0, 'Maxwell', 13);
      insertRes.run('The Culture Code', 'Daniel Coyle', 'book', null, 'How great groups build belonging, vulnerability, and purpose', 2, 0, null, 14);

      // Tier 3 Required
      insertRes.run('The 21 Irrefutable Laws of Leadership', 'John Maxwell', 'book', null, 'Master the fundamental laws that govern leadership', 3, 1, 'Maxwell', 15);
      insertRes.run('The Infinite Game', 'Simon Sinek', 'book', null, 'Lead with a long-term, legacy-building mindset', 3, 1, 'Sinek', 16);
      insertRes.run('It\'s Your Ship', 'Captain D. Michael Abrashoff', 'book', null, 'Taking ownership and empowering your crew', 3, 1, null, 17);

      // Tier 3 Recommended
      insertRes.run('Dare to Lead', 'Brené Brown', 'book', null, 'Courage, vulnerability, and leading through uncertainty', 3, 0, null, 18);
      insertRes.run('Extreme Ownership', 'Jocko Willink & Leif Babin', 'book', null, 'Radical accountability in leadership', 3, 0, null, 19);
      insertRes.run('Winning', 'Tim S. Grover', 'book', null, 'The relentless pursuit of excellence', 3, 0, null, 20);
    })();
  }

  // v1.15 — image_url on la_checkpoints
  if (!hasColumn('la_checkpoints', 'image_url')) {
    db.exec("ALTER TABLE la_checkpoints ADD COLUMN image_url TEXT");
    db.prepare("UPDATE la_checkpoints SET image_url = '/img/la/whed-poster.jpg' WHERE id = 1").run();
  }

  // v1.16 — evidence file uploads on la_checkpoint_progress (JSON array of file paths)
  if (!hasColumn('la_checkpoint_progress', 'evidence_files')) {
    db.exec("ALTER TABLE la_checkpoint_progress ADD COLUMN evidence_files TEXT");
  }

  // v1.17 — needs_setup flag for employees created via import (no portal account yet)
  if (!hasColumn('employees', 'needs_setup')) {
    db.exec("ALTER TABLE employees ADD COLUMN needs_setup INTEGER NOT NULL DEFAULT 0");
  }

  // v1.18 — Executive Scorecard (monthly metrics)
  db.exec(`
    CREATE TABLE IF NOT EXISTS scorecard_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month TEXT NOT NULL,
      metric_key TEXT NOT NULL,
      metric_value REAL,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(month, metric_key)
    )
  `);

  // v1.19 — Checkpoint-Resource linking
  db.exec(`
    CREATE TABLE IF NOT EXISTS la_checkpoint_resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      checkpoint_id INTEGER NOT NULL REFERENCES la_checkpoints(id),
      resource_id INTEGER NOT NULL REFERENCES la_learning_resources(id),
      UNIQUE(checkpoint_id, resource_id)
    )
  `);

  // v1.20 — OSAT by weekday
  db.exec(`
    CREATE TABLE IF NOT EXISTS scorecard_osat_weekday (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month TEXT NOT NULL,
      weekday TEXT NOT NULL,
      osat_value REAL,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(month, weekday)
    )
  `);

  // v1.21 — Expand la_checkpoint_progress status CHECK to include skill levels
  try {
    const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='la_checkpoint_progress'").get();
    if (tableInfo && tableInfo.sql && !tableInfo.sql.includes('skill_1')) {
      db.exec(`
        CREATE TABLE la_checkpoint_progress_new (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          candidate_id   INTEGER NOT NULL,
          checkpoint_id  INTEGER NOT NULL,
          status         TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','in_progress','completed','na','skill_1','skill_2','skill_3','skill_4','skill_5')),
          rating         INTEGER CHECK(rating BETWEEN 1 AND 4),
          target_date    DATE,
          completed_date DATE,
          evidence_notes TEXT,
          evidence_files TEXT,
          leader_notes   TEXT,
          approved_by    INTEGER,
          approved_at    DATETIME,
          FOREIGN KEY (candidate_id) REFERENCES la_candidates(id),
          FOREIGN KEY (checkpoint_id) REFERENCES la_checkpoints(id),
          UNIQUE(candidate_id, checkpoint_id)
        );
        INSERT INTO la_checkpoint_progress_new SELECT id, candidate_id, checkpoint_id, status, rating, target_date, completed_date, evidence_notes, evidence_files, leader_notes, approved_by, approved_at FROM la_checkpoint_progress;
        DROP TABLE la_checkpoint_progress;
        ALTER TABLE la_checkpoint_progress_new RENAME TO la_checkpoint_progress;
      `);
    }
  } catch (e) { console.log('v1.21 migration note:', e.message); }

  // ── Social Posts Module Tables ──────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS social_posts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      post_type      TEXT NOT NULL CHECK(post_type IN ('weekly-special','lto','community-event','seasonal','brand-moment')),
      ig_format      TEXT NOT NULL DEFAULT 'ig-square' CHECK(ig_format IN ('ig-square','ig-portrait')),
      headline       TEXT NOT NULL,
      key_detail     TEXT,
      context        TEXT,
      tone           TEXT DEFAULT 'default',
      cta            TEXT,
      photo_url      TEXT,
      ig_headline    TEXT,
      ig_subheadline TEXT,
      ig_body        TEXT,
      ig_cta         TEXT,
      ig_icons       TEXT,
      fb_headline    TEXT,
      fb_subheadline TEXT,
      fb_body        TEXT,
      fb_cta         TEXT,
      fb_icons       TEXT,
      ig_exported    INTEGER DEFAULT 0,
      fb_exported    INTEGER DEFAULT 0,
      created_by     TEXT NOT NULL,
      created_at     TEXT DEFAULT (datetime('now')),
      updated_at     TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS social_icons (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      category            TEXT NOT NULL,
      tags                TEXT NOT NULL DEFAULT '[]',
      file_path           TEXT NOT NULL,
      compatible_types    TEXT NOT NULL DEFAULT '[]',
      active              INTEGER DEFAULT 1,
      created_at          TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS social_brand_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS social_product_photos (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      name                TEXT NOT NULL,
      category            TEXT NOT NULL,
      tags                TEXT NOT NULL DEFAULT '[]',
      file_path           TEXT NOT NULL,
      active              INTEGER DEFAULT 1,
      created_at          TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Seed default brand config if empty
  const configCount = db.prepare('SELECT COUNT(*) as c FROM social_brand_config').get();
  if (configCount.c === 0) {
    const defaults = db.prepare('INSERT OR IGNORE INTO social_brand_config (key, value) VALUES (?, ?)');
    defaults.run('brand_name', 'Chick-fil-A La Rambla');
    defaults.run('brand_voice', 'Cálido, comunitario, familiar, entusiasta. Usamos un tono cercano y acogedor que invita a la acción.');
    defaults.run('forbidden_words', '["barato","gratis total","fast food","comida rápida","McDonald","Burger King","Wendy"]');
    defaults.run('primary_color', '#DD0033');
    defaults.run('secondary_color', '#004F71');
    defaults.run('accent_color', '#E52216');
    defaults.run('bg_color', '#FFFFFF');
    defaults.run('text_color', '#333333');
    defaults.run('cta_options', '["Visítanos hoy","Solo por tiempo limitado","¡No te lo pierdas!","Reserva tu espacio","¡Te esperamos!","Ordena ahora","Ven y disfruta"]');
    defaults.run('disclaimer_template', 'Solo en Chick-fil-A La Rambla. {{details}} Sujeto a disponibilidad.');
  }

  // v1.22 — Gastos (Invoice Entry) module
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gastos_suppliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        inc_id TEXT,
        default_category_id INTEGER,
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS gastos_expense_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        name_es TEXT,
        inc_id TEXT,
        active INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS gastos_invoices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier_id INTEGER REFERENCES gastos_suppliers(id),
        invoice_number TEXT NOT NULL,
        invoice_date TEXT NOT NULL,
        payment_date TEXT,
        business_period TEXT,
        currency TEXT DEFAULT 'USD',
        total_amount REAL DEFAULT 0,
        status TEXT DEFAULT 'draft' CHECK(status IN ('draft','ready','submitted','verified','error')),
        inc_submitted INTEGER DEFAULT 0,
        inc_submitted_at TEXT,
        source_file TEXT,
        ocr_raw TEXT,
        notes TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS gastos_invoice_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_id INTEGER NOT NULL REFERENCES gastos_invoices(id) ON DELETE CASCADE,
        category_id INTEGER REFERENCES gastos_expense_categories(id),
        description TEXT,
        amount REAL NOT NULL,
        ai_suggested_category INTEGER,
        ai_confidence REAL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS gastos_submission_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_id INTEGER NOT NULL REFERENCES gastos_invoices(id),
        action TEXT NOT NULL,
        details TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);

    // Seed expense categories (only if table is empty)
    const catCount = db.prepare('SELECT COUNT(*) as c FROM gastos_expense_categories').get().c;
    if (catCount === 0) {
      db.transaction(() => {
        const insertCat = db.prepare('INSERT INTO gastos_expense_categories (name, name_es, inc_id) VALUES (?, ?, ?)');
        insertCat.run('Auto Liability Insurance', 'Seguro de responsabilidad civil del automóvil', '1268');
        insertCat.run('Bank Charges', 'Gastos bancarios', '1004');
        insertCat.run('Business Interruption Insrnc', 'Seg. interrupción de negocios', '1227');
        insertCat.run('CFA Kiosk', 'Puesto CFA', '1225');
        insertCat.run('Catering Expense', 'Gastos de servicio de banquetes', '1008');
        insertCat.run('Catering Mileage - Team Member', 'Viáticos del servicio de banquetes: Miembro del Equipo', '1265');
        insertCat.run('Cell Phone - Team Members', 'Teléfono Celular - Miem. Del Eq.', '1203');
        insertCat.run('Change Fund', 'Fondo de cambio', '1009');
        insertCat.run('Cleaning Supplies', 'Suministros de limpieza', '1010');
        insertCat.run('Commissions Paid on Sales', 'Comisiones pagadas por ventas', '1102');
        insertCat.run('Contents and Inventory Insrnc', 'Seg. contenido e inventario', '1229');
        insertCat.run('Crime Insurance', 'Seguro contra delitos', '1266');
        insertCat.run('Cyber Insurance', 'Seguro cibernético', '1267');
        insertCat.run('Distributor - Fuel Surcharge', 'Distribuidor: recargo por combustible', '1264');
        insertCat.run('Drive-Thru TM Experience', 'Exp. miem. eq. autoserv.', '1215');
        insertCat.run('Dues & Subscriptions', null, '1295');
        insertCat.run('Electric Salad Spinners', 'Escurridores eléctricos de ensaladas', '1210');
        insertCat.run('Electric Utility - Utility Co.', 'Servicios Públicos - Electricidad', '1020');
        insertCat.run('Floor Scrubbers', 'Fregadoras de pisos', '1211');
        insertCat.run('Food - Beverages', 'Alimentos: bebidas', '1123');
        insertCat.run('Food - Bread', 'Alimentos: pan', '1124');
        insertCat.run('Food - Breakfast', 'Alimentos: desayuno', '1125');
        insertCat.run('Food - Chicken - Breakfast', 'Alimentos: pollo, desayuno', '1126');
        insertCat.run('Food - Chicken - Filets', 'Alimentos: pollo, filetes', '1131');
        insertCat.run('Food - Chicken - Grld Filet', 'Alim.: pollo, filete grillado', '1127');
        insertCat.run('Food - Chicken - Grld Nggts', 'Alim.: pollo, nggts de pollo', '1202');
        insertCat.run('Food - Chicken - Nuggets', 'Alimentos: pollo, nuggets', '1132');
        insertCat.run('Food - Chicken - Spicy', 'Alimentos: pollo, picante', '1145');
        insertCat.run('Food - Chicken - Strips', 'Alimentos: pollo, tiras', '1136');
        insertCat.run('Food - Coater', 'Alimentos: recubrimiento', '1128');
        insertCat.run('Food - Condiments', 'Alimentos: condimentos', '1129');
        insertCat.run('Food - Dessert', 'Alimentos: postre', '1130');
        insertCat.run('Food - Distributor', 'Alimentos: distribuidor', '1273');
        insertCat.run('Food - Miscellaneous', 'Alimentos: varios', '1216');
        insertCat.run('Food - Oil', 'Alimentos: aceite', '1134');
        insertCat.run('Food - Other Food', 'Alimentos: otros alimentos', '1023');
        insertCat.run('Food - Produce', 'Alimentos: productos', '1135');
        insertCat.run('Food - Test Ingredients', 'Alimentos: ingredientes de prueba', '1138');
        insertCat.run('Food - Waffle Potato Fries', 'Alimentos: waffle potato fries', '1137');
        insertCat.run('Food Giveaways', 'Regalos de alimentos', '1282');
        insertCat.run('General Liability', null, '1301');
        insertCat.run('General Miscellaneous', 'Varios generales', '1027');
        insertCat.run('Health Insurance - Team Member', 'Seguro Médico - Miem. Del Eq.', '1031');
        insertCat.run('Health Insurance Administrative Fees', 'Cargos administrativos del seguro de salud', '1254');
        insertCat.run('Kitchen Supplies', 'Suministros de cocina', '1036');
        insertCat.run('Legal Fees - Restaurant Ops', null, '1322');
        insertCat.run('License', 'Licencia', '1038');
        insertCat.run('Life Insurance-Team Member', 'Seguro de vida: Miembro del Equipo', '1244');
        insertCat.run('Linen', 'Ropa blanca', '1039');
        insertCat.run('Maint Bldg - Door/Glass/HW', 'Manten. de Edf. - Puer./Vid./HW', '1337');
        insertCat.run('Maint Bldg - Electrical', 'Manten. de Edf. - Eléctrico', '1338');
        insertCat.run('Maint Bldg - Exhaust', 'Manten. de Edf. - Extractor', '1346');
        insertCat.run('Maint Bldg - Finishes/Paint', 'Manten. de Edf. - Acabos/Pint.', '1339');
        insertCat.run('Maint Bldg - HVAC', 'Manten. de Edf. - HVAC', '1340');
        insertCat.run('Maint Bldg - Lighting', 'Manten. de Edf. - Iluminación', '1342');
        insertCat.run('Maint Bldg - Lndscp/Lawn/Irrig', 'Manten. de Edf. - Paisaj./Césp./Rieg.', '1347');
        insertCat.run('Maint Bldg - Miscellaneous', 'Manten. de Edf. - Varios', '1344');
        insertCat.run('Maint Bldg - Playground', 'Manten. de Edf. - Área Infantil', '1348');
        insertCat.run('Maint Bldg - Plumbing', 'Manten. de Edf. - Plomería', '1349');
        insertCat.run('Maint Bldg - Prev/Sched Maint', 'Manten. de Edf. - Mant. Ant./Prog.', '1350');
        insertCat.run('Maint Bldg - Seating', 'Manten. de Edf. - Asientos', '1351');
        insertCat.run('Maint Bldg - Signage', 'Manten. de Edf. - Señalización', '1352');
        insertCat.run('Maint Equip- Beverage', 'Manten. de Eq. - Bebidas', '1353');
        insertCat.run('Maint Equip- DriveThru Equip', 'Manten. de Eq. - Eq. de Autoserv.', '1354');
        insertCat.run('Maint Equip- Food Prep/Hold', 'Manten. de Eq. - Prep./Ret. Alim.', '1355');
        insertCat.run('Maint Equip- Frig/Freezer/Thaw', 'Manten. de Eq. - Ref./Cong./Descon.', '1356');
        insertCat.run('Maint Equip- Grill', 'Manten. de Eq. - Parrilla', '1357');
        insertCat.run('Maint Equip- I.T.', 'Manten. de Eq. - I.T.', '1358');
        insertCat.run('Maint Equip- Ice Cream', 'Manten. de Eq. - Helado', '1359');
        insertCat.run('Maint Equip- Ice Machine', 'Manten. de Eq. - Máquina de Hielo', '1360');
        insertCat.run('Maint Equip- Miscellaneous', 'Manten. de Eq. - Varios', '1361');
        insertCat.run('Maint Equip- Open Fryer', 'Manten. de Eq. - Freidora Abierta', '1362');
        insertCat.run('Maint Equip- Other', 'Manten. de Eq. - Otra', '1368');
        insertCat.run('Maint Equip- Pressure Fryer', 'Manten. de Eq. - Freidora Pres.', '1363');
        insertCat.run('Maint Equip- Prev/Sched Maint', 'Manten. de Eq. - Mant. Ant./Prog.', '1364');
        insertCat.run('Maint Equip- Shelving', 'Manten. de Eq. - Estanterías', '1365');
        insertCat.run('Maint Equip- Walkin Frig/Frzr', 'Manten. de Eq. - Cám. Frig./Cong.', '1366');
        insertCat.run('Maint Equip- Water Filtration', 'Manten. de Eq. - Filtr. de Agua', '1367');
        insertCat.run('Maintenance', 'Mantenimiento', '1334');
        insertCat.run('Marketing - Fundraisers', 'Marketing - Recaud. de Fondos', '1150');
        insertCat.run('Marketing - Rest. Advertising', 'Marketing - Publicidad de Rest.', '1148');
        insertCat.run('Marketing - Services', 'Marketing - Servicios', '1149');
        insertCat.run('Marketing - Sponsorships', null, '1328');
        insertCat.run('Marketing - Sponsorships', 'Marketing - Patrocinios', '1302');
        insertCat.run('Meals - Operator', 'Comidas - Operador', '1043');
        insertCat.run('Meals - Team Member', 'Comidas - Miembro Del Equipo', '1345');
        insertCat.run('Music Expense', 'Gastos de música', '1074');
        insertCat.run('NSF Check Collection', 'Recop. de cheques NSF', '1097');
        insertCat.run('Office Supplies', 'Suministros de oficina', '1044');
        insertCat.run('Offsite Office Space', 'Espacio de oficina fuera de las instalaciones', '1112');
        insertCat.run('Operator Business Mileage', 'Viáticos de negocios del operador', '1239');
        insertCat.run('Operator Development Expense', null, '1294');
        insertCat.run('Operator EPLI', 'Operador de EPLI', '1255');
        insertCat.run('Operator cell phone', 'Teléfono celular del operador', '1096');
        insertCat.run('Other Business Insurance', 'Seguro de otros negocios', '1230');
        insertCat.run('Other Team Member Benefits', 'Otros beneficios para miembros del equipo', '1208');
        insertCat.run('Other Team Member Benefits', 'Otros beneficios para miembros del equipo', '1205');
        insertCat.run('Paper', 'Papel', '1048');
        insertCat.run('Paper Giveaways', 'Regalos en papel', '1283');
        insertCat.run('Party/Outing Expense', 'Gastos de celebraciones/salidas', '1194');
        insertCat.run('Payroll - Wages - bonus/vacation/sick time', 'Nómina: salarios, bono/vacaciones/licencia por enfermed', '1257');
        insertCat.run('Payroll - Workers Comp Insurance', 'Nóm. Seg. indem. acc. trab.', '1256');
        insertCat.run('Payroll- Wages', 'Salarios de nómina', '1037');
        insertCat.run('Pension - Team Member', 'Pensión: Miembro del Equipo', '1259');
        insertCat.run('Pest Control', 'Control de plagas', '1050');
        insertCat.run('Phone-Landline/Internet/Wifi', 'Teléfono fijo/Internet/Wi-Fi', '1056');
        insertCat.run('Products and Premise Liability Insurance', 'Seguro de responsabilidad de productos e instalaciones', '1253');
        insertCat.run('Profit Sharing - Team Member', 'Reparto de las ganancias: Miembro del Equipo', '1220');
        insertCat.run('Property Tax Expense', 'Gastos de impuesto a la propiedad', '1284');
        insertCat.run('Property Tax-Opr/Entity Owned', null, '1329');
        insertCat.run('R&M Equip - Music', 'Eq. de R+M: música', '1162');
        insertCat.run('R&M Equip - Security', 'Eq. de R+M: seguridad', '1168');
        insertCat.run('Recruiting Expense', 'Gastos de reclutamiento', '1224');
        insertCat.run('Repair Bldg - Door/Glass/HW', 'Repar. de Edf. - Puer./Vid./HW', '1171');
        insertCat.run('Repair Bldg - Electrical', 'Repar. de Edf. - Eléctrico', '1172');
        insertCat.run('Repair Bldg - Exhaust', 'Repar. de Edf. - Extractor', '1173');
        insertCat.run('Repair Bldg - Finishes/Paint', 'Repar. de Edf. - Acabos/Pint.', '1175');
        insertCat.run('Repair Bldg - HVAC', 'Repar. de Edf. - HVAC', '1174');
        insertCat.run('Repair Bldg - Lighting', 'Repar. de Edf. - Iluminación', '1177');
        insertCat.run('Repair Bldg - Miscellaneous', 'Repar. de Edf. - Varios', '1178');
        insertCat.run('Repair Bldg - Playground', 'Repar. de Edf. - Área Infantil', '1179');
        insertCat.run('Repair Bldg - Plumbing', 'Repar. de Edf. - Plomería', '1180');
        insertCat.run('Repair Bldg - Prev/Sched Maint', 'Repar. de Edf. - Mant. Ant./Prog.', '1183');
        insertCat.run('Repair Bldg - Seating', 'Repar. de Edf. - Asientos', '1181');
        insertCat.run('Repair Bldg - Signage', 'Repar. de Edf. - Señalización', '1182');
        insertCat.run('Repair Bldg -Land/Lawn/Irrig', 'Repar. de Edf. - Paisaj./Césp./Rieg.', '1176');
        insertCat.run('Repair Equip - Beverage', 'Repar. de Eq. - Bebidas', '1154');
        insertCat.run('Repair Equip - Drive-Thr Equip', 'Repar. de Eq. - Eq. de Autoserv.', '1155');
        insertCat.run('Repair Equip - Food Prep/Hold', 'Repar. de Eq. - Prep./Ret. Alim.', '1156');
        insertCat.run('Repair Equip - Frig/Frzer/Thaw', 'Repar. de Eq. - Ref./Cong./Descon.', '1167');
        insertCat.run('Repair Equip - Grill', 'Repar. de Eq. - Parrilla', '1157');
        insertCat.run('Repair Equip - I.T.', 'Repar. de Eq. - I.T.', '1160');
        insertCat.run('Repair Equip - Ice Cream', 'Repar. de Eq. - Helado', '1158');
        insertCat.run('Repair Equip - Ice Machine', 'Repar. de Eq. - Máquina de Hielo', '1159');
        insertCat.run('Repair Equip - Miscellaneous', 'Repar. de Eq. - Varios', '1161');
        insertCat.run('Repair Equip - Open Fryer', 'Repar. de Eq. - Freidora Abierta', '1163');
        insertCat.run('Repair Equip - Pressure Fryer', 'Repar. de Eq. - Freidora Pres.', '1164');
        insertCat.run('Repair Equip - Prev/Sch Maint', 'Repar. de Eq. - Mant. Ant./Prog.', '1165');
        insertCat.run('Repair Equip - Shelving', 'Repar. de Eq. - Estanterías', '1169');
        insertCat.run('Repair Equip - Water Filtr.', 'Repar. de Eq. - Filtr. de Agua', '1170');
        insertCat.run('Repair Equip - Wlk-in Frig/Frz', 'Repar. de Eq. - Filtr. de Agua', '1166');
        insertCat.run('Repair General - Other', 'Reparación General - Otra', '1052');
        insertCat.run('Repairs', 'Repairs - Reparaciones', '1275');
        insertCat.run('Replacement Check', 'Cheque de reemplazo', '1078');
        insertCat.run('Retirement Admin Fees', 'Cargos adm. de jubilación', '1219');
        insertCat.run('Security Expense', 'Gastos de seguridad', '1092');
        insertCat.run('Service Amenities', 'Comodidades de servicio', '1258');
        insertCat.run('Swiped Credit Card Fees', 'Cargos de tarjeta de crédito (se pasó la tarjeta)', '1200');
        insertCat.run('TM Bus. Mileage(Non-Delivery)', null, '1321');
        insertCat.run('Team Member Retirement', 'Jubilación - Miem. Del Eq.', '1079');
        insertCat.run('Team Member Training Expense', 'Gastos de capacitación de Miembro del Equipo', '1153');
        insertCat.run('Theft Liability Insurance', 'Seguro de responsabilidad civil por robo', '1252');
        insertCat.run('Third Party Staffing', 'Personal de terceros', '1223');
        insertCat.run('Trailers', null, '1222');
        insertCat.run('Trash Compactors', 'Compactadores de basura', '1212');
        insertCat.run('Travel - Operators', 'Viaje - Operador', '1062');
        insertCat.run('Travel - Team Member', 'Viaje - Miembro Del Equipo', '1333');
        insertCat.run('Travel - team member', 'Viajes: Miembro del Equipo', '1250');
        insertCat.run('Uniforms', 'Uniformes', '1063');
        insertCat.run('Utilities - Deposit Paid', 'Servicios públicos: depósito pagado', '1260');
        insertCat.run('Utilities - Gas', 'Servicios públicos: gas', '1026');
        insertCat.run('Utilities - Trash Service', 'Servicios públicos: servicio de recolección de residuos', '1060');
        insertCat.run('Water & Sewage - Utility Co.', 'Servicios Públicos - Agua y Alcantarillado', '1066');
        insertCat.run('Withholding Tax- COR Only', null, '1327');
      })();
    }

    // Seed suppliers (only if table is empty)
    const supCount = db.prepare('SELECT COUNT(*) as c FROM gastos_suppliers').get().c;
    if (supCount === 0) {
      db.transaction(() => {
        const insertSup = db.prepare('INSERT INTO gastos_suppliers (name, inc_id) VALUES (?, ?)');
        insertSup.run('ABIGAIL PARKING', '1180489');
        insertSup.run('ACADEMIA ADVENTISTA PONCE', '1122449');
        insertSup.run('ACADEMIA CRISTO REY', '1110431');
        insertSup.run('ACADEMIA SANTA MARIA REINA', '1172304');
        insertSup.run('ACUEDUCTOS Y ALCANTARILLADOS', '1111470');
        insertSup.run('ADMINISTRACION DE TRIBUNALES', '1193255');
        insertSup.run('ADOBE', '1103153');
        insertSup.run('AIRAD PROMOTIONS', '1101019');
        insertSup.run('ALISS MONJITAS', '1119990');
        insertSup.run('ALL WAYS 99', '1156793');
        insertSup.run('ALMACEN NAVIDENO', '1115018');
        insertSup.run('ALQUILERES DHANEL', '1122448');
        insertSup.run('AMAZON', '1101384');
        insertSup.run('AMERICAN AIRLINES', '1131778');
        insertSup.run('AMERICAN EXPRESS', '1100431');
        insertSup.run('AMERICAN PETROLEUM', '1112566');
        insertSup.run('ANGEL GONZALEZ', '1153976');
        insertSup.run('ANTHROPIC', '1196650');
        insertSup.run('APPLE', '1169334');
        insertSup.run('ASG', '1191433');
        insertSup.run('AUTO ZONE', '1097932');
        insertSup.run('AZORE', '1103150');
        insertSup.run('BANCO POPULAR MERCHANT', '1105041');
        insertSup.run('BARCELONA WINE BAR', '1143394');
        insertSup.run('BARISTA EXPRESS PONCE', '1187482');
        insertSup.run('BARRAS JABON ARTESANAL', '1144446');
        insertSup.run('BASKIN ROBBINS', '1130908');
        insertSup.run('BDA', '1141728');
        insertSup.run('BELIEVE DESIGN', '1193262');
        insertSup.run('BEST BUY', '1091448');
        insertSup.run('BEST BUY', '1094024');
        insertSup.run('BEVERLY SOSA', '1196518');
        insertSup.run('BH ARTS & MEDIA', '1126595');
        insertSup.run('BRAVO CLEANING', '1196647');
        insertSup.run('BRYAN IRIZARRY', '1188245');
        insertSup.run('BRYAN IRRIZARY', '1191436');
        insertSup.run('BUFETE EMMANUELLI LLC', '1193257');
        insertSup.run('BURLINGTON', '1116092');
        insertSup.run('BUSINESS CARD SERVICES INC.', '1103088');
        insertSup.run('BYTYST', '1168942');
        insertSup.run('CADILLAC UNIFORM', '1089056');
        insertSup.run('CAFE DON JUAN', '1145540');
        insertSup.run('CAFE PRIETO', '1176026');
        insertSup.run('CANVA', '1139676');
        insertSup.run('CARIBBEAN CLEANERS XPRESS', '1198207');
        insertSup.run('CARIBBEAN LUMBER', '1127941');
        insertSup.run('CARIBBEAN SCHOOL INC.', '1164109');
        insertSup.run('CARIBE LOCK', '1126624');
        insertSup.run('CARLOS TIRADO ILLUSTRATION', '1155153');
        insertSup.run('CASA AGRICOLA EL CAFETAL', '1147987');
        insertSup.run('CFA FUNDRAISERS', '1159087');
        insertSup.run('CFA HOME OFFICE BACKSTAGE TOUR', '1110412');
        insertSup.run('CFA SUPPORT CENTER WAREHOUSE', '1097940');
        insertSup.run('CFSE', '1096711');
        insertSup.run('CFX PRODUCTS', '1103086');
        insertSup.run('CHASE BANK', '1094581');
        insertSup.run('CHEF CREATIONS', '1164046');
        insertSup.run('CHEF JOSE', '1123680');
        insertSup.run('CHEVRON', '1143405');
        insertSup.run('CHICK-FIL-A NEXT', '1172305');
        insertSup.run('CHICK-FIL-A NYC', '1169682');
        insertSup.run('CHICK-FIL-A REINA DEL SUR', '1096695');
        insertSup.run('CHICK-FIL-A WINNING HEARTS', '1147997');
        insertSup.run('CHILI\'S', '1153987');
        insertSup.run('CHIPOTLE', '1143415');
        insertSup.run('CLARK NATIONAL ACCOUNTS', '1135749');
        insertSup.run('CLARO', '1096700');
        insertSup.run('CLASE AREXIUS 2025', '1117299');
        insertSup.run('CLASE GRADUANDA HIKARY 2026', '1117301');
        insertSup.run('CLASE KAIROS 2027', '1203262');
        insertSup.run('CM SYSTEMS LLC', '1155317');
        insertSup.run('CM SYSTEMS-INTERNET', '1111477');
        insertSup.run('COCA COLA PUERTO RICO', '1094191');
        insertSup.run('COFFEE HOUSE', '1172247');
        insertSup.run('COLAO\' ESPRESSO BAR', '1172284');
        insertSup.run('COLEGIO LA MILAGROSA', '1144468');
        insertSup.run('COLEGIO PONCEÑO', '1181974');
        insertSup.run('COLEGIO SAGRADO CORAZON', '1108337');
        insertSup.run('COLEGIO SAN CONRADO', '1171806');
        insertSup.run('COLISEO DE PUERTO RICO', '1148076');
        insertSup.run('COMERCIO CASH & CARRY', '1138555');
        insertSup.run('COMPLIANCEMATE', '1195175');
        insertSup.run('CON LECHE', '1156794');
        insertSup.run('CONWASTE', '1094582');
        insertSup.run('COSTANERA', '1112557');
        insertSup.run('COSTCO WHOLESALE', '1116104');
        insertSup.run('D\'COFFEE SHOP', '1153986');
        insertSup.run('DAISY REYES RURGOS', '1096704');
        insertSup.run('DECOR ARTE', '1156797');
        insertSup.run('DELTA AIRLINES', '1140835');
        insertSup.run('DELTA DENTAL', '1135034');
        insertSup.run('DESARROLLO ECONOMICO', '1175893');
        insertSup.run('DESTAPESPR', '1188266');
        insertSup.run('DIGITAL OCEAN', '1208071');
        insertSup.run('DIS BOLERA CARIBE', '1159224');
        insertSup.run('DIVINE SPA', '1143459');
        insertSup.run('DJ LA MAQUINA', '1188261');
        insertSup.run('DON FRAPPE', '1156126');
        insertSup.run('DON MACETA INC', '1154745');
        insertSup.run('DR. MELENDEZ CONSULTING', '1131005');
        insertSup.run('DREAM\'S PARADISE', '1123236');
        insertSup.run('EASY COMMENT', '1188264');
        insertSup.run('ECOLAB', '1105277');
        insertSup.run('EDELCAR INC.', '1122854');
        insertSup.run('EL MONTE TOWN CENTER', '1176024');
        insertSup.run('EL TABLADO MEAT CENTER', '1186537');
        insertSup.run('ELECTRIC SERVICE CORP.', '1100893');
        insertSup.run('ENRIQUE QUESTELL', '1132762');
        insertSup.run('ESCUELA DR PILA', '1185937');
        insertSup.run('ESCUELA EPISCOPAL DE PONCE', '1148111');
        insertSup.run('ESCUELA LIBRE DE MUSICA', '1144471');
        insertSup.run('ESCUELA SUPERIOR JARDINES', '1144474');
        insertSup.run('ESTACIONAMIENTO METRO PLAZA', '1172246');
        insertSup.run('EXPEDIA', '1108338');
        insertSup.run('F.A.S.T. MEDICAL SUPPLIES', '1155940');
        insertSup.run('FARMACIAS DEBORAH', '1172244');
        insertSup.run('FERNANDO PEREIRA', '1098367');
        insertSup.run('FERR ACE VALOIS PAGAN', '1117297');
        insertSup.run('FERRETERIA EL GIGANTE', '1205097');
        insertSup.run('FIESTA WAREHOUSE', '1146573');
        insertSup.run('FINA CONSULTING GROUP LLC', '1094111');
        insertSup.run('FIRST MEDICAL', '1135032');
        insertSup.run('FIVE GUYS', '1143413');
        insertSup.run('FLORES MEJIAS CREATIVO', '1112586');
        insertSup.run('FLOWERS EXPRESS', '1098366');
        insertSup.run('FONDO DEL SEGURO DEL ESTADO', '1094580');
        insertSup.run('FRESHPOINT', '1096583');
        insertSup.run('FRONT LINE SAFETY', '1181023');
        insertSup.run('GABRIELA RIVERA SANCHEZ', '1123238');
        insertSup.run('GASKETGUY', '1190988');
        insertSup.run('GIANMAURO\'S GROUP LLC', '1179074');
        insertSup.run('GLAM PHOTOBOOTH', '1123239');
        insertSup.run('GLIMMERSEEK', '1207489');
        insertSup.run('GLOBAL INSURANCE AGENCY', '1099619');
        insertSup.run('GOGODADDY', '1103152');
        insertSup.run('GOOD CENTS R&M', '1107240');
        insertSup.run('GRAINGER', '1151486');
        insertSup.run('GULF LA RAMBLA', '1122007');
        insertSup.run('GWEN KELLAR', '1151482');
        insertSup.run('HACIENDA', '1193266');
        insertSup.run('HALO', '1099074');
        insertSup.run('HATO DON BENJA', '1159223');
        insertSup.run('HE>I', '1180470');
        insertSup.run('HELLOU.', '1151475');
        insertSup.run('HELLOU.', '1163825');
        insertSup.run('HENRY MONTANEZ', '1169734');
        insertSup.run('HNOS. SANTIAGO C&C MAYORISTA', '1169339');
        insertSup.run('HOLSUM DE PUERTO RICO', '1096624');
        insertSup.run('HOME DEPOT', '1096718');
        insertSup.run('HOUSE', '1188226');
        insertSup.run('HQJ PLUMBING SUPPLIES', '1193270');
        insertSup.run('HUDSON BOOKSELLERS', '1196026');
        insertSup.run('IKEA', '1156784');
        insertSup.run('JANI CLEAN', '1096629');
        insertSup.run('JARDINCENTRO SAN SEBASTIAN', '1144476');
        insertSup.run('JENI\'S SPLENDID ICE CREAMS', '1143408');
        insertSup.run('JOHNTIN CAFE', '1147984');
        insertSup.run('JOLLY WINGO CO', '1188223');
        insertSup.run('JTC KIDS RENTAL', '1151842');
        insertSup.run('JULIO SOSA', '1178210');
        insertSup.run('KAHOOT', '1205094');
        insertSup.run('KATHERINE CHUTE', '1193182');
        insertSup.run('KIARY MUSIC', '1188254');
        insertSup.run('KRISPY KREME', '1097929');
        insertSup.run('KUALOA RANCH', '1180469');
        insertSup.run('LA FACTORIA COMERCIAL', '1201143');
        insertSup.run('LA FONDA DE ANGELO', '1187483');
        insertSup.run('LA MANCHA DE PLATANO', '1196031');
        insertSup.run('LA OBRA MAESTRA', '1192057');
        insertSup.run('LA PARRILLA ARGENTINA', '1176027');
        insertSup.run('LA TERRAZA DEL TORO', '1202222');
        insertSup.run('LALA RESTAURANT', '1204935');
        insertSup.run('LAZ PARKING', '1143388');
        insertSup.run('LETS CELEBRATE PARTY RENTAL', '1130906');
        insertSup.run('LIC. SALVADOR MARQUEZ', '1163899');
        insertSup.run('LICK', '1181965');
        insertSup.run('LINDE', '1096628');
        insertSup.run('LONGHORN', '1153983');
        insertSup.run('LOOMIS', '1109543');
        insertSup.run('LUMA', '1103089');
        insertSup.run('MAC CENTER', '1103151');
        insertSup.run('MACRO LEGAL CONSULTING', '1175846');
        insertSup.run('MAHINA', '1180467');
        insertSup.run('MARCOS PIZZA', '1098368');
        insertSup.run('MARRIOTT', '1143456');
        insertSup.run('MARSHALLS', '1097935');
        insertSup.run('MASTERCLASS', '1190432');
        insertSup.run('MCDONALD\'S', '1151448');
        insertSup.run('ME SALVE', '1115069');
        insertSup.run('META', '1120002');
        insertSup.run('MICROSOFT', '1094583');
        insertSup.run('MIGUEL ANGEL JUSINO', '1157469');
        insertSup.run('MOFONGOBOWL FRANCHISE JUAN', '1163982');
        insertSup.run('MOOD MEDIA', '1139646');
        insertSup.run('MOSAICO RESTAURANT', '1138552');
        insertSup.run('MUNICIPIO DE JUANA DIAZ', '1169701');
        insertSup.run('NAHIRMIR LAUREANO TORRES CPA', '1139675');
        insertSup.run('NILEIKA CHERENA', '1157470');
        insertSup.run('NORIALYS MALDONADO', '1131763');
        insertSup.run('NOS GOZAMOS', '1123833');
        insertSup.run('NOTION', '1208646');
        insertSup.run('OFFICE DEPOT OFFICEMAX', '1096627');
        insertSup.run('OOBE UNIFORMS & APPAREL', '1097938');
        insertSup.run('OPENAI', '1148418');
        insertSup.run('ORTIZ & ORTIZ TRUCKING INC.', '1147492');
        insertSup.run('OSCAR ACUSTICO', '1155131');
        insertSup.run('OTORO SUSHI', '1187481');
        insertSup.run('PANADERIA REPOSTERIA GLENVIEW', '1180486');
        insertSup.run('PARTSTOWN', '1124076');
        insertSup.run('PEDRITO AIR CONDITIONING INC', '1121138');
        insertSup.run('PEPE GANGA', '1119973');
        insertSup.run('PF CHANGS', '1164072');
        insertSup.run('PIZZA HEAVEN', '1196029');
        insertSup.run('PIZZERIA DON QUIJOTE', '1153982');
        insertSup.run('PLAZA FOOD SYSTEMS', '1094110');
        insertSup.run('PLI CARD MARKETING SOLUTIONS', '1111514');
        insertSup.run('PONCEÑO VOLLEYBALL ACADEMY', '1148110');
        insertSup.run('PR COFFEE ROASTERS', '1096626');
        insertSup.run('PRIME JANITORIAL', '1151837');
        insertSup.run('PROGRESO CASH & CARRY', '1190079');
        insertSup.run('PROGRESSIVE', '1112589');
        insertSup.run('PROGRESSIVE SALES Y SERVICE', '1181020');
        insertSup.run('PROSOUNDCREW', '1140831');
        insertSup.run('PUEBLO', '1097931');
        insertSup.run('PUMA RAMBLA', '1103147');
        insertSup.run('QDOBA MEXICAN EATS', '1183645');
        insertSup.run('REFRIELECTRIC', '1168928');
        insertSup.run('RENAISSANCE HOTELS', '1143457');
        insertSup.run('RENTOKIL', '1103090');
        insertSup.run('RESTAURANTE EL TURPIAL BORICUA', '1144438');
        insertSup.run('RESTAURANTE EL TURPIAL BORICUA', '1168918');
        insertSup.run('RET ENVIRONMENTAL TECHNOLOGIES', '1110433');
        insertSup.run('ROBERTO MALDONADO', '1151474');
        insertSup.run('ROGER ELECTRIC', '1100429');
        insertSup.run('ROMERO RESTAURANT GROUPS', '1181021');
        insertSup.run('ROTULOS FMC', '1101629');
        insertSup.run('RUBERO BROTHERS INC.', '1175888');
        insertSup.run('RUSH DESIGN LLC', '1148070');
        insertSup.run('SALINAS STORAGE', '1187478');
        insertSup.run('SALINAS STORE', '1187479');
        insertSup.run('SALSIPUEDES AVENTURAS', '1154746');
        insertSup.run('SALVADOR MÁRQUEZ COLÓN', '1161822');
        insertSup.run('SAMS CLUB', '1094104');
        insertSup.run('SAN LUCAS', '1101906');
        insertSup.run('SELECTOS', '1138558');
        insertSup.run('SEPTIX', '1097934');
        insertSup.run('SERVICIOS PROFESIONALES DJ', '1123679');
        insertSup.run('SHAKE SHACK', '1176023');
        insertSup.run('SHERWIN WILLIAMS', '1104555');
        insertSup.run('SHOES FOR CREWS', '1152758');
        insertSup.run('SIMPRESS CLEANERS', '1147491');
        insertSup.run('SOSA\'S MUSIC', '1137018');
        insertSup.run('SOUND & VISUAL SERVICE', '1169708');
        insertSup.run('SOUTH VOLLEYBALL ACADEMY', '1185933');
        insertSup.run('SPIRIT AIRLINES', '1143454');
        insertSup.run('STRONG INC.', '1096696');
        insertSup.run('SUPERMAX', '1188230');
        insertSup.run('SUPPLY CENTRAL', '1175883');
        insertSup.run('T-MOBILE', '1132499');
        insertSup.run('TARGET', '1180471');
        insertSup.run('TAYLOR SALES & SERVICES', '1164032');
        insertSup.run('TEXACO', '1138551');
        insertSup.run('TGI FRIDAYS', '1143390');
        insertSup.run('THE APPROACH', '1208637');
        insertSup.run('THE CHICKEN SOLUTION', '1103149');
        insertSup.run('THE COFFEE SPOT', '1154018');
        insertSup.run('THE LITTLE THINGS MARKET', '1107267');
        insertSup.run('THINKREATIVE', '1124679');
        insertSup.run('TODO BIEN LLC', '1094584');
        insertSup.run('TORRES MACHINE SHOP SERVICE', '1180488');
        insertSup.run('TOVI\'S T-SHIRTS', '1161259');
        insertSup.run('TRANSPORTE MEDINA', '1112564');
        insertSup.run('TRANSPORTE MEDINA', '1113498');
        insertSup.run('TRES MONJITAS', '1096623');
        insertSup.run('TRES MONJITAS', '1096581');
        insertSup.run('TRIPLE S', '1185924');
        insertSup.run('TROFEOS Y PLACAS JAPS', '1169340');
        insertSup.run('TROPICAL IRRIGATON P.R. INC.', '1153989');
        insertSup.run('UBER', '1143422');
        insertSup.run('UNITED STATES POSTAL SERVICE', '1112558');
        insertSup.run('UNITED SURETY & INDEMNITY', '1193187');
        insertSup.run('UPR MAYAGUEZ', '1169687');
        insertSup.run('UTOPIA', '1193354');
        insertSup.run('VIKASS TOWERS CORPORATION', '1154071');
        insertSup.run('VSBL', '1094579');
        insertSup.run('WALGREENS', '1097923');
        insertSup.run('WALMART', '1097920');
        insertSup.run('WEST MARINE', '1157471');
        insertSup.run('WINGSTOP', '1111457');
        insertSup.run('WORKSTREAM', '1100432');
        insertSup.run('XAVIER RIVERA', '1168934');
        insertSup.run('YCS PR CORP.', '1108862');
      })();
    }
  } catch (e) { console.log('v1.22 migration note:', e.message); }

  // v1.23 — Payment ID from Inc. website on gastos invoices
  if (!hasColumn('gastos_invoices', 'inc_payment_id')) {
    db.exec("ALTER TABLE gastos_invoices ADD COLUMN inc_payment_id TEXT");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // v1.24 — Registered Apprenticeship Program Module (12 tables + seed data)
  // Registration #2025-PR-135424, approved Aug 19, 2025
  // ═══════════════════════════════════════════════════════════════════════════
  try {
    // ── Config Tables ──────────────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS appr_tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        occupation TEXT NOT NULL,
        rapids_code TEXT NOT NULL,
        onet_code TEXT NOT NULL,
        approach TEXT NOT NULL CHECK(approach IN ('competency','time','hybrid')),
        term_years INTEGER NOT NULL,
        ojl_hours_required INTEGER NOT NULL,
        ri_hours_per_year INTEGER NOT NULL,
        probation_hours INTEGER NOT NULL,
        journeyworker_wage REAL NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS appr_work_processes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_id INTEGER NOT NULL REFERENCES appr_tracks(id),
        category TEXT NOT NULL,
        task_label TEXT NOT NULL,
        approx_hours INTEGER,
        sort_order INTEGER NOT NULL DEFAULT 0
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS appr_ri_courses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_id INTEGER NOT NULL REFERENCES appr_tracks(id),
        title TEXT NOT NULL,
        contact_hours INTEGER NOT NULL,
        provider_name TEXT,
        provider_address TEXT,
        provider_email TEXT,
        provider_phone TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS appr_wage_schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_id INTEGER NOT NULL REFERENCES appr_tracks(id),
        tier INTEGER NOT NULL,
        ojl_hours_from INTEGER NOT NULL,
        ojl_hours_to INTEGER,
        hourly_rate REAL NOT NULL,
        UNIQUE(track_id, tier)
      )
    `);

    // ── Enrollment & Registry ──────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS appr_enrollments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL REFERENCES employees(id),
        track_id INTEGER NOT NULL REFERENCES appr_tracks(id),
        journeyworker_id INTEGER REFERENCES employees(id),
        enrollment_date TEXT NOT NULL,
        probation_end_date TEXT NOT NULL,
        expected_completion_date TEXT NOT NULL,
        actual_completion_date TEXT,
        status TEXT NOT NULL DEFAULT 'probation'
          CHECK(status IN ('probation','active','suspended','cancelled','completed')),
        rapids_apprentice_id TEXT,
        current_wage_tier INTEGER NOT NULL DEFAULT 1,
        prior_hourly_wage REAL,
        credit_hours INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(employee_id, track_id)
      )
    `);

    // ── Signatures ─────────────────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS appr_formal_signatures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enrollment_id INTEGER NOT NULL REFERENCES appr_enrollments(id),
        document_type TEXT NOT NULL
          CHECK(document_type IN ('agreement','wage_change','suspension','cancellation','completion')),
        signer_role TEXT NOT NULL
          CHECK(signer_role IN ('apprentice','sponsor_1','sponsor_2','guardian')),
        signature_type TEXT NOT NULL CHECK(signature_type IN ('drawn','photo')),
        signature_file_path TEXT NOT NULL,
        signed_by INTEGER REFERENCES users(id),
        signed_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS appr_supervisor_approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enrollment_id INTEGER NOT NULL REFERENCES appr_enrollments(id),
        approval_type TEXT NOT NULL CHECK(approval_type IN ('task','period_summary')),
        reference_id INTEGER NOT NULL,
        period_start TEXT,
        period_end TEXT,
        approved_by INTEGER NOT NULL REFERENCES users(id),
        approved_at TEXT NOT NULL DEFAULT (datetime('now')),
        notes TEXT
      )
    `);

    // ── Hours & Progress Tracking ──────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS appr_ojl_timesheet_imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enrollment_id INTEGER NOT NULL REFERENCES appr_enrollments(id),
        pay_period_start TEXT NOT NULL,
        pay_period_end TEXT NOT NULL,
        pdf_file_path TEXT NOT NULL,
        total_hours_extracted REAL NOT NULL,
        ai_extraction_json TEXT,
        imported_by INTEGER REFERENCES users(id),
        imported_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS appr_task_completions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enrollment_id INTEGER NOT NULL REFERENCES appr_enrollments(id),
        work_process_id INTEGER NOT NULL REFERENCES appr_work_processes(id),
        completed_date TEXT NOT NULL,
        supervisor_approval_id INTEGER REFERENCES appr_supervisor_approvals(id),
        evidence_file_path TEXT,
        notes TEXT,
        UNIQUE(enrollment_id, work_process_id)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS appr_ri_attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enrollment_id INTEGER NOT NULL REFERENCES appr_enrollments(id),
        course_id INTEGER NOT NULL REFERENCES appr_ri_courses(id),
        session_date TEXT NOT NULL,
        hours_attended REAL NOT NULL,
        instructor_name TEXT,
        logged_by INTEGER REFERENCES users(id),
        approval_id INTEGER REFERENCES appr_supervisor_approvals(id)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS appr_period_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enrollment_id INTEGER NOT NULL REFERENCES appr_enrollments(id),
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        total_ojl_hours REAL NOT NULL DEFAULT 0,
        tasks_completed_count INTEGER NOT NULL DEFAULT 0,
        summary_approval_id INTEGER REFERENCES appr_supervisor_approvals(id),
        generated_pdf_path TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // ── Compliance & Documents ─────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS appr_compliance_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enrollment_id INTEGER NOT NULL REFERENCES appr_enrollments(id),
        event_type TEXT NOT NULL CHECK(event_type IN (
          'agreement_submission','probation_evaluation','wage_tier_advancement',
          'ri_hours_check','annual_progress_review','status_change_notification')),
        due_date TEXT NOT NULL,
        completed_date TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','completed','overdue','waived')),
        notified_at TEXT,
        notes TEXT
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS appr_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enrollment_id INTEGER NOT NULL REFERENCES appr_enrollments(id),
        doc_type TEXT NOT NULL CHECK(doc_type IN
          ('eta671','progress','completion','wage_change','rapids_export')),
        file_path TEXT NOT NULL,
        generated_by INTEGER REFERENCES users(id),
        generated_at TEXT NOT NULL DEFAULT (datetime('now')),
        version INTEGER NOT NULL DEFAULT 1
      )
    `);

    // ── Seed Data ──────────────────────────────────────────────────────────
    const trackCount = db.prepare('SELECT COUNT(*) AS c FROM appr_tracks').get().c;
    if (trackCount === 0) {
      db.transaction(() => {
        // ── 4 Apprenticeship Tracks ──────────────────────────────────────
        const insertTrack = db.prepare(`
          INSERT INTO appr_tracks (code, title, occupation, rapids_code, onet_code,
            approach, term_years, ojl_hours_required, ri_hours_per_year, probation_hours, journeyworker_wage)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        insertTrack.run('shift_lead', 'Shift Lead', 'Manager, Food Service', '0593CB', '11-9051.00', 'competency', 2, 4000, 144, 1000, 13.00);
        insertTrack.run('food_helper', 'Food Helper', 'Chief, Cook (Food Service Helper)', '1053', '35-9011.00', 'competency', 1, 2000, 144, 500, 11.50);
        insertTrack.run('trainer', 'Trainer', 'Educator and Trainer', '1079', '13-1151.00', 'time', 1, 2000, 144, 500, 12.00);
        insertTrack.run('boh_team', 'BOH Team', 'Baker, Pizza (Restaurant)', '0883', '35-2011.00', 'time', 1, 2000, 144, 500, 11.50);

        // ── Wage Schedules ───────────────────────────────────────────────
        const insertWage = db.prepare('INSERT INTO appr_wage_schedules (track_id, tier, ojl_hours_from, ojl_hours_to, hourly_rate) VALUES (?, ?, ?, ?, ?)');
        // Shift Lead: 2 tiers
        insertWage.run(1, 1, 0, 2000, 12.00);
        insertWage.run(1, 2, 2000, 4000, 12.50);
        // Food Helper: 2 tiers
        insertWage.run(2, 1, 0, 1000, 11.00);
        insertWage.run(2, 2, 1000, 2000, 11.25);
        // Trainer: 2 tiers
        insertWage.run(3, 1, 0, 1000, 11.50);
        insertWage.run(3, 2, 1000, 2000, 11.75);
        // BOH Team: 2 tiers
        insertWage.run(4, 1, 0, 1000, 11.00);
        insertWage.run(4, 2, 1000, 2000, 11.25);

        // ── RI Courses (from Related Instruction Outlines) ───────────────
        const RI_PROVIDER = 'DR MELENDEZ CONSULTING LLC';
        const RI_ADDR = '1576 AVE. JESUS T PINERO SAN JUAN PR 00921';
        const RI_EMAIL = 'INFO@DRMELENDEZCONSULTING.COM';
        const RI_PHONE = '787-908-0130';
        const insertRI = db.prepare(`
          INSERT INTO appr_ri_courses (track_id, title, contact_hours, provider_name, provider_address, provider_email, provider_phone, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        // Shift Lead RI (288 hrs total)
        insertRI.run(1, 'Fundamentals of Leadership', 50, RI_PROVIDER, RI_ADDR, RI_EMAIL, RI_PHONE, 1);
        insertRI.run(1, 'Retail Management & Sales Operations', 50, RI_PROVIDER, RI_ADDR, RI_EMAIL, RI_PHONE, 2);
        insertRI.run(1, 'Performance Management and Feedback', 54, RI_PROVIDER, RI_ADDR, RI_EMAIL, RI_PHONE, 3);
        insertRI.run(1, 'Problem Solving and Decision Making', 50, RI_PROVIDER, RI_ADDR, RI_EMAIL, RI_PHONE, 4);
        insertRI.run(1, 'Training and Development of New Employees', 56, RI_PROVIDER, RI_ADDR, RI_EMAIL, RI_PHONE, 5);
        insertRI.run(1, 'Safety and Security Standards for Fast Food Operations', 28, RI_PROVIDER, RI_ADDR, RI_EMAIL, RI_PHONE, 6);
        // Food Helper RI (144 hrs total)
        insertRI.run(2, 'Foundations of Customer Service and Chick-fil-A Culture', 25, RI_PROVIDER, RI_ADDR, RI_EMAIL, RI_PHONE, 1);
        insertRI.run(2, 'Effective Communication and Teamwork', 25, RI_PROVIDER, RI_ADDR, RI_EMAIL, RI_PHONE, 2);
        insertRI.run(2, 'Performance Management and Feedback', 27, RI_PROVIDER, RI_ADDR, RI_EMAIL, RI_PHONE, 3);
        insertRI.run(2, 'Problem Solving and Decision Making', 25, RI_PROVIDER, RI_ADDR, RI_EMAIL, RI_PHONE, 4);
        insertRI.run(2, 'On-the-Job Training and Talent Development', 28, RI_PROVIDER, RI_ADDR, RI_EMAIL, RI_PHONE, 5);
        insertRI.run(2, 'Safety and Security Standards for Fast Food Operations', 14, RI_PROVIDER, RI_ADDR, RI_EMAIL, RI_PHONE, 6);
        // Trainer RI (144 hrs total)
        insertRI.run(3, 'Fundamentals of Leadership', 25, RI_PROVIDER, RI_ADDR, RI_EMAIL, RI_PHONE, 1);
        insertRI.run(3, 'Retail Management & Sales Operations', 25, RI_PROVIDER, RI_ADDR, RI_EMAIL, RI_PHONE, 2);
        insertRI.run(3, 'Performance Management and Feedback', 27, RI_PROVIDER, RI_ADDR, RI_EMAIL, RI_PHONE, 3);
        insertRI.run(3, 'Problem Solving and Decision Making', 25, RI_PROVIDER, RI_ADDR, RI_EMAIL, RI_PHONE, 4);
        insertRI.run(3, 'Training and Development of New Employees', 28, RI_PROVIDER, RI_ADDR, RI_EMAIL, RI_PHONE, 5);
        insertRI.run(3, 'Safety and Security Standards for Fast Food Operations', 14, RI_PROVIDER, RI_ADDR, RI_EMAIL, RI_PHONE, 6);
        // BOH Team RI (144 hrs total)
        insertRI.run(4, 'Institutional Food Workers', 25, RI_PROVIDER, RI_ADDR, RI_EMAIL, RI_PHONE, 1);
        insertRI.run(4, 'Foodservice Systems Administration/Management', 25, RI_PROVIDER, RI_ADDR, RI_EMAIL, RI_PHONE, 2);
        insertRI.run(4, 'Food Preparation/Professional Cooking/Kitchen Assistant', 27, RI_PROVIDER, RI_ADDR, RI_EMAIL, RI_PHONE, 3);
        insertRI.run(4, 'Performance Management and Feedback', 25, RI_PROVIDER, RI_ADDR, RI_EMAIL, RI_PHONE, 4);
        insertRI.run(4, 'Problem Solving and Decision Making', 28, RI_PROVIDER, RI_ADDR, RI_EMAIL, RI_PHONE, 5);
        insertRI.run(4, 'Safety and Security Standards for Fast Food Operations', 14, RI_PROVIDER, RI_ADDR, RI_EMAIL, RI_PHONE, 6);

        // ── Work Process Tasks (from Appendix A of Standards) ────────────
        const insertWP = db.prepare('INSERT INTO appr_work_processes (track_id, category, task_label, approx_hours, sort_order) VALUES (?, ?, ?, ?, ?)');
        let s = 0; // sort counter

        // ──── Track 1: Shift Lead (Manager, Food Service) ────────────────
        s = 0;
        insertWP.run(1, 'Maintain regulatory or compliance documentation', 'Keep records required by government agencies regarding sanitation or food subsidies', null, ++s);
        insertWP.run(1, 'Maintain operational records', 'Maintain food and equipment inventories and keep inventory records', null, ++s);
        insertWP.run(1, 'Maintain operational records', 'Record the number, type, and cost of items sold to determine which items may be unpopular or less profitable', null, ++s);
        insertWP.run(1, 'Manage inventories of products or organizational resources', 'Maintain food and equipment inventories and keep inventory records', null, ++s);
        insertWP.run(1, 'Resolve customer complaints or problems', 'Investigate and resolve complaints regarding food quality, service, or accommodations', null, ++s);
        insertWP.run(1, 'Evaluate quality of materials and products', 'Schedule and receive food and beverage deliveries, checking delivery contents to verify product quality and quantity', null, ++s);
        insertWP.run(1, 'Evaluate quality of materials and products', 'Test cooked food by tasting and smelling it to ensure palatability and flavor conformity', null, ++s);
        insertWP.run(1, 'Monitor organizational procedures to ensure proper functioning', 'Monitor food preparation methods, portion sizes, and garnishing and presentation of food to ensure that food is prepared and presented in an acceptable manner', null, ++s);
        insertWP.run(1, 'Schedule products or material transportation', 'Schedule and receive food and beverage deliveries, checking delivery contents to verify product quality and quantity', null, ++s);
        insertWP.run(1, 'Manage guest services', 'Coordinate assignments of cooking personnel to ensure economical use of food and timely preparation', null, ++s);
        insertWP.run(1, 'Manage guest services', 'Plan menus and food utilization, based on anticipated number of guests, nutritional value, palatability, popularity, and costs', null, ++s);
        insertWP.run(1, 'Collect payments for goods or services', 'Count money and make bank deposits', null, ++s);
        insertWP.run(1, 'Monitor organizational compliance with regulations', 'Monitor compliance with health and fire regulations regarding food preparation and serving and building maintenance', null, ++s);
        insertWP.run(1, 'Provide basic information to guests, visitors, or clients', 'Greet guests, escort them to their seats, and present them with menus', null, ++s);
        insertWP.run(1, 'Provide basic information to guests, visitors, or clients', 'Manage reservations', null, ++s);
        insertWP.run(1, 'Develop organizational policies and programs', 'Establish standards for personnel performance and customer service', null, ++s);
        insertWP.run(1, 'Perform manual service or maintenance tasks', 'Perform food preparation or service tasks, such as cooking, clearing tables, and serving food and drinks when necessary', null, ++s);
        insertWP.run(1, 'Prepare staff schedules or work assignments', 'Schedule staff hours and assign duties', null, ++s);
        insertWP.run(1, 'Estimate cost or material requirements', 'Estimate food and beverage consumption to anticipate amounts to be purchased or requisitioned', null, ++s);
        insertWP.run(1, 'Direct facility maintenance or repair activities', 'Arrange for equipment maintenance and repairs, and coordinate services such as waste removal and pest control', null, ++s);
        insertWP.run(1, 'Analyze data to inform operational decisions or activities', 'Review menus and analyze recipes to determine labor and overhead costs and assign prices to menu items', null, ++s);
        insertWP.run(1, 'Analyze data to inform operational decisions or activities', 'Review work procedures and operational problems to determine ways to improve service, performance, or safety', null, ++s);
        insertWP.run(1, 'Negotiate sales or lease agreements for products or services', 'Schedule the use of facilities or catering services for events and negotiate details of arrangements with clients', null, ++s);
        insertWP.run(1, 'Schedule activities or facility use', 'Schedule the use of facilities or catering services for events', null, ++s);
        insertWP.run(1, 'Evaluate employee performance', 'Organize and direct worker training programs, resolve personnel problems, hire new staff, and evaluate employee performance', null, ++s);
        insertWP.run(1, 'Manage human resources activities', 'Organize and direct worker training programs, resolve personnel problems, hire new staff, and evaluate employee performance', null, ++s);
        insertWP.run(1, 'Recommend organizational process or policy changes', 'Review work procedures and operational problems to determine ways to improve service, performance, or safety', null, ++s);
        insertWP.run(1, 'Determine resource needs', 'Assess staffing needs and recruit staff', null, ++s);
        insertWP.run(1, 'Purchase materials, equipment, or other resources', 'Order and purchase equipment and supplies', null, ++s);
        insertWP.run(1, 'Recruit personnel', 'Assess staffing needs and recruit staff', null, ++s);

        // ──── Track 2: Food Helper (Chief, Cook / Food Service Helper) ───
        s = 0;
        insertWP.run(2, 'Serve food or beverages', 'Serve food and drinks to patrons', null, ++s);
        insertWP.run(2, 'Serve food or beverages', 'Perform serving, cleaning, or stocking duties in dining room to facilitate customer service', null, ++s);
        insertWP.run(2, 'Serve food or beverages', 'Serve food to customers when waiters or waitresses need assistance', null, ++s);
        insertWP.run(2, 'Clean food service areas', 'Wipe tables and seats with dampened cloths', null, ++s);
        insertWP.run(2, 'Clean food service areas', 'Clean and polish counters, shelves, walls, furniture, or equipment in food service areas and mop or vacuum floors', null, ++s);
        insertWP.run(2, 'Collect dirty dishes or other tableware', 'Scrape and stack dirty trays and carry them to the kitchen for cleaning', null, ++s);
        insertWP.run(2, 'Collect dirty dishes or other tableware', 'Clean up spilled food or drink or broken dishes and remove empty bottles and trash', null, ++s);
        insertWP.run(2, 'Operate cash registers', 'Run cash registers', null, ++s);
        insertWP.run(2, 'Arrange tables or dining areas', 'Set tables with clean linens, condiments, or other supplies', null, ++s);
        insertWP.run(2, 'Assist customers to ensure comfort or safety', 'Greet and seat customers', null, ++s);
        insertWP.run(2, 'Greet customers, patrons, or visitors', 'Greet and seat customers', null, ++s);
        insertWP.run(2, 'Usher patrons to seats or exits', 'Greet and seat customers', null, ++s);
        insertWP.run(2, 'Maintain food, beverage, or equipment inventories', 'Maintain adequate supplies of items such as clean silverware and trays', null, ++s);
        insertWP.run(2, 'Stock serving stations or dining areas with food or supplies', 'Fill beverage or ice dispensers', null, ++s);
        insertWP.run(2, 'Stock serving stations or dining areas with food or supplies', 'Stock cabinets or serving areas with condiments and refill condiment containers', null, ++s);
        insertWP.run(2, 'Stock serving stations or dining areas with food or supplies', 'Replenish supplies of food or equipment at steam tables or service bars', null, ++s);
        insertWP.run(2, 'Provide customers with general information or assistance', 'Locate items requested by customers', null, ++s);
        insertWP.run(2, 'Move equipment, supplies or food to required locations', 'Carry food trays or silverware from kitchens or supply departments to serving counters', null, ++s);
        insertWP.run(2, 'Move equipment, supplies or food to required locations', 'Carry trays from food counters to tables for patrons', null, ++s);
        insertWP.run(2, 'Store supplies or goods in kitchens or storage areas', 'Perform serving, cleaning, or stocking duties to facilitate customer service', null, ++s);
        insertWP.run(2, 'Store supplies or goods in kitchens or storage areas', 'Stock refrigerating units with bottled drinks or replace empty soda bibs', null, ++s);
        insertWP.run(2, 'Clean facilities or work areas', 'Perform serving, cleaning, or stocking duties to facilitate customer service', null, ++s);
        insertWP.run(2, 'Clean tableware', 'Wash trays or other serving equipment', null, ++s);
        insertWP.run(2, 'Add garnishes to food', 'Garnish food and position them on tables to make them visible and accessible', null, ++s);
        insertWP.run(2, 'Arrange food for serving', 'Garnish food and position them on tables to make them visible and accessible', null, ++s);
        insertWP.run(2, 'Clean food preparation areas, facilities, or equipment', 'Clean and polish counters, shelves, walls, furniture, or equipment in food service areas and mop or vacuum floors', null, ++s);

        // ──── Track 3: Trainer (Educator and Trainer) ────────────────────
        s = 0;
        insertWP.run(3, 'Coordinate training activities', 'Obtain, organize, or develop training procedure manuals, guides, or course materials', 100, ++s);
        insertWP.run(3, 'Coordinate training activities', 'Design, plan, organize, or direct orientation and training programs for employees or customers', 100, ++s);
        insertWP.run(3, 'Coordinate training activities', 'Develop alternative training methods if expected improvements are not seen', 100, ++s);
        insertWP.run(3, 'Coordinate training activities', 'Evaluate training materials prepared by instructors, such as outlines, text, or handouts', 100, ++s);
        insertWP.run(3, 'Coordinate training activities', 'Select and assign instructors to conduct training', 50, ++s);
        insertWP.run(3, 'Coordinate training activities', 'Schedule classes based on the availability of classrooms, equipment, or instructors', 50, ++s);
        insertWP.run(3, 'Develop training materials', 'Obtain, organize, or develop training procedure manuals, guides, or course materials', 75, ++s);
        insertWP.run(3, 'Develop training materials', 'Design, plan, organize, or direct orientation and training programs', 100, ++s);
        insertWP.run(3, 'Develop training materials', 'Select and assign instructors to conduct training', 75, ++s);
        insertWP.run(3, 'Train personnel to enhance job skills', 'Present information with a variety of instructional techniques such as role playing, simulations, team exercises, group discussions, videos, or lectures', 300, ++s);
        insertWP.run(3, 'Train personnel to enhance job skills', 'Offer specific training programs to help workers maintain or improve job skills', 300, ++s);
        insertWP.run(3, 'Conduct surveys in organizations', 'Evaluate modes of training delivery to optimize training effectiveness, costs, or environmental impacts', 50, ++s);
        insertWP.run(3, 'Conduct surveys in organizations', 'Assess training needs through surveys, interviews with employees, focus groups, or consultation with managers', 50, ++s);
        insertWP.run(3, 'Evaluate training programs, instructors, or materials', 'Monitor, evaluate, or record training activities or program effectiveness', 50, ++s);
        insertWP.run(3, 'Evaluate training programs, instructors, or materials', 'Evaluate training materials prepared by instructors', 50, ++s);
        insertWP.run(3, 'Evaluate training programs, instructors, or materials', 'Supervise, evaluate, or refer instructors to skill development classes', 50, ++s);
        insertWP.run(3, 'Evaluate effectiveness of personnel policies or practices', 'Monitor, evaluate, or record training activities or program effectiveness', 50, ++s);
        insertWP.run(3, 'Train personnel on managerial topics', 'Devise programs to develop executive potential among employees in lower-level positions', 50, ++s);
        insertWP.run(3, 'Update professional knowledge', 'Keep up with developments in the area of expertise by reading current journals, books, or magazine articles', 50, ++s);
        insertWP.run(3, 'Update professional knowledge', 'Attend meetings or seminars to obtain information for use in training programs', 50, ++s);
        insertWP.run(3, 'Coordinate personnel recruitment activities', 'Coordinate recruitment and placement of training program participants', 50, ++s);
        insertWP.run(3, 'Supervise employees', 'Supervise, evaluate, or refer team members to skill development classes', 50, ++s);
        insertWP.run(3, 'Train personnel in organizational or compliance procedures', 'Develop or implement training programs related to efficiency, recycling, or other issues with environmental impacts', 100, ++s);

        // ──── Track 4: BOH Team (Baker, Pizza / Restaurant) ──────────────
        s = 0;
        insertWP.run(4, 'Order materials, supplies, or equipment', 'Order and take delivery of supplies', 50, ++s);
        insertWP.run(4, 'Cook foods', 'Cook the exact number of items ordered by each customer, working on several different orders simultaneously', 150, ++s);
        insertWP.run(4, 'Cook foods', 'Prepare specialty foods such as grilled or fried chicken, sandwiches, nuggets, salads, mac and cheese, and desserts', 150, ++s);
        insertWP.run(4, 'Cook foods', 'Operate large-volume cooking equipment such as grills, deep-fat fryers, or griddles', 150, ++s);
        insertWP.run(4, 'Cook foods', 'Read food order slips or receive verbal instructions and prepare and cook food according to instructions', 150, ++s);
        insertWP.run(4, 'Cook foods', 'Cook and package batches of food such as sandwiches or fried chicken, prepared to order or kept warm until sold', 150, ++s);
        insertWP.run(4, 'Cook foods', 'Pre-cook items such as bacon, prepare them for later use', 150, ++s);
        insertWP.run(4, 'Prepare food for cooking or serving', 'Wash, cut, and prepare foods designated for cooking', 100, ++s);
        insertWP.run(4, 'Clean food preparation areas, facilities, or equipment', 'Clean food preparation areas, cooking surfaces, and utensils', 100, ++s);
        insertWP.run(4, 'Clean food preparation areas, facilities, or equipment', 'Maintain sanitation, health, and safety standards in work areas', 100, ++s);
        insertWP.run(4, 'Serve food or beverages', 'Prepare and serve beverages such as coffee or fountain drinks', 25, ++s);
        insertWP.run(4, 'Serve food or beverages', 'Serve orders for customers at windows, counters, or tables', 25, ++s);
        insertWP.run(4, 'Prepare hot or cold beverages', 'Prepare and serve beverages such as coffee or fountain drinks', 50, ++s);
        insertWP.run(4, 'Stock serving stations or dining areas with food or supplies', 'Clean, stock, and restock workstations and display cases', 100, ++s);
        insertWP.run(4, 'Prepare bread or dough', 'Prepare dough, following recipe', 100, ++s);
        insertWP.run(4, 'Check the quality of foods or supplies', 'Verify that prepared food meets requirements for quality and quantity', 150, ++s);
        insertWP.run(4, 'Measure ingredients', 'Measure ingredients required for specific food items', 100, ++s);
        insertWP.run(4, 'Mix ingredients', 'Mix ingredients such as cookies, brownies, and biscuits', 100, ++s);
        insertWP.run(4, 'Coordinate timing of food production activities', 'Schedule activities and equipment for use with managers, using information about daily menus to help coordinate cooking times', 100, ++s);
      })();
    }
  } catch (e) { console.log('v1.24 apprenticeship migration note:', e.message); }

  // ═══════════════════════════════════════════════════════════════════════════
  // v1.25 — Apprenticeship: actual wage tracking + wage history
  // ═══════════════════════════════════════════════════════════════════════════
  try {
    // Add current_hourly_wage to enrollments if missing
    if (!hasColumn('appr_enrollments', 'current_hourly_wage')) {
      db.exec(`ALTER TABLE appr_enrollments ADD COLUMN current_hourly_wage REAL`);
      // Backfill from wage schedule tier 1
      db.exec(`
        UPDATE appr_enrollments
        SET current_hourly_wage = (
          SELECT ws.hourly_rate FROM appr_wage_schedules ws
          WHERE ws.track_id = appr_enrollments.track_id
            AND ws.tier = appr_enrollments.current_wage_tier
        )
        WHERE current_hourly_wage IS NULL
      `);
    }

    // Wage history table — log every wage change
    db.exec(`
      CREATE TABLE IF NOT EXISTS appr_wage_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enrollment_id INTEGER NOT NULL REFERENCES appr_enrollments(id),
        previous_wage REAL,
        new_wage REAL NOT NULL,
        previous_tier INTEGER,
        new_tier INTEGER NOT NULL,
        reason TEXT NOT NULL CHECK(reason IN ('enrollment','tier_advancement','manual_adjustment','correction')),
        changed_by INTEGER REFERENCES users(id),
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  } catch (e) { console.log('v1.25 wage tracking migration note:', e.message); }

  // v1.26 — Performance indexes for core queries
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_time_off_taken_emp_type ON time_off_taken(employee_id, type);
      CREATE INDEX IF NOT EXISTS idx_accruals_employee ON accruals(employee_id);
      CREATE INDEX IF NOT EXISTS idx_monthly_hours_emp_year ON monthly_hours(employee_id, year, month);
      CREATE INDEX IF NOT EXISTS idx_employees_status ON employees(status);
      CREATE INDEX IF NOT EXISTS idx_scorecard_entries_month ON scorecard_entries(month);
      CREATE INDEX IF NOT EXISTS idx_gastos_invoices_status ON gastos_invoices(status);
      CREATE INDEX IF NOT EXISTS idx_gastos_invoices_period ON gastos_invoices(business_period_start);
      CREATE INDEX IF NOT EXISTS idx_users_employee_id ON users(employee_id);
    `);
  } catch (e) { console.log('v1.26 index migration note:', e.message); }

  // v1.27 — Audit log table for tracking all write operations
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        username TEXT,
        action TEXT NOT NULL,
        resource TEXT NOT NULL,
        resource_id TEXT,
        details TEXT,
        ip_address TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
      CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource, resource_id);
    `);
  } catch (e) { console.log('v1.27 audit log migration note:', e.message); }

  // v1.28 — API usage tracking for cost monitoring & rate limiting
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        user_id INTEGER,
        username TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        estimated_cost REAL DEFAULT 0,
        model TEXT,
        status TEXT DEFAULT 'success',
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_api_usage_service ON api_usage(service, created_at);
      CREATE INDEX IF NOT EXISTS idx_api_usage_created ON api_usage(created_at);

      CREATE TABLE IF NOT EXISTS api_budgets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service TEXT NOT NULL UNIQUE,
        daily_limit REAL DEFAULT 5.00,
        monthly_limit REAL DEFAULT 50.00,
        daily_call_limit INTEGER DEFAULT 50,
        monthly_call_limit INTEGER DEFAULT 500,
        is_active INTEGER DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT OR IGNORE INTO api_budgets (service, daily_limit, monthly_limit, daily_call_limit, monthly_call_limit)
      VALUES
        ('anthropic', 5.00, 50.00, 50, 500),
        ('google_places', 1.00, 10.00, 20, 100);
    `);
  } catch (e) { console.log('v1.28 api usage migration note:', e.message); }

  // v1.29 — hours_per_day on accruals (PR Labor Law: PTO day = employee's regular daily hours)
  try {
    db.exec(`ALTER TABLE accruals ADD COLUMN hours_per_day REAL NOT NULL DEFAULT 8.0`);
    console.log('v1.29 migration: added hours_per_day to accruals');
  } catch (e) { console.log('v1.29 migration note:', e.message); }

  // v1.30 — Accrual validation log (reliability system)
  db.exec(`
    CREATE TABLE IF NOT EXISTS accrual_validation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at TEXT NOT NULL DEFAULT (datetime('now')),
      trigger_type TEXT NOT NULL CHECK(trigger_type IN ('startup', 'cron', 'manual')),
      records_recalculated INTEGER NOT NULL DEFAULT 0,
      anomalies_found INTEGER NOT NULL DEFAULT 0,
      anomaly_details TEXT,
      resolved INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER
    )
  `);
}

/**
 * Log an action to the audit trail.
 * @param {Object} opts - { userId, username, action, resource, resourceId, details, ip }
 */
function auditLog({ userId, username, action, resource, resourceId, details, ip }) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO audit_log (user_id, username, action, resource, resource_id, details, ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId || null, username || null, action, resource, resourceId || null,
           typeof details === 'object' ? JSON.stringify(details) : (details || null), ip || null);
  } catch (e) {
    console.warn('[Audit] Failed to log:', e.message);
  }
}

module.exports = { getDb, initDb, auditLog };
