/**
 * Time-off request routes — submit, list, approve/reject, cancel.
 *
 * Employees submit requests; admins review them. On approval, the
 * requested days are automatically recorded in time_off_taken.
 * Email + Slack DM notifications are sent when configured.
 */

const express = require('express');
const { getDb } = require('../db');
const { sendRequestSubmitted, sendRequestReviewed, isConfigured } = require('../services/emailService');
const { sendSlackDM, isBotConfigured } = require('../services/slackService');

const router = express.Router();

// ── POST /api/requests — Employee submits a time-off or punch adjustment request ────────
router.post('/', (req, res) => {
  try {
    const { employee_id, type, reason } = req.body;

    // Basic validation
    if (!employee_id || !type) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!['vacation', 'sick', 'punch_adjustment'].includes(type)) {
      return res.status(400).json({ error: 'Type must be vacation, sick, or punch_adjustment' });
    }

    const db = getDb();

    // ── Punch Adjustment flow ──
    if (type === 'punch_adjustment') {
      const { punch_date, clock_in, clock_out, break_start, break_end } = req.body;

      if (!punch_date || !clock_in || !clock_out) {
        return res.status(400).json({ error: 'Missing required fields: date, clock-in, and clock-out are required' });
      }

      // Punch date must not be in the future
      const punchDt = new Date(punch_date + 'T00:00:00');
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (isNaN(punchDt.getTime())) {
        return res.status(400).json({ error: 'Invalid date format' });
      }
      if (punchDt >= today) {
        return res.status(400).json({ error: 'Punch date must be in the past' });
      }

      // Clock-out must be after clock-in
      if (clock_out <= clock_in) {
        return res.status(400).json({ error: 'Clock-out time must be after clock-in time' });
      }

      // Break validation: both or neither, end after start, within work hours
      if ((break_start && !break_end) || (!break_start && break_end)) {
        return res.status(400).json({ error: 'Please provide both break start and end times, or leave both empty' });
      }
      if (break_start && break_end) {
        if (break_end <= break_start) {
          return res.status(400).json({ error: 'Break end time must be after break start time' });
        }
        if (break_start < clock_in || break_end > clock_out) {
          return res.status(400).json({ error: 'Break times must fall within clock-in and clock-out range' });
        }
      }

      db.prepare(`
        INSERT INTO time_off_requests
          (employee_id, type, days_requested, start_date, end_date, reason,
           punch_date, clock_in, clock_out, break_start, break_end)
        VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        employee_id, type, punch_date, punch_date, reason || null,
        punch_date, clock_in, clock_out, break_start || null, break_end || null
      );

      // Notify admin via email (non-blocking)
      notifyAdminOfRequest(db, employee_id, {
        type, punch_date, clock_in, clock_out, break_start, break_end, reason
      });

      return res.json({ success: true });
    }

    // ── Time-off (vacation/sick) flow ──
    const { days_requested, start_date, end_date } = req.body;

    if (!days_requested || !start_date || !end_date) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Date validation
    const startDt = new Date(start_date + 'T00:00:00');
    const endDt = new Date(end_date + 'T00:00:00');

    if (isNaN(startDt.getTime()) || isNaN(endDt.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' });
    }
    if (endDt < startDt) {
      return res.status(400).json({ error: 'End date must be on or after start date' });
    }
    const calendarDays = Math.ceil((endDt - startDt) / (1000 * 60 * 60 * 24)) + 1;
    if (days_requested > calendarDays) {
      return res.status(400).json({ error: `Days requested (${days_requested}) exceeds date range (${calendarDays} calendar days)` });
    }

    // Balance check: earned − taken − pending ≥ requested
    const earnedSql = {
      sick: 'SELECT COALESCE(SUM(sick_days_earned), 0) AS total FROM accruals WHERE employee_id = ?',
      vacation: 'SELECT COALESCE(SUM(vacation_days_earned), 0) AS total FROM accruals WHERE employee_id = ?'
    };
    const earned = db.prepare(earnedSql[type]).get(employee_id);

    const taken = db.prepare(
      'SELECT COALESCE(SUM(days_taken), 0) AS total FROM time_off_taken WHERE employee_id = ? AND type = ?'
    ).get(employee_id, type);

    const pendingReqs = db.prepare(
      "SELECT COALESCE(SUM(days_requested), 0) AS total FROM time_off_requests WHERE employee_id = ? AND type = ? AND status = 'pending'"
    ).get(employee_id, type);

    const balance = earned.total - taken.total - pendingReqs.total;
    if (days_requested > balance) {
      return res.status(400).json({
        error: `Insufficient ${type} balance. Available: ${balance.toFixed(2)} days (including pending requests)`
      });
    }

    db.prepare(`
      INSERT INTO time_off_requests (employee_id, type, days_requested, start_date, end_date, reason)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(employee_id, type, days_requested, start_date, end_date, reason || null);

    // Notify admin via email (non-blocking)
    notifyAdminOfRequest(db, employee_id, { type, days_requested, start_date, end_date, reason });

    res.json({ success: true });
  } catch (err) {
    console.error('Error submitting request:', err.message);
    res.status(500).json({ error: 'Failed to submit request' });
  }
});

// ── GET /api/requests — List requests (admin=all, employee=own) ─────
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const { status: filterStatus } = req.query;
    let sql;
    const params = [];

    if (req.session.role === 'admin') {
      sql = `
        SELECT r.*, e.first_name, e.last_name, e.full_name
        FROM time_off_requests r JOIN employees e ON r.employee_id = e.id
      `;
      if (filterStatus) {
        sql += ' WHERE r.status = ?';
        params.push(filterStatus);
      }
    } else {
      sql = `
        SELECT r.*, e.first_name, e.last_name, e.full_name
        FROM time_off_requests r JOIN employees e ON r.employee_id = e.id
        WHERE r.employee_id = ?
      `;
      params.push(req.session.employeeId);
      if (filterStatus) {
        sql += ' AND r.status = ?';
        params.push(filterStatus);
      }
    }

    sql += ' ORDER BY r.created_at DESC';
    res.json(db.prepare(sql).all(...params));
  } catch (err) {
    console.error('Error loading requests:', err.message);
    res.status(500).json({ error: 'Failed to load requests' });
  }
});

// ── PUT /api/requests/:id — Admin approves/rejects a request ────────
router.put('/:id', (req, res) => {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    const db = getDb();
    const { action, review_notes } = req.body; // 'approve' or 'reject'
    const { id } = req.params;

    const request = db.prepare('SELECT * FROM time_off_requests WHERE id = ?').get(id);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.status !== 'pending') return res.status(400).json({ error: 'Request is no longer pending' });

    const newStatus = action === 'approve' ? 'approved' : 'rejected';

    // Approval: update request + insert into time_off_taken (atomic)
    const processRequest = db.transaction(() => {
      db.prepare(`
        UPDATE time_off_requests
        SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, review_notes = ?
        WHERE id = ?
      `).run(newStatus, req.session.username, review_notes || null, id);

      if (newStatus === 'approved' && request.type !== 'punch_adjustment') {
        db.prepare(`
          INSERT INTO time_off_taken (employee_id, type, days_taken, date_taken, notes, entered_by)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(request.employee_id, request.type, request.days_requested, request.start_date, `Approved request #${id}`, req.session.username);
      }
    });

    processRequest();

    // Notify employee via email (non-blocking)
    notifyEmployeeOfReview(db, request, newStatus, review_notes);

    res.json({ success: true, status: newStatus });
  } catch (err) {
    console.error('Error reviewing request:', err.message);
    res.status(500).json({ error: 'Failed to review request' });
  }
});

// ── DELETE /api/requests/:id — Cancel a pending request ─────────────
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const request = db.prepare('SELECT * FROM time_off_requests WHERE id = ?').get(id);

    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending requests can be cancelled' });
    }
    // Non-admin can only cancel their own requests
    if (req.session.role !== 'admin' && request.employee_id !== req.session.employeeId) {
      return res.status(403).json({ error: 'You can only cancel your own requests' });
    }

    db.prepare("UPDATE time_off_requests SET status = 'cancelled' WHERE id = ?").run(id);
    res.json({ success: true });
  } catch (err) {
    console.error('Error cancelling request:', err.message);
    res.status(500).json({ error: 'Failed to cancel request' });
  }
});

// ── Notification helpers — email + Slack (fire-and-forget) ──────────

function notifyAdminOfRequest(db, employeeId, request) {
  try {
    const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
    if (!employee) return;
    const employeeName = `${employee.first_name} ${employee.last_name}`;

    // Email notification
    if (isConfigured()) {
      const adminEmailRow = db.prepare("SELECT setting_value FROM notification_settings WHERE setting_key = 'admin_email'").get();
      if (adminEmailRow?.setting_value) {
        sendRequestSubmitted(employeeName, request, adminEmailRow.setting_value)
          .catch(err => console.error('Email notification failed:', err.message));
      }
    }

    // Slack DM to admin
    if (isBotConfigured()) {
      const adminSlackRow = db.prepare("SELECT setting_value FROM notification_settings WHERE setting_key = 'admin_slack_id'").get();
      const adminSlackId = adminSlackRow?.setting_value;
      if (adminSlackId) {
        let msg;
        if (request.type === 'punch_adjustment') {
          msg = `📋 *${employeeName}* submitted a *punch adjustment* request for ${request.punch_date} (${request.clock_in} - ${request.clock_out}).`;
        } else {
          msg = `📋 *${employeeName}* submitted a *${request.type}* request for ${request.days_requested} day${request.days_requested !== 1 ? 's' : ''} (${request.start_date} to ${request.end_date}).`;
        }
        if (request.reason) msg += `\n📝 Notes: ${request.reason}`;
        msg += `\n<https://cfalarambla.com|Review on Admin Hub>`;
        sendSlackDM(adminSlackId, msg)
          .catch(err => console.error('Admin Slack DM notification failed:', err.message));
      }
    }
  } catch (err) {
    console.error('Admin notification error:', err.message);
  }
}

function notifyEmployeeOfReview(db, request, newStatus, reviewNotes) {
  try {
    const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(request.employee_id);
    if (!employee) return;

    // Email notification
    if (isConfigured() && employee.email) {
      sendRequestReviewed(
        `${employee.first_name} ${employee.last_name}`,
        newStatus,
        employee.email,
        { ...request, review_notes: reviewNotes || null }
      ).catch(err => console.error('Email notification failed:', err.message));
    }

    // Slack DM notification
    if (isBotConfigured() && employee.slack_user_id) {
      const icon = newStatus === 'approved' ? '✅' : '❌';
      const label = newStatus === 'approved' ? 'approved' : 'rejected';
      let msg;
      if (request.type === 'punch_adjustment') {
        msg = `${icon} Your *punch adjustment* request for ${request.punch_date} (${request.clock_in} - ${request.clock_out}) has been *${label}*.`;
      } else {
        msg = `${icon} Your *${request.type}* request (${request.days_requested} day${request.days_requested !== 1 ? 's' : ''}, ${request.start_date} to ${request.end_date}) has been *${label}*.`;
      }
      if (reviewNotes) msg += `\n📝 Notes: ${reviewNotes}`;
      sendSlackDM(employee.slack_user_id, msg)
        .catch(err => console.error('Slack DM notification failed:', err.message));
    }
  } catch (err) {
    console.error('Employee notification error:', err.message);
  }
}

module.exports = router;
