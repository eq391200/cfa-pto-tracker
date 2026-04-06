/**
 * Attentive & Courteous (A&C) Evaluation routes.
 *
 * Trainers evaluate FOH team members on order-taking and meal-delivery behaviors.
 * Each question is answered Yes / No / N/A.  Score % = yes / (yes + no) * 100.
 */

const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

// ── Question definitions ─────────────────────────────────────────────
const ORDER_TAKING_QUESTIONS = [
  { key: 'warm_welcome',       label: 'Warm Welcome' },
  { key: 'eye_contact',        label: 'Eye Contact' },
  { key: 'smile',              label: 'Smile' },
  { key: 'friendly_tone',      label: 'Friendly Tone' },
  { key: 'my_pleasure',        label: '"My Pleasure"' },
  { key: 'asked_name',         label: 'Asked guest their name' },
  { key: 'how_may_i_serve',    label: '"How may I serve you?"' },
  { key: 'confirmed_order',    label: 'Confirmed order (repeating order)' },
  { key: 'clarifying_questions', label: 'Asked clarifying questions to confirm accuracy' },
  { key: 'asked_sauces',       label: 'Asked for sauces' },
  { key: 'used_name_twice',    label: "Used guest's name at least twice" },
  { key: 'suggestive_selling', label: 'Suggestive selling / Upsold an item' },
  { key: 'fond_farewell',      label: 'Fond farewell' },
  { key: 'moved_guest_forward', label: 'Moved guest forward in the line' }
];

const MEAL_DELIVERY_QUESTIONS = [
  { key: 'reflector_vest',     label: 'Had reflector vest on' },
  { key: 'warm_welcome',       label: 'Warm Welcome — know their name upon arrival' },
  { key: 'eye_contact',        label: 'Eye Contact' },
  { key: 'smile',              label: 'Smile' },
  { key: 'friendly_tone',      label: 'Friendly Tone' },
  { key: 'my_pleasure',        label: '"My Pleasure"' },
  { key: 'asked_name',         label: 'Asked guest their name' },
  { key: 'moved_car_forward',  label: 'Moved car forward if meal was not ready' },
  { key: 'verified_meal',      label: 'Handed meal verifying sauces and confirming order' },
  { key: 'fond_farewell',      label: 'Fond farewell' },
  { key: 'pull_out_right',     label: 'If 2nd/3rd car, asked guest to pull out on the right' }
];

// ── Auth middleware ───────────────────────────────────────────────────
function requireAdminOrTrainer(req, res, next) {
  if (req.session?.role === 'admin') return next();
  if (req.session?.employeeId) {
    const db = getDb();
    const emp = db.prepare('SELECT role FROM employees WHERE id = ?').get(req.session.employeeId);
    if (emp && ['Trainer', 'Director', 'Senior Director', 'Shift Leader'].includes(emp.role)) {
      return next();
    }
  }
  res.status(403).json({ error: 'Trainer access required' });
}

// ── GET /api/ac-evaluations/questions — Question definitions ─────────
router.get('/questions', (req, res) => {
  res.json({ order_taking: ORDER_TAKING_QUESTIONS, meal_delivery: MEAL_DELIVERY_QUESTIONS });
});

// ── GET /api/ac-evaluations — List all evaluations ───────────────────
router.get('/', requireAdminOrTrainer, (req, res) => {
  try {
    const db = getDb();
    const { employee_id, eval_type, days, evaluator_id } = req.query;

    let sql = `
      SELECT ac.*, e.full_name AS employee_name, ev.full_name AS evaluator_name
      FROM ac_evaluations ac
      JOIN employees e ON e.id = ac.employee_id
      JOIN employees ev ON ev.id = ac.evaluator_id
      WHERE 1=1
    `;
    const params = [];

    if (employee_id) { sql += ' AND ac.employee_id = ?'; params.push(employee_id); }
    if (eval_type) { sql += ' AND ac.eval_type = ?'; params.push(eval_type); }
    if (evaluator_id) { sql += ' AND ac.evaluator_id = ?'; params.push(evaluator_id); }
    if (days) {
      sql += " AND ac.eval_date >= date('now', '-' || ? || ' days')";
      params.push(parseInt(days));
    }

    sql += ' ORDER BY ac.eval_date DESC, ac.created_at DESC';
    res.json(db.prepare(sql).all(...params));
  } catch (err) {
    console.error('Error listing A&C evals:', err.message);
    res.status(500).json({ error: 'Failed to load evaluations' });
  }
});

// ── GET /api/ac-evaluations/employee/:id — Evals for one employee ────
router.get('/employee/:id', (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;

    // Employees can see their own; trainers/admins can see any
    if (req.session.role !== 'admin' && (!req.session.employeeId || parseInt(id) !== req.session.employeeId)) {
      const emp = db.prepare('SELECT role FROM employees WHERE id = ?').get(req.session.employeeId);
      if (!emp || !['Trainer', 'Director', 'Senior Director', 'Shift Leader'].includes(emp.role)) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const evals = db.prepare(`
      SELECT ac.*, ev.full_name AS evaluator_name
      FROM ac_evaluations ac
      JOIN employees ev ON ev.id = ac.evaluator_id
      WHERE ac.employee_id = ?
      ORDER BY ac.eval_date DESC, ac.created_at DESC
    `).all(id);

    res.json(evals);
  } catch (err) {
    console.error('Error loading employee A&C evals:', err.message);
    res.status(500).json({ error: 'Failed to load evaluations' });
  }
});

// ── GET /api/ac-evaluations/gaps — Gap analysis ──────────────────────
router.get('/gaps', requireAdminOrTrainer, (req, res) => {
  try {
    const db = getDb();
    const { days, employee_id, eval_type } = req.query;

    let sql = 'SELECT responses, eval_type FROM ac_evaluations WHERE 1=1';
    const params = [];

    if (days) {
      sql += " AND eval_date >= date('now', '-' || ? || ' days')";
      params.push(parseInt(days));
    }
    if (employee_id) { sql += ' AND employee_id = ?'; params.push(employee_id); }
    if (eval_type) { sql += ' AND eval_type = ?'; params.push(eval_type); }

    const rows = db.prepare(sql).all(...params);

    // Aggregate per-question counts
    const questionStats = {};
    let totalEvals = rows.length;
    let totalScore = 0;

    for (const row of rows) {
      const resp = JSON.parse(row.responses);
      const questions = row.eval_type === 'order_taking' ? ORDER_TAKING_QUESTIONS : MEAL_DELIVERY_QUESTIONS;

      for (const q of questions) {
        if (!questionStats[q.key]) {
          questionStats[q.key] = { key: q.key, label: q.label, eval_type: row.eval_type, yes: 0, no: 0, na: 0 };
        }
        const val = resp[q.key];
        if (val === 'yes') questionStats[q.key].yes++;
        else if (val === 'no') questionStats[q.key].no++;
        else questionStats[q.key].na++;
      }
    }

    // Calculate pass rate and sort worst-first
    const gaps = Object.values(questionStats).map(q => {
      const applicable = q.yes + q.no;
      const passRate = applicable > 0 ? Math.round((q.yes / applicable) * 100) : 100;
      return { ...q, applicable, pass_rate: passRate };
    }).sort((a, b) => a.pass_rate - b.pass_rate);

    // Average score
    for (const row of rows) {
      const resp = JSON.parse(row.responses);
      let yes = 0, total = 0;
      for (const [, v] of Object.entries(resp)) {
        if (v === 'yes') { yes++; total++; }
        else if (v === 'no') { total++; }
      }
      if (total > 0) totalScore += (yes / total) * 100;
    }

    res.json({
      gaps,
      total_evals: totalEvals,
      avg_score: totalEvals > 0 ? Math.round(totalScore / totalEvals) : 0
    });
  } catch (err) {
    console.error('Error computing A&C gaps:', err.message);
    res.status(500).json({ error: 'Failed to compute gaps' });
  }
});

// ── GET /api/ac-evaluations/trends — Score trends over time ──────────
router.get('/trends', requireAdminOrTrainer, (req, res) => {
  try {
    const db = getDb();
    const { days, employee_id, eval_type } = req.query;

    let sql = `
      SELECT eval_date, AVG(score_pct) as avg_score, COUNT(*) as eval_count
      FROM ac_evaluations WHERE 1=1
    `;
    const params = [];

    if (days) {
      sql += " AND eval_date >= date('now', '-' || ? || ' days')";
      params.push(parseInt(days));
    }
    if (employee_id) { sql += ' AND employee_id = ?'; params.push(employee_id); }
    if (eval_type) { sql += ' AND eval_type = ?'; params.push(eval_type); }

    sql += ' GROUP BY eval_date ORDER BY eval_date';

    res.json(db.prepare(sql).all(...params));
  } catch (err) {
    console.error('Error computing A&C trends:', err.message);
    res.status(500).json({ error: 'Failed to compute trends' });
  }
});

// ── POST /api/ac-evaluations — Submit new evaluation ─────────────────
router.post('/', requireAdminOrTrainer, (req, res) => {
  try {
    const db = getDb();
    const { employee_id, eval_type, location, responses, comments } = req.body;

    if (!employee_id || !eval_type || !location || !responses) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (typeof responses !== 'object' || responses === null || Array.isArray(responses)) {
      return res.status(400).json({ error: 'responses must be a JSON object' });
    }

    // Validate eval_type
    if (!['order_taking', 'meal_delivery'].includes(eval_type)) {
      return res.status(400).json({ error: 'Invalid eval_type' });
    }

    // Validate location
    if (!['front_counter', 'drive_thru'].includes(location)) {
      return res.status(400).json({ error: 'Invalid location' });
    }

    // Validate employee is FOH
    const emp = db.prepare('SELECT department FROM employees WHERE id = ?').get(employee_id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    if (emp.department === 'BOH') {
      return res.status(400).json({ error: 'A&C evaluations are for FOH employees only' });
    }

    // Calculate counts
    let yesCount = 0, noCount = 0, naCount = 0;
    for (const [, v] of Object.entries(responses)) {
      if (v === 'yes') yesCount++;
      else if (v === 'no') noCount++;
      else naCount++;
    }
    const totalApplicable = yesCount + noCount;
    const scorePct = totalApplicable > 0 ? Math.round((yesCount / totalApplicable) * 10000) / 100 : 0;

    // Determine evaluator
    const evaluatorId = req.session.role === 'admin'
      ? (req.body.evaluator_id || req.session.employeeId || 0)
      : req.session.employeeId;

    const today = new Date().toISOString().split('T')[0];

    const result = db.prepare(`
      INSERT INTO ac_evaluations (employee_id, evaluator_id, eval_date, eval_type, location, responses, yes_count, no_count, na_count, total_applicable, score_pct, comments)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(employee_id, evaluatorId, today, eval_type, location, JSON.stringify(responses), yesCount, noCount, naCount, totalApplicable, scorePct, comments || null);

    res.json({ success: true, id: result.lastInsertRowid, score_pct: scorePct });
  } catch (err) {
    console.error('Error submitting A&C eval:', err.message);
    res.status(500).json({ error: 'Failed to submit evaluation' });
  }
});

// ── DELETE /api/ac-evaluations/:id — Delete an evaluation ────────────
// Admins can delete any; trainers can delete their own submissions only
router.delete('/:id', requireAdminOrTrainer, (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const ev = db.prepare('SELECT * FROM ac_evaluations WHERE id = ?').get(id);
    if (!ev) return res.status(404).json({ error: 'Evaluation not found' });

    // Trainers can only delete their own submissions
    if (req.session.role !== 'admin' && ev.evaluator_id !== req.session.employeeId) {
      return res.status(403).json({ error: 'You can only delete evaluations you submitted' });
    }

    db.prepare('DELETE FROM ac_evaluations WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting A&C eval:', err.message);
    res.status(500).json({ error: 'Failed to delete evaluation' });
  }
});

// ── GET /api/ac-evaluations/export — Excel export ────────────────────
router.get('/export', (req, res) => {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const db = getDb();
    const XLSX = require('xlsx');

    const rows = db.prepare(`
      SELECT ac.*, e.full_name AS employee_name, ev.full_name AS evaluator_name
      FROM ac_evaluations ac
      JOIN employees e ON e.id = ac.employee_id
      JOIN employees ev ON ev.id = ac.evaluator_id
      ORDER BY ac.eval_date DESC
    `).all();

    const data = rows.map(r => {
      const resp = JSON.parse(r.responses);
      return {
        Date: r.eval_date,
        Employee: r.employee_name,
        Evaluator: r.evaluator_name,
        Type: r.eval_type === 'order_taking' ? 'Order Taking' : 'Meal Delivery',
        Location: r.location === 'front_counter' ? 'Front Counter' : 'Drive Thru',
        'Score %': r.score_pct,
        Yes: r.yes_count,
        No: r.no_count,
        'N/A': r.na_count,
        Comments: r.comments || '',
        ...resp
      };
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, 'Hospitality Evaluations');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="hospitality-evaluations.xlsx"');
    res.send(buf);
  } catch (err) {
    console.error('Error exporting A&C evals:', err.message);
    res.status(500).json({ error: 'Failed to export evaluations' });
  }
});

module.exports = router;
