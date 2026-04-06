/**
 * Apprenticeship Module — API Routes
 * ═══════════════════════════════════
 * U.S. DOL Registered Apprenticeship Program (Reg #2025-PR-135424)
 * Handles enrollment, OJL hour tracking, RI attendance, task sign-offs,
 * compliance deadlines, signature capture, ETA-671 PDF generation.
 *
 * Exports { router, selfRouter, requireApprAccess }
 *   router     — admin routes (behind requireApprAccess middleware)
 *   selfRouter — employee self-service routes (behind requireAuth only)
 */

'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const multer  = require('multer');
const { getDb } = require('../db');

const router     = express.Router();
const selfRouter = express.Router();

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/** Base upload directory for apprenticeship files */
const UPLOAD_BASE = path.join(__dirname, '../../uploads/apprenticeship');
const UPLOAD_DIRS = {
  signatures: path.join(UPLOAD_BASE, 'signatures'),
  timesheets: path.join(UPLOAD_BASE, 'timesheets'),
  forms:      path.join(UPLOAD_BASE, 'forms'),
  documents:  path.join(UPLOAD_BASE, 'documents'),
  evidence:   path.join(UPLOAD_BASE, 'evidence'),
};

/** Ensure all upload directories exist */
Object.values(UPLOAD_DIRS).forEach(dir => fs.mkdirSync(dir, { recursive: true }));

/** Max upload file size (20 MB) */
const MAX_FILE_SIZE = 20 * 1024 * 1024;

/** Valid enrollment status transitions */
const STATUS_TRANSITIONS = {
  probation: ['active', 'cancelled'],
  active:    ['suspended', 'cancelled', 'completed'],
  suspended: ['active', 'cancelled'],
  cancelled: [],
  completed: [],
};

/** Valid enrollment statuses */
const VALID_STATUSES = ['probation', 'active', 'suspended', 'cancelled', 'completed'];

/** OCR model for timesheet extraction */
const OCR_MODEL = 'claude-sonnet-4-20250514';

/** Sponsor info for ETA-671 */
const SPONSOR = {
  name:    'Poro Gusto LLC DBA Chick-fil-A',
  address: 'State Road PR-14 Km 3.7',
  city:    'Ponce, PR 00728',
  regNo:   '2025-PR-135424',
  contact: 'Enrique Questell-Pereira',
  phone:   '(787) 202-3801',
};

// ═══════════════════════════════════════════════════════════════════════════
// LAZY-LOADED DEPENDENCIES
// ═══════════════════════════════════════════════════════════════════════════

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch (_) {
  console.warn('Apprenticeship: Anthropic SDK not installed — timesheet OCR unavailable');
}

let PDFDocument_lib, StandardFonts_lib, rgb_lib;
try {
  const pdfLib = require('pdf-lib');
  PDFDocument_lib = pdfLib.PDFDocument;
  StandardFonts_lib = pdfLib.StandardFonts;
  rgb_lib = pdfLib.rgb;
} catch (_) {
  console.warn('Apprenticeship: pdf-lib not installed — ETA-671 generation unavailable');
}

// ═══════════════════════════════════════════════════════════════════════════
// MULTER CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

/** Multer storage for timesheets */
const timesheetStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIRS.timesheets),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomUUID() + ext);
  }
});
const timesheetUpload = multer({
  storage: timesheetStorage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ext === '.pdf');
  }
});

/** Multer storage for signatures */
const signatureStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIRS.signatures),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomUUID() + ext);
  }
});
const signatureUpload = multer({
  storage: signatureStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ['.png', '.jpg', '.jpeg'].includes(ext));
  }
});

/** Multer storage for evidence files */
const evidenceStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIRS.evidence),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomUUID() + ext);
  }
});
const evidenceUpload = multer({
  storage: evidenceStorage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.doc', '.docx'].includes(ext));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/** Parse an integer parameter, return null if invalid */
function parseIntParam(val) {
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

/** Get session user ID (from users table) */
function getSessionUserId(req) {
  return req.session?.userId || null;
}

/** Get session employee ID */
function getSessionEmployeeId(req) {
  return req.session?.employeeId || null;
}

/** Find an enrollment by ID with track info */
function findEnrollment(id) {
  const db = getDb();
  return db.prepare(`
    SELECT e.*, t.code AS track_code, t.title AS track_title, t.occupation,
           t.rapids_code, t.onet_code, t.approach, t.term_years,
           t.ojl_hours_required, t.ri_hours_per_year, t.probation_hours, t.journeyworker_wage,
           emp.full_name AS employee_name, emp.department,
           jw.full_name AS journeyworker_name
    FROM appr_enrollments e
    JOIN appr_tracks t ON e.track_id = t.id
    JOIN employees emp ON e.employee_id = emp.id
    LEFT JOIN employees jw ON e.journeyworker_id = jw.id
    WHERE e.id = ?
  `).get(id);
}

/** Calculate cumulative OJL hours for an enrollment */
function getCumulativeOJL(enrollmentId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT COALESCE(SUM(total_hours_extracted), 0) AS total
    FROM appr_ojl_timesheet_imports
    WHERE enrollment_id = ? AND total_hours_extracted > 0
  `).get(enrollmentId);
  const enrollment = db.prepare('SELECT credit_hours FROM appr_enrollments WHERE id = ?').get(enrollmentId);
  return (row?.total || 0) + (enrollment?.credit_hours || 0);
}

/** Calculate cumulative RI hours for an enrollment */
function getCumulativeRI(enrollmentId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT COALESCE(SUM(hours_attended), 0) AS total
    FROM appr_ri_attendance WHERE enrollment_id = ?
  `).get(enrollmentId);
  return row?.total || 0;
}

/** Count completed tasks for an enrollment */
function getCompletedTaskCount(enrollmentId) {
  const db = getDb();
  return db.prepare('SELECT COUNT(*) AS c FROM appr_task_completions WHERE enrollment_id = ?').get(enrollmentId).c;
}

/** Count total tasks for a track */
function getTotalTaskCount(trackId) {
  const db = getDb();
  return db.prepare('SELECT COUNT(*) AS c FROM appr_work_processes WHERE track_id = ?').get(trackId).c;
}

/** Add days to a date string (YYYY-MM-DD) */
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

/** Add months to a date string */
function addMonths(dateStr, months) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().split('T')[0];
}

/**
 * Auto-generate compliance events for a new enrollment
 * @param {number} enrollmentId
 * @param {object} track - track data
 * @param {string} enrollmentDate - YYYY-MM-DD
 */
function generateComplianceEvents(enrollmentId, track, enrollmentDate) {
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO appr_compliance_events (enrollment_id, event_type, due_date, notes)
    VALUES (?, ?, ?, ?)
  `);

  // 1. Agreement submission — 45 days from enrollment
  insert.run(enrollmentId, 'agreement_submission', addDays(enrollmentDate, 45),
    'Submit signed ETA-671 to RAPIDS within 45 days of enrollment.');

  // 2. Probation evaluation — estimate based on probation hours / 40hr weeks
  const probWeeks = Math.ceil(track.probation_hours / 40);
  const probDays = probWeeks * 7;
  insert.run(enrollmentId, 'probation_evaluation', addDays(enrollmentDate, probDays),
    `Evaluate apprentice at end of ${track.probation_hours}-hour probationary period.`);

  // 3. RI hours check — every 90 days
  insert.run(enrollmentId, 'ri_hours_check', addDays(enrollmentDate, 90),
    'Verify RI hours pace meets 144 hrs/year minimum.');

  // 4. Annual progress review — 12 months
  insert.run(enrollmentId, 'annual_progress_review', addMonths(enrollmentDate, 12),
    'Annual progress review milestone.');

  // For 2-year tracks, add second annual review
  if (track.term_years >= 2) {
    insert.run(enrollmentId, 'annual_progress_review', addMonths(enrollmentDate, 24),
      'Second annual progress review milestone.');
  }
}

/**
 * Check if cumulative OJL hours crossed a wage tier threshold.
 * If so, create a wage_tier_advancement compliance event.
 */
function checkWageTierAdvancement(enrollmentId) {
  const db = getDb();
  const enrollment = db.prepare('SELECT * FROM appr_enrollments WHERE id = ?').get(enrollmentId);
  if (!enrollment) return;

  const cumulativeHours = getCumulativeOJL(enrollmentId);
  const nextTier = enrollment.current_wage_tier + 1;

  const schedule = db.prepare(`
    SELECT * FROM appr_wage_schedules
    WHERE track_id = ? AND tier = ?
  `).get(enrollment.track_id, nextTier);

  if (schedule && cumulativeHours >= schedule.ojl_hours_from) {
    // Check if we already have a pending wage_tier_advancement for this tier
    const existing = db.prepare(`
      SELECT id FROM appr_compliance_events
      WHERE enrollment_id = ? AND event_type = 'wage_tier_advancement'
        AND status IN ('pending', 'completed')
        AND notes LIKE ?
    `).get(enrollmentId, `%tier ${nextTier}%`);

    if (!existing) {
      db.prepare(`
        INSERT INTO appr_compliance_events (enrollment_id, event_type, due_date, notes)
        VALUES (?, 'wage_tier_advancement', date('now', '+30 days'), ?)
      `).run(enrollmentId,
        `Apprentice reached ${cumulativeHours} OJL hours — eligible for tier ${nextTier} wage advancement to $${schedule.hourly_rate.toFixed(2)}/hr. Requires formal signature before wage change.`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ACCESS CONTROL MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Custom middleware for Apprenticeship module.
 * Allows: admin system role, Director, Senior Director, Shift Leader.
 * Denies: Administrator (Gastos only), Trainer, Team Member.
 */
function requireApprAccess(req, res, next) {
  if (req.session?.role === 'admin') return next();
  if (req.session?.employeeId) {
    const db = getDb();
    const emp = db.prepare('SELECT role FROM employees WHERE id = ?').get(req.session.employeeId);
    if (emp && ['Director', 'Senior Director', 'Shift Leader', 'Instructor'].includes(emp.role)) return next();
  }
  res.status(403).json({ error: 'Apprenticeship access denied' });
}

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES — REFERENCE DATA
// ═══════════════════════════════════════════════════════════════════════════

/** GET /tracks — list all apprenticeship tracks */
router.get('/tracks', (_req, res) => {
  try {
    const db = getDb();
    const tracks = db.prepare('SELECT * FROM appr_tracks ORDER BY id').all();
    res.json(tracks);
  } catch (err) {
    console.error('GET /tracks error:', err.message);
    res.status(500).json({ error: 'Failed to load tracks' });
  }
});

/** GET /tracks/:id/tasks — list work process tasks for a track */
router.get('/tracks/:id/tasks', (req, res) => {
  try {
    const db = getDb();
    const trackId = parseIntParam(req.params.id);
    if (!trackId) return res.status(400).json({ error: 'Invalid track ID' });

    const tasks = db.prepare(`
      SELECT * FROM appr_work_processes WHERE track_id = ? ORDER BY sort_order
    `).all(trackId);
    res.json(tasks);
  } catch (err) {
    console.error('GET /tracks/:id/tasks error:', err.message);
    res.status(500).json({ error: 'Failed to load tasks' });
  }
});

/** GET /tracks/:id/courses — list RI courses for a track */
router.get('/tracks/:id/courses', (req, res) => {
  try {
    const db = getDb();
    const trackId = parseIntParam(req.params.id);
    if (!trackId) return res.status(400).json({ error: 'Invalid track ID' });

    const courses = db.prepare(`
      SELECT * FROM appr_ri_courses WHERE track_id = ? ORDER BY sort_order
    `).all(trackId);
    res.json(courses);
  } catch (err) {
    console.error('GET /tracks/:id/courses error:', err.message);
    res.status(500).json({ error: 'Failed to load courses' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES — ENROLLMENT CRUD
// ═══════════════════════════════════════════════════════════════════════════

/** GET /enrollments — list all enrollments with computed progress */
router.get('/enrollments', (_req, res) => {
  try {
    const db = getDb();
    const enrollments = db.prepare(`
      SELECT e.*, t.code AS track_code, t.title AS track_title,
             t.ojl_hours_required, t.ri_hours_per_year, t.term_years,
             emp.full_name AS employee_name, emp.department,
             jw.full_name AS journeyworker_name
      FROM appr_enrollments e
      JOIN appr_tracks t ON e.track_id = t.id
      JOIN employees emp ON e.employee_id = emp.id
      LEFT JOIN employees jw ON e.journeyworker_id = jw.id
      ORDER BY e.created_at DESC
    `).all();

    // Compute progress stats for each enrollment
    const result = enrollments.map(e => {
      const ojlHours = getCumulativeOJL(e.id);
      const riHours = getCumulativeRI(e.id);
      const tasksCompleted = getCompletedTaskCount(e.id);
      const tasksTotal = getTotalTaskCount(e.track_id);
      const totalRiRequired = e.ri_hours_per_year * e.term_years;

      // Count compliance events
      const compliance = db.prepare(`
        SELECT
          SUM(CASE WHEN status = 'pending' AND due_date < date('now') THEN 1 ELSE 0 END) AS overdue,
          SUM(CASE WHEN status = 'pending' AND due_date >= date('now') AND due_date <= date('now', '+30 days') THEN 1 ELSE 0 END) AS due_soon,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
        FROM appr_compliance_events WHERE enrollment_id = ?
      `).get(e.id);

      return {
        ...e,
        ojl_hours: ojlHours,
        ojl_pct: Math.min(100, Math.round((ojlHours / e.ojl_hours_required) * 100)),
        ri_hours: riHours,
        ri_pct: Math.min(100, Math.round((riHours / totalRiRequired) * 100)),
        tasks_completed: tasksCompleted,
        tasks_total: tasksTotal,
        tasks_pct: tasksTotal > 0 ? Math.round((tasksCompleted / tasksTotal) * 100) : 0,
        compliance_overdue: compliance?.overdue || 0,
        compliance_due_soon: compliance?.due_soon || 0,
        compliance_pending: compliance?.pending || 0,
      };
    });

    res.json(result);
  } catch (err) {
    console.error('GET /enrollments error:', err.message);
    res.status(500).json({ error: 'Failed to load enrollments' });
  }
});

/** POST /enrollments — create a new enrollment */
router.post('/enrollments', express.json(), (req, res) => {
  try {
    const db = getDb();
    const { employee_id, track_id, enrollment_date, journeyworker_id, credit_hours, prior_hourly_wage, notes } = req.body;

    // Validate required fields
    if (!employee_id || !track_id || !enrollment_date) {
      return res.status(400).json({ error: 'employee_id, track_id, and enrollment_date are required' });
    }

    // Check employee exists
    const emp = db.prepare('SELECT id, full_name FROM employees WHERE id = ?').get(employee_id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    // Check track exists
    const track = db.prepare('SELECT * FROM appr_tracks WHERE id = ?').get(track_id);
    if (!track) return res.status(404).json({ error: 'Track not found' });

    // Check no duplicate enrollment
    const existing = db.prepare('SELECT id FROM appr_enrollments WHERE employee_id = ? AND track_id = ?').get(employee_id, track_id);
    if (existing) return res.status(409).json({ error: 'Employee is already enrolled in this track' });

    // Calculate dates
    const creditHrs = credit_hours || 0;
    const probWeeks = Math.ceil(track.probation_hours / 40);
    const probationEndDate = addDays(enrollment_date, probWeeks * 7);
    const expectedCompletionDate = addMonths(enrollment_date, track.term_years * 12);

    // Get tier 1 wage
    const tier1Wage = db.prepare('SELECT hourly_rate FROM appr_wage_schedules WHERE track_id = ? AND tier = 1').get(track_id);

    const result = db.prepare(`
      INSERT INTO appr_enrollments (employee_id, track_id, journeyworker_id, enrollment_date,
        probation_end_date, expected_completion_date, credit_hours, prior_hourly_wage, notes, current_wage_tier, current_hourly_wage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(employee_id, track_id, journeyworker_id || null, enrollment_date,
      probationEndDate, expectedCompletionDate, creditHrs, prior_hourly_wage || null, notes || null,
      tier1Wage ? tier1Wage.hourly_rate : null);

    // Log initial wage in history
    if (tier1Wage) {
      db.prepare(`
        INSERT INTO appr_wage_history (enrollment_id, previous_wage, new_wage, previous_tier, new_tier, reason, changed_by, notes)
        VALUES (?, ?, ?, NULL, 1, 'enrollment', ?, 'Initial enrollment wage')
      `).run(result.lastInsertRowid, prior_hourly_wage || null, tier1Wage.hourly_rate, req.session?.userId || null);
    }

    const enrollmentId = result.lastInsertRowid;

    // Auto-generate compliance events
    generateComplianceEvents(enrollmentId, track, enrollment_date);

    // Return the created enrollment
    const enrollment = findEnrollment(enrollmentId);
    res.status(201).json({
      ...enrollment,
      tier1_wage: tier1Wage?.hourly_rate || null,
      message: `Enrolled ${emp.full_name} in ${track.title} track`
    });
  } catch (err) {
    console.error('POST /enrollments error:', err.message);
    res.status(500).json({ error: 'Failed to create enrollment' });
  }
});

/** GET /enrollments/:id — full enrollment detail */
router.get('/enrollments/:id', (req, res) => {
  try {
    const db = getDb();
    const id = parseIntParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid enrollment ID' });

    const enrollment = findEnrollment(id);
    if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' });

    // Get all related data
    const ojlHours = getCumulativeOJL(id);
    const riHours = getCumulativeRI(id);
    const totalRiRequired = enrollment.ri_hours_per_year * enrollment.term_years;

    // Work process tasks with completion status
    const tasks = db.prepare(`
      SELECT wp.*, tc.completed_date, tc.notes AS completion_notes,
             sa.approved_by, u.username AS approver_name
      FROM appr_work_processes wp
      LEFT JOIN appr_task_completions tc ON tc.work_process_id = wp.id AND tc.enrollment_id = ?
      LEFT JOIN appr_supervisor_approvals sa ON tc.supervisor_approval_id = sa.id
      LEFT JOIN users u ON sa.approved_by = u.id
      WHERE wp.track_id = ?
      ORDER BY wp.sort_order
    `).all(id, enrollment.track_id);

    // RI attendance by course
    const riByC = db.prepare(`
      SELECT c.id AS course_id, c.title, c.contact_hours AS required_hours,
             COALESCE(SUM(ra.hours_attended), 0) AS completed_hours
      FROM appr_ri_courses c
      LEFT JOIN appr_ri_attendance ra ON ra.course_id = c.id AND ra.enrollment_id = ?
      WHERE c.track_id = ?
      GROUP BY c.id
      ORDER BY c.sort_order
    `).all(id, enrollment.track_id);

    // Timesheet imports
    const timesheets = db.prepare(`
      SELECT * FROM appr_ojl_timesheet_imports
      WHERE enrollment_id = ? ORDER BY pay_period_start DESC
    `).all(id);

    // Compliance events
    const compliance = db.prepare(`
      SELECT * FROM appr_compliance_events
      WHERE enrollment_id = ? ORDER BY due_date ASC
    `).all(id);

    // Formal signatures
    const signatures = db.prepare(`
      SELECT * FROM appr_formal_signatures
      WHERE enrollment_id = ? ORDER BY signed_at DESC
    `).all(id);

    // Period summaries
    const periods = db.prepare(`
      SELECT ps.*, sa.approved_by, u.username AS approver_name
      FROM appr_period_summaries ps
      LEFT JOIN appr_supervisor_approvals sa ON ps.summary_approval_id = sa.id
      LEFT JOIN users u ON sa.approved_by = u.id
      WHERE ps.enrollment_id = ?
      ORDER BY ps.period_start DESC
    `).all(id);

    // Wage schedules for this track
    const wages = db.prepare(`
      SELECT * FROM appr_wage_schedules WHERE track_id = ? ORDER BY tier
    `).all(enrollment.track_id);

    // Wage compliance check
    const requiredWage = wages.find(w => w.tier === enrollment.current_wage_tier);
    const wageCompliant = enrollment.current_hourly_wage && requiredWage
      ? enrollment.current_hourly_wage >= requiredWage.hourly_rate : null;

    // Wage history
    const wageHistory = db.prepare(`
      SELECT wh.*, u.username AS changed_by_name
      FROM appr_wage_history wh
      LEFT JOIN users u ON wh.changed_by = u.id
      WHERE wh.enrollment_id = ?
      ORDER BY wh.created_at DESC
    `).all(id);

    res.json({
      enrollment,
      progress: {
        ojl_hours: ojlHours,
        ojl_required: enrollment.ojl_hours_required,
        ojl_pct: Math.min(100, Math.round((ojlHours / enrollment.ojl_hours_required) * 100)),
        ri_hours: riHours,
        ri_required: totalRiRequired,
        ri_pct: Math.min(100, Math.round((riHours / totalRiRequired) * 100)),
        tasks_completed: tasks.filter(t => t.completed_date).length,
        tasks_total: tasks.length,
      },
      tasks,
      ri_courses: riByC,
      timesheets,
      compliance,
      signatures,
      periods,
      wages,
      wageCompliance: {
        currentWage: enrollment.current_hourly_wage,
        requiredMinimum: requiredWage ? requiredWage.hourly_rate : null,
        journeyworkerWage: enrollment.journeyworker_wage,
        isCompliant: wageCompliant,
        tier: enrollment.current_wage_tier,
      },
      wageHistory,
    });
  } catch (err) {
    console.error('GET /enrollments/:id error:', err.message);
    res.status(500).json({ error: 'Failed to load enrollment detail' });
  }
});

/** PUT /enrollments/:id/status — change enrollment status */
router.put('/enrollments/:id/status', express.json(), (req, res) => {
  try {
    const db = getDb();
    const id = parseIntParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid enrollment ID' });

    const enrollment = db.prepare('SELECT * FROM appr_enrollments WHERE id = ?').get(id);
    if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' });

    const { status, notes } = req.body;
    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Valid: ${VALID_STATUSES.join(', ')}` });
    }

    // Validate transition
    const allowed = STATUS_TRANSITIONS[enrollment.status];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        error: `Cannot transition from '${enrollment.status}' to '${status}'. Allowed: ${allowed.join(', ') || 'none'}`
      });
    }

    // Update enrollment
    const updates = { status, updated_at: new Date().toISOString() };
    if (status === 'completed') {
      updates.actual_completion_date = new Date().toISOString().split('T')[0];
    }

    db.prepare(`
      UPDATE appr_enrollments
      SET status = ?, updated_at = ?, actual_completion_date = COALESCE(?, actual_completion_date)
      WHERE id = ?
    `).run(status, updates.updated_at, updates.actual_completion_date || null, id);

    // Auto-create compliance event for suspended/cancelled
    if (['suspended', 'cancelled'].includes(status)) {
      db.prepare(`
        INSERT INTO appr_compliance_events (enrollment_id, event_type, due_date, notes)
        VALUES (?, 'status_change_notification', date('now', '+45 days'), ?)
      `).run(id, `Apprenticeship ${status}. DOL must be notified within 45 days. ${notes || ''}`);
    }

    res.json({ message: `Enrollment status changed to '${status}'`, enrollment_id: id });
  } catch (err) {
    console.error('PUT /enrollments/:id/status error:', err.message);
    res.status(500).json({ error: 'Failed to update enrollment status' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES — WAGE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

/** PUT /enrollments/:id/wage — update actual wage for an enrolled apprentice */
router.put('/enrollments/:id/wage', express.json(), (req, res) => {
  try {
    const db = getDb();
    const id = parseIntParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid enrollment ID' });

    const enrollment = db.prepare('SELECT * FROM appr_enrollments WHERE id = ?').get(id);
    if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' });

    const { hourly_wage, reason, notes } = req.body;
    if (!hourly_wage || isNaN(parseFloat(hourly_wage)) || parseFloat(hourly_wage) <= 0) {
      return res.status(400).json({ error: 'Valid hourly_wage is required' });
    }

    const newWage = Math.round(parseFloat(hourly_wage) * 100) / 100;
    const validReasons = ['tier_advancement', 'manual_adjustment', 'correction'];
    const wageReason = validReasons.includes(reason) ? reason : 'manual_adjustment';

    // Determine new tier based on wage schedule
    const schedules = db.prepare(
      'SELECT * FROM appr_wage_schedules WHERE track_id = ? ORDER BY tier'
    ).all(enrollment.track_id);

    let newTier = enrollment.current_wage_tier;
    for (const s of schedules) {
      if (newWage >= s.hourly_rate) newTier = s.tier;
    }

    // Check compliance: is the new wage at or above the required minimum for the tier?
    const requiredWage = schedules.find(s => s.tier === newTier);
    const isCompliant = requiredWage ? newWage >= requiredWage.hourly_rate : true;

    // Log to wage history
    db.prepare(`
      INSERT INTO appr_wage_history (enrollment_id, previous_wage, new_wage, previous_tier, new_tier, reason, changed_by, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, enrollment.current_hourly_wage, newWage, enrollment.current_wage_tier, newTier,
      wageReason, req.session?.userId || null, notes || null);

    // Update enrollment
    db.prepare(`
      UPDATE appr_enrollments
      SET current_hourly_wage = ?, current_wage_tier = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(newWage, newTier, id);

    res.json({
      message: 'Wage updated',
      enrollment_id: id,
      previous_wage: enrollment.current_hourly_wage,
      new_wage: newWage,
      new_tier: newTier,
      is_compliant: isCompliant,
      required_minimum: requiredWage ? requiredWage.hourly_rate : null
    });
  } catch (err) {
    console.error('PUT /enrollments/:id/wage error:', err.message);
    res.status(500).json({ error: 'Failed to update wage' });
  }
});

/** GET /enrollments/:id/wage-history — view wage change log */
router.get('/enrollments/:id/wage-history', (req, res) => {
  try {
    const db = getDb();
    const id = parseIntParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid enrollment ID' });

    const history = db.prepare(`
      SELECT wh.*, u.username AS changed_by_name
      FROM appr_wage_history wh
      LEFT JOIN users u ON wh.changed_by = u.id
      WHERE wh.enrollment_id = ?
      ORDER BY wh.created_at DESC
    `).all(id);

    res.json(history);
  } catch (err) {
    console.error('GET /enrollments/:id/wage-history error:', err.message);
    res.status(500).json({ error: 'Failed to load wage history' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES — SIGNATURES
// ═══════════════════════════════════════════════════════════════════════════

/** POST /signatures — save a formal signature (drawn or uploaded) */
router.post('/signatures', express.json({ limit: '5mb' }), (req, res) => {
  try {
    const db = getDb();
    const { enrollment_id, document_type, signer_role, signature_type, signature_data } = req.body;

    if (!enrollment_id || !document_type || !signer_role || !signature_data) {
      return res.status(400).json({ error: 'enrollment_id, document_type, signer_role, and signature_data are required' });
    }

    // Validate enrollment exists
    const enrollment = db.prepare('SELECT id FROM appr_enrollments WHERE id = ?').get(enrollment_id);
    if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' });

    // Decode base64 signature data
    const base64Match = signature_data.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
    if (!base64Match) return res.status(400).json({ error: 'Invalid signature data format. Expected base64 data URL.' });

    const ext = base64Match[1] === 'jpeg' ? 'jpg' : base64Match[1];
    const buffer = Buffer.from(base64Match[2], 'base64');
    const filename = `${enrollment_id}_${document_type}_${signer_role}_${Date.now()}.${ext}`;
    const filePath = path.join(UPLOAD_DIRS.signatures, filename);

    fs.writeFileSync(filePath, buffer);

    const result = db.prepare(`
      INSERT INTO appr_formal_signatures (enrollment_id, document_type, signer_role, signature_type, signature_file_path, signed_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(enrollment_id, document_type, signer_role, signature_type || 'drawn', filename, getSessionUserId(req));

    res.status(201).json({ id: result.lastInsertRowid, filename, message: 'Signature saved' });
  } catch (err) {
    console.error('POST /signatures error:', err.message);
    res.status(500).json({ error: 'Failed to save signature' });
  }
});

/** GET /signatures/:enrollment_id — list signatures for an enrollment */
router.get('/signatures/:enrollment_id', (req, res) => {
  try {
    const db = getDb();
    const enrollmentId = parseIntParam(req.params.enrollment_id);
    if (!enrollmentId) return res.status(400).json({ error: 'Invalid enrollment ID' });

    const sigs = db.prepare(`
      SELECT * FROM appr_formal_signatures WHERE enrollment_id = ? ORDER BY signed_at DESC
    `).all(enrollmentId);
    res.json(sigs);
  } catch (err) {
    console.error('GET /signatures/:enrollment_id error:', err.message);
    res.status(500).json({ error: 'Failed to load signatures' });
  }
});

/** GET /signature-file/:filename — serve a signature image */
router.get('/signature-file/:filename', (req, res) => {
  try {
    const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '');
    const filePath = path.join(UPLOAD_DIRS.signatures, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    res.sendFile(filePath);
  } catch (err) {
    console.error('GET /signature-file error:', err.message);
    res.status(500).json({ error: 'Failed to serve file' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES — TIMESHEET OCR IMPORT
// ═══════════════════════════════════════════════════════════════════════════

/** POST /timesheets/import — upload timesheet PDF, run OCR extraction */
router.post('/timesheets/import', timesheetUpload.single('file'), async (req, res) => {
  try {
    if (!Anthropic) return res.status(503).json({ error: 'Anthropic SDK not available — OCR disabled' });
    if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded' });

    const fileBuffer = fs.readFileSync(req.file.path);
    const base64 = fileBuffer.toString('base64');

    const client = new Anthropic();
    const message = await client.messages.create({
      model: OCR_MODEL,
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: `Extract timesheet data from this document. Return ONLY valid JSON with this structure:
{
  "pay_period_start": "YYYY-MM-DD",
  "pay_period_end": "YYYY-MM-DD",
  "employees": [
    {"name": "Full Name", "total_hours": 40.5}
  ]
}
Extract each employee's name and their total hours worked for the pay period. Be precise with the hours.` }
        ]
      }]
    });

    // Parse AI response
    const aiText = message.content[0]?.text || '';
    let extracted;
    try {
      const jsonMatch = aiText.match(/\{[\s\S]*\}/);
      extracted = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch (_) {
      extracted = null;
    }

    if (!extracted || !extracted.employees) {
      return res.status(422).json({ error: 'Could not extract timesheet data from PDF', raw: aiText });
    }

    // Try to match extracted names to enrolled apprentices
    const db = getDb();
    const enrollments = db.prepare(`
      SELECT e.id AS enrollment_id, e.employee_id, emp.full_name
      FROM appr_enrollments e
      JOIN employees emp ON e.employee_id = emp.id
      WHERE e.status IN ('probation', 'active')
    `).all();

    const matched = extracted.employees.map(ext => {
      const normalizedName = ext.name.toLowerCase().replace(/[^a-z ]/g, '');
      let bestMatch = null;
      let bestScore = 0;

      for (const enr of enrollments) {
        const enrName = enr.full_name.toLowerCase().replace(/[^a-z ]/g, '');
        // Simple contains-based matching
        if (enrName.includes(normalizedName) || normalizedName.includes(enrName)) {
          bestMatch = enr;
          bestScore = 1;
          break;
        }
        // Check last name match
        const extParts = normalizedName.split(' ');
        const enrParts = enrName.split(' ');
        for (const ep of extParts) {
          if (ep.length > 2 && enrParts.some(np => np.includes(ep) || ep.includes(np))) {
            if (!bestMatch || bestScore < 0.5) {
              bestMatch = enr;
              bestScore = 0.5;
            }
          }
        }
      }

      return {
        extracted_name: ext.name,
        total_hours: ext.total_hours,
        matched_enrollment_id: bestMatch?.enrollment_id || null,
        matched_employee_name: bestMatch?.full_name || null,
        confidence: bestScore,
      };
    });

    res.json({
      pdf_filename: req.file.filename,
      pay_period_start: extracted.pay_period_start,
      pay_period_end: extracted.pay_period_end,
      employees: matched,
      raw_extraction: aiText,
    });
  } catch (err) {
    console.error('POST /timesheets/import error:', err.message);
    res.status(500).json({ error: 'Timesheet import failed' });
  }
});

/** POST /timesheets/confirm — confirm extracted timesheet data, credit OJL hours */
router.post('/timesheets/confirm', express.json(), (req, res) => {
  try {
    const db = getDb();
    const { pdf_filename, pay_period_start, pay_period_end, entries, raw_extraction } = req.body;

    if (!pdf_filename || !pay_period_start || !pay_period_end || !entries || !entries.length) {
      return res.status(400).json({ error: 'pdf_filename, pay_period_start, pay_period_end, and entries are required' });
    }

    const results = [];
    const userId = getSessionUserId(req);

    db.transaction(() => {
      for (const entry of entries) {
        if (!entry.enrollment_id || !entry.total_hours || entry.total_hours <= 0) continue;

        // Verify enrollment exists and is active
        const enrollment = db.prepare('SELECT id, track_id FROM appr_enrollments WHERE id = ? AND status IN (?, ?)').get(entry.enrollment_id, 'probation', 'active');
        if (!enrollment) continue;

        // Create timesheet import record
        const result = db.prepare(`
          INSERT INTO appr_ojl_timesheet_imports (enrollment_id, pay_period_start, pay_period_end,
            pdf_file_path, total_hours_extracted, ai_extraction_json, imported_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(entry.enrollment_id, pay_period_start, pay_period_end,
          pdf_filename, entry.total_hours, raw_extraction || null, userId);

        results.push({
          import_id: result.lastInsertRowid,
          enrollment_id: entry.enrollment_id,
          hours_credited: entry.total_hours,
        });

        // Check wage tier advancement
        checkWageTierAdvancement(entry.enrollment_id);
      }
    })();

    res.json({ message: `Credited hours to ${results.length} apprentice(s)`, results });
  } catch (err) {
    console.error('POST /timesheets/confirm error:', err.message);
    res.status(500).json({ error: 'Failed to confirm timesheet data' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES — TASK SIGN-OFFS & PERIOD SUMMARIES
// ═══════════════════════════════════════════════════════════════════════════

/** POST /tasks/:enrollmentId/:taskId/complete — supervisor signs off a work process task */
router.post('/tasks/:enrollmentId/:taskId/complete', express.json(), (req, res) => {
  try {
    const db = getDb();
    const enrollmentId = parseIntParam(req.params.enrollmentId);
    const taskId = parseIntParam(req.params.taskId);
    if (!enrollmentId || !taskId) return res.status(400).json({ error: 'Invalid enrollment or task ID' });

    const enrollment = db.prepare('SELECT * FROM appr_enrollments WHERE id = ?').get(enrollmentId);
    if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' });

    // Verify task belongs to enrollment's track
    const task = db.prepare('SELECT * FROM appr_work_processes WHERE id = ? AND track_id = ?').get(taskId, enrollment.track_id);
    if (!task) return res.status(404).json({ error: 'Task not found for this track' });

    // Check not already completed
    const existing = db.prepare('SELECT id FROM appr_task_completions WHERE enrollment_id = ? AND work_process_id = ?').get(enrollmentId, taskId);
    if (existing) return res.status(409).json({ error: 'Task already completed' });

    const userId = getSessionUserId(req);
    const today = new Date().toISOString().split('T')[0];

    // Create supervisor approval record
    const approvalResult = db.prepare(`
      INSERT INTO appr_supervisor_approvals (enrollment_id, approval_type, reference_id, approved_by, notes)
      VALUES (?, 'task', ?, ?, ?)
    `).run(enrollmentId, taskId, userId, req.body.notes || null);

    // Create task completion record
    db.prepare(`
      INSERT INTO appr_task_completions (enrollment_id, work_process_id, completed_date, supervisor_approval_id, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(enrollmentId, taskId, today, approvalResult.lastInsertRowid, req.body.notes || null);

    res.json({ message: `Task "${task.task_label}" signed off`, task_id: taskId });
  } catch (err) {
    console.error('POST /tasks/:enrollmentId/:taskId/complete error:', err.message);
    res.status(500).json({ error: 'Failed to complete task' });
  }
});

/** POST /periods/:enrollmentId/summarize — auto-generate period summary */
router.post('/periods/:enrollmentId/summarize', express.json(), (req, res) => {
  try {
    const db = getDb();
    const enrollmentId = parseIntParam(req.params.enrollmentId);
    if (!enrollmentId) return res.status(400).json({ error: 'Invalid enrollment ID' });

    const { period_start, period_end } = req.body;
    if (!period_start || !period_end) return res.status(400).json({ error: 'period_start and period_end are required' });

    // Sum OJL hours for the period
    const ojl = db.prepare(`
      SELECT COALESCE(SUM(total_hours_extracted), 0) AS total
      FROM appr_ojl_timesheet_imports
      WHERE enrollment_id = ? AND pay_period_start >= ? AND pay_period_end <= ?
    `).get(enrollmentId, period_start, period_end);

    // Count tasks completed in the period
    const tasks = db.prepare(`
      SELECT COUNT(*) AS c FROM appr_task_completions
      WHERE enrollment_id = ? AND completed_date >= ? AND completed_date <= ?
    `).get(enrollmentId, period_start, period_end);

    const result = db.prepare(`
      INSERT INTO appr_period_summaries (enrollment_id, period_start, period_end, total_ojl_hours, tasks_completed_count)
      VALUES (?, ?, ?, ?, ?)
    `).run(enrollmentId, period_start, period_end, ojl.total, tasks.c);

    res.status(201).json({
      id: result.lastInsertRowid,
      period_start, period_end,
      total_ojl_hours: ojl.total,
      tasks_completed_count: tasks.c,
    });
  } catch (err) {
    console.error('POST /periods/:enrollmentId/summarize error:', err.message);
    res.status(500).json({ error: 'Failed to generate period summary' });
  }
});

/** POST /periods/:summaryId/approve — supervisor approves period summary */
router.post('/periods/:summaryId/approve', express.json(), (req, res) => {
  try {
    const db = getDb();
    const summaryId = parseIntParam(req.params.summaryId);
    if (!summaryId) return res.status(400).json({ error: 'Invalid summary ID' });

    const summary = db.prepare('SELECT * FROM appr_period_summaries WHERE id = ?').get(summaryId);
    if (!summary) return res.status(404).json({ error: 'Period summary not found' });
    if (summary.summary_approval_id) return res.status(409).json({ error: 'Period summary already approved' });

    const userId = getSessionUserId(req);

    // Create supervisor approval
    const approvalResult = db.prepare(`
      INSERT INTO appr_supervisor_approvals (enrollment_id, approval_type, reference_id, period_start, period_end, approved_by, notes)
      VALUES (?, 'period_summary', ?, ?, ?, ?, ?)
    `).run(summary.enrollment_id, summaryId, summary.period_start, summary.period_end, userId, req.body.notes || null);

    // Link approval to summary
    db.prepare('UPDATE appr_period_summaries SET summary_approval_id = ? WHERE id = ?')
      .run(approvalResult.lastInsertRowid, summaryId);

    res.json({ message: 'Period summary approved', summary_id: summaryId });
  } catch (err) {
    console.error('POST /periods/:summaryId/approve error:', err.message);
    res.status(500).json({ error: 'Failed to approve period summary' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES — RI ATTENDANCE
// ═══════════════════════════════════════════════════════════════════════════

/** POST /ri/:enrollmentId/attendance — log RI session hours */
router.post('/ri/:enrollmentId/attendance', express.json(), (req, res) => {
  try {
    const db = getDb();
    const enrollmentId = parseIntParam(req.params.enrollmentId);
    if (!enrollmentId) return res.status(400).json({ error: 'Invalid enrollment ID' });

    const { course_id, session_date, hours, instructor_name, notes } = req.body;
    if (!course_id || !session_date || !hours || hours <= 0) {
      return res.status(400).json({ error: 'course_id, session_date, and hours (> 0) are required' });
    }

    // Verify enrollment exists
    const enrollment = db.prepare('SELECT track_id FROM appr_enrollments WHERE id = ?').get(enrollmentId);
    if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' });

    // Verify course belongs to the enrollment's track
    const course = db.prepare('SELECT id FROM appr_ri_courses WHERE id = ? AND track_id = ?').get(course_id, enrollment.track_id);
    if (!course) return res.status(404).json({ error: 'Course not found for this track' });

    const result = db.prepare(`
      INSERT INTO appr_ri_attendance (enrollment_id, course_id, session_date, hours_attended, instructor_name, logged_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(enrollmentId, course_id, session_date, hours, instructor_name || null, getSessionUserId(req));

    res.status(201).json({ id: result.lastInsertRowid, message: 'RI attendance recorded' });
  } catch (err) {
    console.error('POST /ri/:enrollmentId/attendance error:', err.message);
    res.status(500).json({ error: 'Failed to log RI attendance' });
  }
});

/** GET /ri/:enrollmentId/summary — RI hours summary per course */
router.get('/ri/:enrollmentId/summary', (req, res) => {
  try {
    const db = getDb();
    const enrollmentId = parseIntParam(req.params.enrollmentId);
    if (!enrollmentId) return res.status(400).json({ error: 'Invalid enrollment ID' });

    const enrollment = db.prepare('SELECT track_id FROM appr_enrollments WHERE id = ?').get(enrollmentId);
    if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' });

    const courses = db.prepare(`
      SELECT c.id, c.title, c.contact_hours AS required_hours,
             COALESCE(SUM(ra.hours_attended), 0) AS completed_hours
      FROM appr_ri_courses c
      LEFT JOIN appr_ri_attendance ra ON ra.course_id = c.id AND ra.enrollment_id = ?
      WHERE c.track_id = ?
      GROUP BY c.id
      ORDER BY c.sort_order
    `).all(enrollmentId, enrollment.track_id);

    const totalRequired = courses.reduce((sum, c) => sum + c.required_hours, 0);
    const totalCompleted = courses.reduce((sum, c) => sum + c.completed_hours, 0);

    res.json({ courses, total_required: totalRequired, total_completed: totalCompleted });
  } catch (err) {
    console.error('GET /ri/:enrollmentId/summary error:', err.message);
    res.status(500).json({ error: 'Failed to load RI summary' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES — COMPLIANCE
// ═══════════════════════════════════════════════════════════════════════════

/** GET /compliance/overview — compliance dashboard counts */
router.get('/compliance/overview', (_req, res) => {
  try {
    const db = getDb();
    const stats = db.prepare(`
      SELECT
        SUM(CASE WHEN ce.status = 'pending' AND ce.due_date < date('now') THEN 1 ELSE 0 END) AS overdue,
        SUM(CASE WHEN ce.status = 'pending' AND ce.due_date >= date('now') AND ce.due_date <= date('now', '+30 days') THEN 1 ELSE 0 END) AS due_soon,
        SUM(CASE WHEN ce.status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN ce.status = 'completed' THEN 1 ELSE 0 END) AS completed
      FROM appr_compliance_events ce
      JOIN appr_enrollments e ON ce.enrollment_id = e.id
      WHERE e.status IN ('probation', 'active')
    `).get();

    res.json(stats || { overdue: 0, due_soon: 0, pending: 0, completed: 0 });
  } catch (err) {
    console.error('GET /compliance/overview error:', err.message);
    res.status(500).json({ error: 'Failed to load compliance overview' });
  }
});

/** GET /compliance/:enrollmentId — compliance events for an enrollment */
router.get('/compliance/:enrollmentId', (req, res) => {
  try {
    const db = getDb();
    const enrollmentId = parseIntParam(req.params.enrollmentId);
    if (!enrollmentId) return res.status(400).json({ error: 'Invalid enrollment ID' });

    const events = db.prepare(`
      SELECT *,
        CASE
          WHEN status = 'pending' AND due_date < date('now') THEN 'overdue'
          WHEN status = 'pending' AND due_date <= date('now', '+30 days') THEN 'due_soon'
          ELSE status
        END AS display_status,
        CAST(julianday(due_date) - julianday('now') AS INTEGER) AS days_remaining
      FROM appr_compliance_events
      WHERE enrollment_id = ?
      ORDER BY due_date ASC
    `).all(enrollmentId);

    res.json(events);
  } catch (err) {
    console.error('GET /compliance/:enrollmentId error:', err.message);
    res.status(500).json({ error: 'Failed to load compliance events' });
  }
});

/** POST /compliance/:eventId/complete — mark compliance event completed */
router.post('/compliance/:eventId/complete', express.json(), (req, res) => {
  try {
    const db = getDb();
    const eventId = parseIntParam(req.params.eventId);
    if (!eventId) return res.status(400).json({ error: 'Invalid event ID' });

    const event = db.prepare('SELECT * FROM appr_compliance_events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Compliance event not found' });
    if (event.status === 'completed') return res.status(409).json({ error: 'Event already completed' });

    const today = new Date().toISOString().split('T')[0];
    db.prepare(`
      UPDATE appr_compliance_events SET status = 'completed', completed_date = ?, notes = COALESCE(?, notes)
      WHERE id = ?
    `).run(today, req.body.notes || null, eventId);

    // If it's an ri_hours_check, auto-create the next one 90 days out
    if (event.event_type === 'ri_hours_check') {
      const enrollment = db.prepare('SELECT status FROM appr_enrollments WHERE id = ?').get(event.enrollment_id);
      if (enrollment && ['probation', 'active'].includes(enrollment.status)) {
        db.prepare(`
          INSERT INTO appr_compliance_events (enrollment_id, event_type, due_date, notes)
          VALUES (?, 'ri_hours_check', date(?, '+90 days'), 'Recurring RI hours pace check.')
        `).run(event.enrollment_id, today);
      }
    }

    res.json({ message: 'Compliance event marked completed', event_id: eventId });
  } catch (err) {
    console.error('POST /compliance/:eventId/complete error:', err.message);
    res.status(500).json({ error: 'Failed to complete compliance event' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES — REPORT GENERATION
// ═══════════════════════════════════════════════════════════════════════════

/** GET /reports/:id/eta671 — generate ETA-671 PDF with Part B auto-filled */
router.get('/reports/:id/eta671', async (req, res) => {
  try {
    if (!PDFDocument_lib) return res.status(503).json({ error: 'pdf-lib not installed — ETA-671 generation unavailable' });

    const id = parseIntParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid enrollment ID' });

    const enrollment = findEnrollment(id);
    if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' });

    const db = getDb();
    const templatePath = path.join(UPLOAD_DIRS.forms, 'ETA_form_671.pdf');
    if (!fs.existsSync(templatePath)) {
      return res.status(404).json({ error: 'ETA-671 template PDF not found. Place it at uploads/apprenticeship/forms/ETA_form_671.pdf' });
    }

    // Load template
    const templateBytes = fs.readFileSync(templatePath);
    const pdfDoc = await PDFDocument_lib.load(templateBytes);
    const page = pdfDoc.getPages()[0]; // 612 x 792 pts
    const font = await pdfDoc.embedFont(StandardFonts_lib.Helvetica);
    const fontItalic = await pdfDoc.embedFont(StandardFonts_lib.HelveticaOblique);
    const black = rgb_lib(0, 0, 0);
    const gray = rgb_lib(0.4, 0.4, 0.4);

    // Helper to draw text at coords (y is from bottom in pdf-lib)
    const pageHeight = 792;
    const drawField = (text, x, y, opts = {}) => {
      const fontSize = opts.fs || 9;
      const color = opts.color || black;
      const f = opts.italic ? fontItalic : font;
      // Convert top-down y to pdf-lib bottom-up y
      page.drawText(String(text || ''), { x, y: pageHeight - y, size: fontSize, font: f, color });
    };

    // Get wage schedules
    const wages = db.prepare('SELECT * FROM appr_wage_schedules WHERE track_id = ? ORDER BY tier').all(enrollment.track_id);
    const tier1 = wages.find(w => w.tier === 1);
    const tier2 = wages.find(w => w.tier === 2);

    // Get RI provider info
    const riCourse = db.prepare('SELECT provider_name FROM appr_ri_courses WHERE track_id = ? LIMIT 1').get(enrollment.track_id);

    // Get signatures
    const sponsor1Sig = db.prepare("SELECT * FROM appr_formal_signatures WHERE enrollment_id = ? AND signer_role = 'sponsor_1' ORDER BY signed_at DESC LIMIT 1").get(id);
    const sponsor2Sig = db.prepare("SELECT * FROM appr_formal_signatures WHERE enrollment_id = ? AND signer_role = 'sponsor_2' ORDER BY signed_at DESC LIMIT 1").get(id);

    // ── Part A note ──────────────────────────────────────────────────────
    drawField('[Part A — to be completed by apprentice. Print and hand to employee.]', 24, 158, { fs: 8, italic: true, color: gray });

    // ── Part B fields (coordinates from handoff doc) ─────────────────────
    // B1 — Program Number
    drawField(SPONSOR.regNo, 24, 400, { fs: 9 });
    // B1 — Sponsor Name/Address
    drawField(SPONSOR.name, 24, 415, { fs: 9 });
    drawField(SPONSOR.address, 24, 427, { fs: 8 });
    drawField(SPONSOR.city, 24, 437, { fs: 8 });

    // B2a — Occupation
    drawField(`${enrollment.track_title} / ${enrollment.occupation}`, 298, 418, { fs: 8 });
    // B2b — Occupation codes
    drawField(`${enrollment.rapids_code} / O*NET ${enrollment.onet_code}`, 478, 404, { fs: 8 });

    // B3 — Approach (mark checkbox position based on approach)
    if (enrollment.approach === 'competency') {
      drawField('X', 310, 484, { fs: 10 });
    } else if (enrollment.approach === 'time') {
      drawField('X', 310, 475, { fs: 10 });
    }

    // B4 — Term
    drawField(`${enrollment.term_years} Yr${enrollment.term_years > 1 ? 's' : ''} / ${enrollment.ojl_hours_required.toLocaleString()} hrs`, 401, 464, { fs: 8 });
    // B5 — Probationary Period
    drawField(`${enrollment.probation_hours.toLocaleString()} hrs`, 478, 464, { fs: 9 });

    // B6 — Credit Previous Experience
    drawField(`${enrollment.credit_hours || 0} hrs`, 298, 515, { fs: 9 });
    // B7 — Term Remaining
    const termRemaining = enrollment.ojl_hours_required - (enrollment.credit_hours || 0);
    drawField(`${termRemaining.toLocaleString()} hrs`, 415, 515, { fs: 9 });
    // B8 — Date Begins
    const enrollDate = new Date(enrollment.enrollment_date + 'T00:00:00Z');
    const formattedDate = `${String(enrollDate.getUTCMonth() + 1).padStart(2, '0')}/${String(enrollDate.getUTCDate()).padStart(2, '0')}/${enrollDate.getUTCFullYear()}`;
    drawField(formattedDate, 496, 515, { fs: 9 });

    // B9a — RI Hours/Year
    drawField(`${enrollment.ri_hours_per_year} hrs/yr`, 24, 553, { fs: 9 });
    // B9b — Wages for RI: mark "Will Be Paid"
    drawField('X', 160, 555, { fs: 10 });
    // B9c — RI Source
    drawField(riCourse?.provider_name || '', 329, 553, { fs: 8 });

    // B10a — Prior Hourly Wage
    if (enrollment.prior_hourly_wage) {
      drawField(`$${enrollment.prior_hourly_wage.toFixed(2)}`, 24, 584, { fs: 9 });
    }
    // B10b — Entry Wage
    drawField(`$${tier1 ? tier1.hourly_rate.toFixed(2) : ''}`, 218, 584, { fs: 9 });
    // B10c — Journeyworker Wage
    drawField(`$${enrollment.journeyworker_wage.toFixed(2)}`, 417, 584, { fs: 9 });

    // B10d — Period terms and rates
    if (tier1) {
      drawField(`${tier1.ojl_hours_to ? tier1.ojl_hours_to.toLocaleString() : ''} hrs`, 100, 606, { fs: 8 });
      drawField(`$${tier1.hourly_rate.toFixed(2)}`, 100, 628, { fs: 8 });
    }
    if (tier2) {
      drawField(`${tier2.ojl_hours_to ? tier2.ojl_hours_to.toLocaleString() : ''} hrs`, 160, 606, { fs: 8 });
      drawField(`$${tier2.hourly_rate.toFixed(2)}`, 160, 628, { fs: 8 });
    }

    // B11 — Sponsor Sig 1 + Date
    if (sponsor1Sig) {
      try {
        const sigBytes = fs.readFileSync(path.join(UPLOAD_DIRS.signatures, sponsor1Sig.signature_file_path));
        const sigImage = sponsor1Sig.signature_file_path.endsWith('.png')
          ? await pdfDoc.embedPng(sigBytes)
          : await pdfDoc.embedJpg(sigBytes);
        page.drawImage(sigImage, { x: 24, y: pageHeight - 670, width: 120, height: 18 });
        drawField(new Date(sponsor1Sig.signed_at).toLocaleDateString('en-US'), 220, 658, { fs: 8 });
      } catch (_) { /* signature file missing, skip */ }
    }

    // B12 — Sponsor Sig 2 + Date
    if (sponsor2Sig) {
      try {
        const sigBytes = fs.readFileSync(path.join(UPLOAD_DIRS.signatures, sponsor2Sig.signature_file_path));
        const sigImage = sponsor2Sig.signature_file_path.endsWith('.png')
          ? await pdfDoc.embedPng(sigBytes)
          : await pdfDoc.embedJpg(sigBytes);
        page.drawImage(sigImage, { x: 24, y: pageHeight - 694, width: 120, height: 18 });
        drawField(new Date(sponsor2Sig.signed_at).toLocaleDateString('en-US'), 220, 680, { fs: 8 });
      } catch (_) { /* signature file missing, skip */ }
    }

    // B13 — Complaint Contact
    drawField(SPONSOR.contact, 321, 652, { fs: 8 });
    drawField(`${SPONSOR.address}, ${SPONSOR.city}`, 321, 664, { fs: 7 });
    drawField(SPONSOR.phone, 321, 674, { fs: 8 });

    // ── Part C note ──────────────────────────────────────────────────────
    drawField('[Part C — completed by DOL Registration Agency after RAPIDS submission]', 24, 730, { fs: 8, italic: true, color: gray });

    // Save PDF
    const pdfBytes = await pdfDoc.save();
    const outFilename = `ETA671_${enrollment.employee_name.replace(/[^a-zA-Z0-9]/g, '_')}_${enrollment.track_code}_${Date.now()}.pdf`;
    const outPath = path.join(UPLOAD_DIRS.documents, outFilename);
    fs.writeFileSync(outPath, pdfBytes);

    // Record in documents table
    db.prepare(`
      INSERT INTO appr_documents (enrollment_id, doc_type, file_path, generated_by)
      VALUES (?, 'eta671', ?, ?)
    `).run(id, outFilename, getSessionUserId(req));

    // Send back
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${outFilename}"`);
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error('GET /reports/:id/eta671 error:', err.message);
    res.status(500).json({ error: 'Failed to generate ETA-671' });
  }
});

/** GET /reports/rapids-export — CSV export for RAPIDS submission */
router.get('/reports/rapids-export', (_req, res) => {
  try {
    const db = getDb();
    const enrollments = db.prepare(`
      SELECT e.*, t.title AS track_title, t.occupation, t.rapids_code, t.onet_code,
             t.term_years, t.ojl_hours_required, t.ri_hours_per_year,
             emp.full_name, emp.first_name, emp.last_name
      FROM appr_enrollments e
      JOIN appr_tracks t ON e.track_id = t.id
      JOIN employees emp ON e.employee_id = emp.id
      ORDER BY e.enrollment_date DESC
    `).all();

    // CSV header
    const headers = [
      'Program Number', 'First Name', 'Last Name', 'SSN', 'Occupation', 'RAPIDS Code',
      'ONET Code', 'Term (Years)', 'OJL Hours Required', 'RI Hours/Year',
      'Enrollment Date', 'Expected Completion', 'Status', 'Credit Hours',
      'Probation End Date', 'RAPIDS Apprentice ID'
    ];

    let csv = headers.join(',') + '\n';
    for (const e of enrollments) {
      csv += [
        SPONSOR.regNo,
        `"${e.first_name}"`,
        `"${e.last_name}"`,
        '', // SSN left blank
        `"${e.occupation}"`,
        e.rapids_code,
        e.onet_code,
        e.term_years,
        e.ojl_hours_required,
        e.ri_hours_per_year,
        e.enrollment_date,
        e.expected_completion_date,
        e.status,
        e.credit_hours,
        e.probation_end_date,
        e.rapids_apprentice_id || '',
      ].join(',') + '\n';
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="RAPIDS_Export_${new Date().toISOString().split('T')[0]}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('GET /reports/rapids-export error:', err.message);
    res.status(500).json({ error: 'Failed to generate RAPIDS export' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SELF-SERVICE ROUTES (selfRouter — any authenticated user)
// ═══════════════════════════════════════════════════════════════════════════

/** GET /my-dashboard — apprentice's own progress dashboard */
selfRouter.get('/my-dashboard', (req, res) => {
  try {
    const db = getDb();
    const employeeId = getSessionEmployeeId(req);
    if (!employeeId) return res.status(403).json({ error: 'No employee profile linked' });

    const enrollment = db.prepare(`
      SELECT e.*, t.code AS track_code, t.title AS track_title, t.occupation,
             t.ojl_hours_required, t.ri_hours_per_year, t.term_years, t.approach,
             emp.full_name AS employee_name,
             jw.full_name AS journeyworker_name
      FROM appr_enrollments e
      JOIN appr_tracks t ON e.track_id = t.id
      JOIN employees emp ON e.employee_id = emp.id
      LEFT JOIN employees jw ON e.journeyworker_id = jw.id
      WHERE e.employee_id = ? AND e.status IN ('probation', 'active')
      LIMIT 1
    `).get(employeeId);

    // Signoff queue: tasks pending sign-off for enrollments where this employee is the journeyworker
    const signoffQueue = db.prepare(`
      SELECT wp.id AS task_id, wp.task_label AS task_name, wp.category,
             e.id AS enrollment_id, emp.full_name AS employee_name, t.title AS track_name
      FROM appr_work_processes wp
      JOIN appr_enrollments e ON wp.track_id = e.track_id
      JOIN employees emp ON e.employee_id = emp.id
      JOIN appr_tracks t ON e.track_id = t.id
      LEFT JOIN appr_task_completions tc ON tc.work_process_id = wp.id AND tc.enrollment_id = e.id
      WHERE e.journeyworker_id = ? AND e.status IN ('probation', 'active') AND tc.id IS NULL
      ORDER BY e.id, wp.sort_order
    `).all(employeeId);

    // Return even without own enrollment (journeyworker may not be enrolled)
    if (!enrollment) return res.json({ enrollment: null, signoff_queue: signoffQueue });

    const ojlHours = getCumulativeOJL(enrollment.id);
    const riHours = getCumulativeRI(enrollment.id);
    const totalRiRequired = enrollment.ri_hours_per_year * enrollment.term_years;
    const tasksCompleted = getCompletedTaskCount(enrollment.id);
    const tasksTotal = getTotalTaskCount(enrollment.track_id);

    // Tasks with completion status
    const tasks = db.prepare(`
      SELECT wp.category, wp.task_label, wp.sort_order,
             tc.completed_date, tc.notes AS completion_notes
      FROM appr_work_processes wp
      LEFT JOIN appr_task_completions tc ON tc.work_process_id = wp.id AND tc.enrollment_id = ?
      WHERE wp.track_id = ?
      ORDER BY wp.sort_order
    `).all(enrollment.id, enrollment.track_id);

    // RI courses progress
    const courses = db.prepare(`
      SELECT c.title, c.contact_hours AS required_hours,
             COALESCE(SUM(ra.hours_attended), 0) AS completed_hours
      FROM appr_ri_courses c
      LEFT JOIN appr_ri_attendance ra ON ra.course_id = c.id AND ra.enrollment_id = ?
      WHERE c.track_id = ?
      GROUP BY c.id
      ORDER BY c.sort_order
    `).all(enrollment.id, enrollment.track_id);

    // Next compliance milestone
    const nextEvent = db.prepare(`
      SELECT event_type, due_date,
             CAST(julianday(due_date) - julianday('now') AS INTEGER) AS days_remaining
      FROM appr_compliance_events
      WHERE enrollment_id = ? AND status = 'pending'
      ORDER BY due_date ASC LIMIT 1
    `).get(enrollment.id);

    // Wage info
    const wages = db.prepare('SELECT * FROM appr_wage_schedules WHERE track_id = ? ORDER BY tier').all(enrollment.track_id);
    const currentWage = wages.find(w => w.tier === enrollment.current_wage_tier);

    res.json({
      enrollment,
      progress: {
        ojl_hours: ojlHours,
        ojl_required: enrollment.ojl_hours_required,
        ojl_pct: Math.min(100, Math.round((ojlHours / enrollment.ojl_hours_required) * 100)),
        ri_hours: riHours,
        ri_required: totalRiRequired,
        ri_pct: Math.min(100, Math.round((riHours / totalRiRequired) * 100)),
        tasks_completed: tasksCompleted,
        tasks_total: tasksTotal,
        tasks_pct: tasksTotal > 0 ? Math.round((tasksCompleted / tasksTotal) * 100) : 0,
      },
      tasks,
      courses,
      next_milestone: nextEvent,
      current_wage: currentWage?.hourly_rate || null,
      wages,
      signoff_queue: signoffQueue,
    });
  } catch (err) {
    console.error('GET /my-dashboard error:', err.message);
    res.status(500).json({ error: 'Failed to load apprenticeship dashboard' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MODULE EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = { router, selfRouter, requireApprAccess };
