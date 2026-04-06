/**
 * Leadership Academy routes.
 *
 * Handles candidate enrollment, checkpoint tracking, learning resources,
 * analytics, and candidate self-service for the Leadership Academy module.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../db');
const { sendSlackDM, isBotConfigured } = require('../services/slackService');
const router = express.Router();

const LA_TIER_NAMES = { 1: "Fase 1 — A Servant's Heart", 2: 'Fase 2 — Emerging Servant Leader', 3: 'Fase 3 — Business Leader', 4: 'Fase 4 — Senior Leader' };

// File upload config for evidence files
const evidenceStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../data/la-evidence');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const safe = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_').substring(0, 50);
    cb(null, `${Date.now()}-${safe}`);
  }
});
const evidenceUpload = multer({
  storage: evidenceStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.doc', '.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

// ── Auth Helpers ─────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session?.role === 'admin') return next();
  res.status(403).json({ error: 'Admin access required' });
}

function requireAdminOrDirector(req, res, next) {
  if (req.session?.role === 'admin') return next();
  if (req.session?.employeeId) {
    const db = getDb();
    const emp = db.prepare('SELECT role FROM employees WHERE id = ?').get(req.session.employeeId);
    if (emp && ['Director', 'Senior Director', 'Shift Leader', 'Instructor'].includes(emp.role)) return next();
  }
  res.status(403).json({ error: 'Director access required' });
}

const TIER_NAMES = { 1: 'Foundations', 2: 'Emerging Leaders', 3: 'Senior Director' };

// ── Reference Data ───────────────────────────────────────────────────
router.get('/competency-areas', (req, res) => {
  try {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM la_competency_areas ORDER BY sort_order').all());
  } catch (err) {
    console.error('Error loading competency areas:', err.message);
    res.status(500).json({ error: 'Failed to load competency areas' });
  }
});

router.get('/checkpoints', (req, res) => {
  try {
    const db = getDb();
    const { tier, area_id } = req.query;
    let sql = `SELECT c.*, a.name as area_name, a.slug as area_slug
               FROM la_checkpoints c
               JOIN la_competency_areas a ON a.id = c.competency_area_id
               WHERE 1=1`;
    const params = [];
    if (tier) { sql += ' AND c.tier = ?'; params.push(tier); }
    if (area_id) { sql += ' AND c.competency_area_id = ?'; params.push(area_id); }
    sql += ' ORDER BY a.sort_order, c.tier, c.sort_order';
    res.json(db.prepare(sql).all(...params));
  } catch (err) {
    console.error('Error loading checkpoints:', err.message);
    res.status(500).json({ error: 'Failed to load checkpoints' });
  }
});

// ── Candidate Management (Admin/Director) ────────────────────────────
router.get('/candidates', requireAdminOrDirector, (req, res) => {
  try {
    const db = getDb();
    const { status } = req.query;
    let sql = `SELECT c.*, e.full_name, e.first_name, e.last_name, e.department, e.role as emp_role,
               (SELECT COUNT(*) FROM la_checkpoint_progress p WHERE p.candidate_id = c.id AND p.status IN ('completed', 'skill_4', 'skill_5')) as completed_count,
               (SELECT COUNT(*) FROM la_checkpoint_progress p WHERE p.candidate_id = c.id) as total_count
               FROM la_candidates c
               JOIN employees e ON e.id = c.employee_id
               WHERE 1=1`;
    const params = [];
    if (status) { sql += ' AND c.status = ?'; params.push(status); }
    sql += ' ORDER BY e.last_name, e.first_name';
    res.json(db.prepare(sql).all(...params));
  } catch (err) {
    console.error('Error loading candidates:', err.message);
    res.status(500).json({ error: 'Failed to load candidates' });
  }
});

router.post('/candidates', requireAdminOrDirector, (req, res) => {
  try {
    const db = getDb();
    const { employee_id, target_ldp_date, current_tier } = req.body;
    if (!employee_id) return res.status(400).json({ error: 'Employee ID is required' });

    const emp = db.prepare('SELECT id FROM employees WHERE id = ?').get(employee_id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const existing = db.prepare('SELECT id FROM la_candidates WHERE employee_id = ?').get(employee_id);
    if (existing) return res.status(400).json({ error: 'Employee is already enrolled' });

    const tier = Math.min(Math.max(parseInt(current_tier) || 1, 1), 4);

    db.transaction(() => {
      const result = db.prepare(
        'INSERT INTO la_candidates (employee_id, current_tier, enrolled_by, target_ldp_date) VALUES (?, ?, ?, ?)'
      ).run(employee_id, tier, req.session.username || 'admin', target_ldp_date || null);

      const candidateId = result.lastInsertRowid;

      // Auto-populate checkpoint progress for all checkpoints
      db.prepare(`
        INSERT INTO la_checkpoint_progress (candidate_id, checkpoint_id, status)
        SELECT ?, id, 'not_started' FROM la_checkpoints
      `).run(candidateId);
    })();

    // Send Slack DM to the enrolled employee + copy admin (async, don't block response)
    const empData = db.prepare('SELECT first_name, last_name, slack_user_id FROM employees WHERE id = ?').get(employee_id);
    if (isBotConfigured()) {
      const tierName = LA_TIER_NAMES[tier] || 'Fase ' + tier;
      const empName = `${empData.first_name} ${empData.last_name}`;

      // DM to employee
      if (empData.slack_user_id) {
        // Check if employee has a portal account
        const hasAccount = db.prepare('SELECT username FROM users WHERE employee_id = ?').get(employee_id);
        const loginInfo = hasAccount
          ? `\n🔑 *Cómo acceder:*\n` +
            `1. Ve a <https://cfalarambla.com|cfalarambla.com>\n` +
            `2. Ingresa tu PIN como usuario: \`${hasAccount.username}\`\n` +
            `3. Si es tu primera vez, usa tu PIN también como contraseña\n` +
            `4. El sistema te pedirá crear una nueva contraseña\n` +
            `5. Una vez dentro, busca la pestaña *"Leadership Academy"* en tu portal\n`
          : `\n🔑 *Acceso al portal:*\n` +
            `Tu líder te compartirá tus credenciales de acceso a <https://cfalarambla.com|cfalarambla.com>. ` +
            `Una vez dentro, busca la pestaña *"Leadership Academy"* en tu portal.\n`;

        const empMsg = `🎓 *¡Felicidades ${empData.first_name}!*\n\n` +
          `Has sido seleccionado/a para la *Academia de Liderazgo* de Chick-fil-A La Rambla. ` +
          `Esto significa que hemos visto en ti cualidades de liderazgo y queremos invertir en tu crecimiento.\n\n` +
          `📋 *Nivel:* ${tierName}\n` +
          (target_ldp_date ? `📅 *Fecha objetivo:* ${target_ldp_date}\n` : '') +
          loginInfo +
          `\n📚 *¿Qué encontrarás?*\n` +
          `• Videos, artículos y libros de liderazgo\n` +
          `• Módulos de desarrollo en 5 áreas clave\n` +
          `• Tu progreso personal con evaluaciones de tu líder\n\n` +
          `Si tienes alguna pregunta, habla con tu Director o Líder de Turno.\n\n` +
          `_"El liderazgo no es un título, es una decisión."_ — Chick-fil-A 🐔❤️`;
        sendSlackDM(empData.slack_user_id, empMsg).catch(err => {
          console.error('Failed to send LA enrollment Slack DM:', err.message);
        });
      }

      // Copy to admin
      const adminSlackId = process.env.ADMIN_SLACK_USER_ID;
      if (adminSlackId) {
        const adminMsg = `🎓 *Nuevo candidato inscrito en la Academia de Liderazgo*\n\n` +
          `👤 *Empleado:* ${empName}\n` +
          `📋 *Nivel:* ${tierName}\n` +
          (target_ldp_date ? `📅 *Fecha objetivo:* ${target_ldp_date}\n` : '') +
          `📝 *Inscrito por:* ${req.session.username || 'admin'}`;
        sendSlackDM(adminSlackId, adminMsg).catch(err => {
          console.error('Failed to send LA enrollment admin Slack DM:', err.message);
        });
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error enrolling candidate:', err.message);
    res.status(500).json({ error: 'Failed to enroll candidate' });
  }
});

router.put('/candidates/:id', requireAdminOrDirector, (req, res) => {
  try {
    const db = getDb();
    const { current_tier, status, target_ldp_date } = req.body;
    const candidate = db.prepare('SELECT * FROM la_candidates WHERE id = ?').get(req.params.id);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

    const newTier = current_tier || candidate.current_tier;
    const newStatus = status || candidate.status;
    const newTarget = target_ldp_date !== undefined ? target_ldp_date : candidate.target_ldp_date;
    const graduatedAt = newStatus === 'graduated' && candidate.status !== 'graduated' ? new Date().toISOString() : candidate.graduated_at;

    db.prepare(`
      UPDATE la_candidates SET current_tier = ?, status = ?, target_ldp_date = ?, graduated_at = ? WHERE id = ?
    `).run(newTier, newStatus, newTarget, graduatedAt, req.params.id);

    res.json({ success: true });
  } catch (err) {
    console.error('Error updating candidate:', err.message);
    res.status(500).json({ error: 'Failed to update candidate' });
  }
});

router.delete('/candidates/:id', requireAdminOrDirector, (req, res) => {
  try {
    const db = getDb();
    db.transaction(() => {
      db.prepare('DELETE FROM la_resource_progress WHERE candidate_id = ?').run(req.params.id);
      db.prepare('DELETE FROM la_checkpoint_progress WHERE candidate_id = ?').run(req.params.id);
      db.prepare('DELETE FROM la_candidates WHERE id = ?').run(req.params.id);
    })();
    res.json({ success: true });
  } catch (err) {
    console.error('Error removing candidate:', err.message);
    res.status(500).json({ error: 'Failed to remove candidate' });
  }
});

router.get('/candidates/:id', requireAdminOrDirector, (req, res) => {
  try {
    const db = getDb();
    const candidate = db.prepare(`
      SELECT c.*, e.full_name, e.first_name, e.last_name, e.department, e.role as emp_role
      FROM la_candidates c JOIN employees e ON e.id = c.employee_id
      WHERE c.id = ?
    `).get(req.params.id);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

    const checkpoints = db.prepare(`
      SELECT p.*, cp.code, cp.title, cp.description, cp.evidence_required, cp.tier, cp.sort_order, cp.image_url, cp.resource_url, cp.buy_url,
             a.id as area_id, a.name as area_name, a.slug as area_slug, a.icon as area_icon
      FROM la_checkpoint_progress p
      JOIN la_checkpoints cp ON cp.id = p.checkpoint_id
      JOIN la_competency_areas a ON a.id = cp.competency_area_id
      WHERE p.candidate_id = ?
      ORDER BY a.sort_order, cp.tier, cp.sort_order
    `).all(req.params.id);

    const resources = db.prepare(`
      SELECT r.*, COALESCE(rp.completed, 0) as completed, rp.completed_at
      FROM la_learning_resources r
      LEFT JOIN la_resource_progress rp ON rp.resource_id = r.id AND rp.candidate_id = ?
      WHERE r.tier <= ?
      ORDER BY r.tier, r.sort_order
    `).all(req.params.id, candidate.current_tier);

    res.json({ candidate, checkpoints, resources });
  } catch (err) {
    console.error('Error loading candidate detail:', err.message);
    res.status(500).json({ error: 'Failed to load candidate' });
  }
});

// ── Checkpoint Approval (Admin/Director) ─────────────────────────────
router.put('/checkpoints/:progressId', requireAdminOrDirector, (req, res) => {
  try {
    const db = getDb();
    const { status, rating, leader_notes } = req.body;
    const progress = db.prepare('SELECT * FROM la_checkpoint_progress WHERE id = ?').get(req.params.progressId);
    if (!progress) return res.status(404).json({ error: 'Checkpoint progress not found' });

    const newStatus = status || progress.status;
    const newRating = rating !== undefined ? rating : progress.rating;
    const newNotes = leader_notes !== undefined ? leader_notes : progress.leader_notes;
    const approvedBy = newStatus === 'completed' ? (req.session.employeeId || null) : progress.approved_by;
    const approvedAt = newStatus === 'completed' && !progress.approved_at ? new Date().toISOString() : progress.approved_at;
    const completedDate = newStatus === 'completed' ? (progress.completed_date || new Date().toISOString().split('T')[0]) : progress.completed_date;

    db.prepare(`
      UPDATE la_checkpoint_progress
      SET status = ?, rating = ?, leader_notes = ?, approved_by = ?, approved_at = ?, completed_date = ?
      WHERE id = ?
    `).run(newStatus, newRating, newNotes, approvedBy, approvedAt, completedDate, req.params.progressId);

    // ── Send Slack notification to candidate ──
    if (isBotConfigured()) {
      try {
        const candidate = db.prepare(`
          SELECT c.employee_id, e.first_name, e.slack_user_id
          FROM la_candidates c JOIN employees e ON c.employee_id = e.id
          WHERE c.id = ?
        `).get(progress.candidate_id);

        const checkpoint = db.prepare(`
          SELECT cp.code, cp.title, ca.name as area_name
          FROM la_checkpoints cp JOIN la_competency_areas ca ON cp.competency_area_id = ca.id
          WHERE cp.id = ?
        `).get(progress.checkpoint_id);

        if (candidate?.slack_user_id && checkpoint) {
          const leaderName = req.session.employeeId
            ? db.prepare('SELECT first_name FROM employees WHERE id = ?').get(req.session.employeeId)?.first_name || 'Your leader'
            : 'Your leader';

          let msg = '';
          if (newStatus === 'completed' && !progress.approved_at) {
            const stars = newRating ? ' (' + '★'.repeat(newRating) + '☆'.repeat(4 - newRating) + ')' : '';
            msg = `🎓 *Leadership Academy — Checkpoint Approved!*\n\n✅ *${checkpoint.code}: ${checkpoint.title}*\n📂 ${checkpoint.area_name}\n👤 Approved by: ${leaderName}${stars}`;
            if (newNotes) msg += `\n💬 Feedback: ${newNotes}`;
            msg += `\n\nGreat work, ${candidate.first_name}! Keep pushing forward 💪`;
          } else if (leader_notes !== undefined && leader_notes !== progress.leader_notes) {
            msg = `🎓 *Leadership Academy — New Feedback*\n\n📝 *${checkpoint.code}: ${checkpoint.title}*\n📂 ${checkpoint.area_name}\n👤 From: ${leaderName}\n💬 "${leader_notes}"`;
          } else if (rating !== undefined && rating !== progress.rating) {
            const stars = '★'.repeat(rating) + '☆'.repeat(4 - rating);
            msg = `🎓 *Leadership Academy — Rating Updated*\n\n📝 *${checkpoint.code}: ${checkpoint.title}*\n📂 ${checkpoint.area_name}\n⭐ New rating: ${stars} (${rating}/4)`;
          }

          if (msg) {
            sendSlackDM(candidate.slack_user_id, msg).catch(err => {
              console.error('LA notification Slack error:', err.message);
            });
          }
        }
      } catch (slackErr) {
        console.error('LA notification error:', slackErr.message);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error updating checkpoint:', err.message);
    res.status(500).json({ error: 'Failed to update checkpoint' });
  }
});

// ── Analytics (Admin/Director) ───────────────────────────────────────
router.get('/analytics', requireAdminOrDirector, (req, res) => {
  try {
    const db = getDb();

    // Tier pipeline
    const pipeline = db.prepare(`
      SELECT current_tier, COUNT(*) as count FROM la_candidates WHERE status = 'active' GROUP BY current_tier
    `).all();

    const graduated = db.prepare("SELECT COUNT(*) as count FROM la_candidates WHERE status = 'graduated'").get();

    // Competency completion rates
    const competencyRates = db.prepare(`
      SELECT a.name, a.slug,
        COUNT(CASE WHEN p.status = 'completed' THEN 1 END) as completed,
        COUNT(p.id) as total
      FROM la_checkpoint_progress p
      JOIN la_checkpoints cp ON cp.id = p.checkpoint_id
      JOIN la_competency_areas a ON a.id = cp.competency_area_id
      JOIN la_candidates c ON c.id = p.candidate_id AND c.status = 'active'
      GROUP BY a.id
      ORDER BY a.sort_order
    `).all();

    // Recent activity
    const recentActivity = db.prepare(`
      SELECT p.completed_date, p.status, cp.code, cp.title, e.first_name, e.last_name
      FROM la_checkpoint_progress p
      JOIN la_checkpoints cp ON cp.id = p.checkpoint_id
      JOIN la_candidates c ON c.id = p.candidate_id
      JOIN employees e ON e.id = c.employee_id
      WHERE p.status = 'completed' AND p.completed_date IS NOT NULL
      ORDER BY p.approved_at DESC LIMIT 10
    `).all();

    // Velocity analytics — avg days per tier, stalled candidates
    const velocityByTier = db.prepare(`
      SELECT c.current_tier,
        ROUND(AVG(julianday(COALESCE(c.graduated_at, 'now')) - julianday(c.enrolled_at))) as avg_days,
        COUNT(*) as candidate_count
      FROM la_candidates c WHERE c.status IN ('active', 'graduated')
      GROUP BY c.current_tier
    `).all();

    const stalledCandidates = db.prepare(`
      SELECT c.id, e.first_name, e.last_name, c.current_tier, c.enrolled_at,
        MAX(p.completed_date) as last_completion,
        ROUND(julianday('now') - julianday(COALESCE(MAX(p.completed_date), c.enrolled_at))) as days_stalled,
        COUNT(CASE WHEN p.status = 'completed' THEN 1 END) as completed,
        COUNT(p.id) as total
      FROM la_candidates c
      JOIN employees e ON e.id = c.employee_id
      LEFT JOIN la_checkpoint_progress p ON p.candidate_id = c.id
      WHERE c.status = 'active'
      GROUP BY c.id
      HAVING days_stalled > 30
      ORDER BY days_stalled DESC
    `).all();

    // Per-candidate velocity (for charts)
    const candidateVelocity = db.prepare(`
      SELECT c.id, e.first_name, e.last_name, c.current_tier, c.enrolled_at,
        COUNT(CASE WHEN p.status = 'completed' THEN 1 END) as completed,
        COUNT(p.id) as total,
        ROUND(julianday('now') - julianday(c.enrolled_at)) as days_enrolled,
        ROUND(CAST(COUNT(CASE WHEN p.status = 'completed' THEN 1 END) AS FLOAT) /
          NULLIF(ROUND((julianday('now') - julianday(c.enrolled_at)) / 7), 0), 1) as checkpoints_per_week
      FROM la_candidates c
      JOIN employees e ON e.id = c.employee_id
      LEFT JOIN la_checkpoint_progress p ON p.candidate_id = c.id
      WHERE c.status = 'active'
      GROUP BY c.id
      ORDER BY checkpoints_per_week DESC
    `).all();

    res.json({ pipeline, graduated: graduated.count, competencyRates, recentActivity,
      velocityByTier, stalledCandidates, candidateVelocity });
  } catch (err) {
    console.error('Error loading analytics:', err.message);
    res.status(500).json({ error: 'Failed to load analytics' });
  }
});

// ── Export (Admin/Director) ──────────────────────────────────────────
router.get('/export', requireAdminOrDirector, (req, res) => {
  try {
    const db = getDb();
    const XLSX = require('xlsx');

    const candidates = db.prepare(`
      SELECT c.*, e.first_name, e.last_name, e.department,
        (SELECT COUNT(*) FROM la_checkpoint_progress p WHERE p.candidate_id = c.id AND p.status = 'completed') as completed,
        (SELECT COUNT(*) FROM la_checkpoint_progress p WHERE p.candidate_id = c.id) as total
      FROM la_candidates c JOIN employees e ON e.id = c.employee_id
      ORDER BY e.last_name
    `).all();

    const rows = candidates.map(c => ({
      'Name': `${c.first_name} ${c.last_name}`,
      'Department': c.department,
      'Tier': TIER_NAMES[c.current_tier] || c.current_tier,
      'Status': c.status,
      'Progress': c.total ? `${Math.round(c.completed / c.total * 100)}%` : '0%',
      'Completed': c.completed,
      'Total': c.total,
      'Enrolled': c.enrolled_at,
      'Target LDP Date': c.target_ldp_date || ''
    }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Candidates');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=leadership_academy_export.xlsx');
    res.send(buf);
  } catch (err) {
    console.error('Error exporting:', err.message);
    res.status(500).json({ error: 'Failed to export' });
  }
});

// ── Candidate Self-Service ───────────────────────────────────────────
router.get('/my-dashboard', (req, res) => {
  try {
    const db = getDb();
    if (!req.session?.employeeId) return res.status(401).json({ error: 'Not authenticated' });

    const candidate = db.prepare(`
      SELECT c.*, e.full_name, e.first_name, e.last_name, e.department
      FROM la_candidates c JOIN employees e ON e.id = c.employee_id
      WHERE c.employee_id = ? AND c.status IN ('active', 'graduated')
    `).get(req.session.employeeId);
    if (!candidate) return res.status(404).json({ error: 'Not enrolled in Leadership Academy' });

    const checkpoints = db.prepare(`
      SELECT p.*, cp.code, cp.title, cp.description, cp.evidence_required, cp.tier, cp.sort_order, cp.image_url, cp.resource_url, cp.buy_url,
             a.id as area_id, a.name as area_name, a.slug as area_slug, a.icon as area_icon
      FROM la_checkpoint_progress p
      JOIN la_checkpoints cp ON cp.id = p.checkpoint_id
      JOIN la_competency_areas a ON a.id = cp.competency_area_id
      WHERE p.candidate_id = ? AND cp.tier <= ?
      ORDER BY a.sort_order, cp.tier, cp.sort_order
    `).all(candidate.id, candidate.current_tier);

    const resources = db.prepare(`
      SELECT r.*, COALESCE(rp.completed, 0) as completed, rp.completed_at
      FROM la_learning_resources r
      LEFT JOIN la_resource_progress rp ON rp.resource_id = r.id AND rp.candidate_id = ?
      WHERE r.tier <= ?
      ORDER BY r.tier, r.sort_order
    `).all(candidate.id, candidate.current_tier);

    // Area summaries
    const areas = db.prepare('SELECT * FROM la_competency_areas ORDER BY sort_order').all();
    const areaSummaries = areas.map(a => {
      const areaCheckpoints = checkpoints.filter(cp => cp.area_id === a.id);
      const completed = areaCheckpoints.filter(cp => ['completed', 'skill_4', 'skill_5'].includes(cp.status)).length;
      return { ...a, completed, total: areaCheckpoints.length, pct: areaCheckpoints.length ? Math.round(completed / areaCheckpoints.length * 100) : 0 };
    });

    const totalCompleted = checkpoints.filter(cp => ['completed', 'skill_4', 'skill_5'].includes(cp.status)).length;
    const resourcesCompleted = resources.filter(r => r.completed).length;

    res.json({ candidate, checkpoints, resources, areaSummaries, totalCompleted, totalCheckpoints: checkpoints.length, resourcesCompleted, totalResources: resources.length });
  } catch (err) {
    console.error('Error loading dashboard:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

router.put('/my-checkpoints/:checkpointId', (req, res) => {
  try {
    const db = getDb();
    if (!req.session?.employeeId) return res.status(401).json({ error: 'Not authenticated' });

    const candidate = db.prepare("SELECT id FROM la_candidates WHERE employee_id = ? AND status = 'active'").get(req.session.employeeId);
    if (!candidate) return res.status(403).json({ error: 'Not enrolled' });

    const { status, evidence_notes } = req.body;
    const progress = db.prepare('SELECT * FROM la_checkpoint_progress WHERE candidate_id = ? AND checkpoint_id = ?').get(candidate.id, req.params.checkpointId);
    if (!progress) return res.status(404).json({ error: 'Checkpoint not found' });
    if (progress.approved_at) return res.status(400).json({ error: 'Checkpoint already approved — cannot modify' });

    const validStatuses = ['not_started', 'in_progress', 'completed', 'skill_1', 'skill_2', 'skill_3', 'skill_4', 'skill_5'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const newStatus = status || progress.status;
    const newNotes = evidence_notes !== undefined ? evidence_notes : progress.evidence_notes;
    const completedDate = newStatus === 'completed' ? (progress.completed_date || new Date().toISOString().split('T')[0]) : progress.completed_date;

    db.prepare('UPDATE la_checkpoint_progress SET status = ?, evidence_notes = ?, completed_date = ? WHERE id = ?')
      .run(newStatus, newNotes, completedDate, progress.id);

    res.json({ success: true });
  } catch (err) {
    console.error('Error updating checkpoint:', err.message);
    res.status(500).json({ error: 'Failed to update checkpoint' });
  }
});

// ── Upload evidence file for a checkpoint ──
router.post('/my-checkpoints/:checkpointId/upload', evidenceUpload.single('file'), (req, res) => {
  try {
    const db = getDb();
    if (!req.session?.employeeId) return res.status(401).json({ error: 'Not authenticated' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const candidate = db.prepare("SELECT id FROM la_candidates WHERE employee_id = ? AND status = 'active'").get(req.session.employeeId);
    if (!candidate) return res.status(403).json({ error: 'Not enrolled' });

    const progress = db.prepare('SELECT * FROM la_checkpoint_progress WHERE candidate_id = ? AND checkpoint_id = ?').get(candidate.id, req.params.checkpointId);
    if (!progress) return res.status(404).json({ error: 'Checkpoint not found' });
    if (progress.approved_at) return res.status(400).json({ error: 'Checkpoint already approved' });

    // Parse existing files or start fresh
    let files = [];
    try { files = JSON.parse(progress.evidence_files || '[]'); } catch { files = []; }

    files.push({
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size,
      uploadedAt: new Date().toISOString()
    });

    db.prepare('UPDATE la_checkpoint_progress SET evidence_files = ? WHERE id = ?')
      .run(JSON.stringify(files), progress.id);

    res.json({ success: true, files });
  } catch (err) {
    console.error('Error uploading evidence:', err.message);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

// ── Delete evidence file ──
router.delete('/my-checkpoints/:checkpointId/upload/:filename', (req, res) => {
  try {
    const db = getDb();
    if (!req.session?.employeeId) return res.status(401).json({ error: 'Not authenticated' });

    const candidate = db.prepare("SELECT id FROM la_candidates WHERE employee_id = ? AND status = 'active'").get(req.session.employeeId);
    if (!candidate) return res.status(403).json({ error: 'Not enrolled' });

    const progress = db.prepare('SELECT * FROM la_checkpoint_progress WHERE candidate_id = ? AND checkpoint_id = ?').get(candidate.id, req.params.checkpointId);
    if (!progress) return res.status(404).json({ error: 'Checkpoint not found' });
    if (progress.approved_at) return res.status(400).json({ error: 'Checkpoint already approved' });

    let files = [];
    try { files = JSON.parse(progress.evidence_files || '[]'); } catch { files = []; }

    const idx = files.findIndex(f => f.filename === req.params.filename);
    if (idx === -1) return res.status(404).json({ error: 'File not found' });

    // Remove file from disk
    const filePath = path.join(__dirname, '../../data/la-evidence', req.params.filename);
    try { fs.unlinkSync(filePath); } catch {}

    files.splice(idx, 1);
    db.prepare('UPDATE la_checkpoint_progress SET evidence_files = ? WHERE id = ?')
      .run(JSON.stringify(files), progress.id);

    res.json({ success: true, files });
  } catch (err) {
    console.error('Error deleting evidence:', err.message);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// ── Serve evidence files (admin + candidate) ──
router.get('/evidence/:filename', (req, res) => {
  const filePath = path.join(__dirname, '../../data/la-evidence', req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(filePath);
});

router.get('/my-resources', (req, res) => {
  try {
    const db = getDb();
    if (!req.session?.employeeId) return res.status(401).json({ error: 'Not authenticated' });

    const candidate = db.prepare("SELECT id, current_tier FROM la_candidates WHERE employee_id = ? AND status IN ('active','graduated')").get(req.session.employeeId);
    if (!candidate) return res.status(404).json({ error: 'Not enrolled' });

    const resources = db.prepare(`
      SELECT r.*, COALESCE(rp.completed, 0) as completed, rp.completed_at
      FROM la_learning_resources r
      LEFT JOIN la_resource_progress rp ON rp.resource_id = r.id AND rp.candidate_id = ?
      WHERE r.tier <= ?
      ORDER BY r.tier, r.sort_order
    `).all(candidate.id, candidate.current_tier);

    res.json(resources);
  } catch (err) {
    console.error('Error loading resources:', err.message);
    res.status(500).json({ error: 'Failed to load resources' });
  }
});

router.put('/my-resources/:resourceId', (req, res) => {
  try {
    const db = getDb();
    if (!req.session?.employeeId) return res.status(401).json({ error: 'Not authenticated' });

    const candidate = db.prepare("SELECT id FROM la_candidates WHERE employee_id = ? AND status = 'active'").get(req.session.employeeId);
    if (!candidate) return res.status(403).json({ error: 'Not enrolled' });

    const existing = db.prepare('SELECT * FROM la_resource_progress WHERE candidate_id = ? AND resource_id = ?').get(candidate.id, req.params.resourceId);
    if (existing) {
      const newCompleted = existing.completed ? 0 : 1;
      db.prepare('UPDATE la_resource_progress SET completed = ?, completed_at = ? WHERE id = ?')
        .run(newCompleted, newCompleted ? new Date().toISOString() : null, existing.id);
    } else {
      db.prepare('INSERT INTO la_resource_progress (candidate_id, resource_id, completed, completed_at) VALUES (?, ?, 1, ?)')
        .run(candidate.id, req.params.resourceId, new Date().toISOString());
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating resource:', err.message);
    res.status(500).json({ error: 'Failed to update resource' });
  }
});

// ── Resource CMS (Admin) ────────────────────────────────────────────
router.get('/resources', (req, res) => {
  try {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM la_learning_resources ORDER BY tier, sort_order').all());
  } catch (err) {
    console.error('Error loading resources:', err.message);
    res.status(500).json({ error: 'Failed to load resources' });
  }
});

router.post('/resources', requireAdmin, (req, res) => {
  try {
    const db = getDb();
    const { title, author, type, url, description, tier, required, thought_leader, sort_order } = req.body;
    if (!title || !type) return res.status(400).json({ error: 'Title and type are required' });

    const result = db.prepare(`
      INSERT INTO la_learning_resources (title, author, type, url, description, tier, required, thought_leader, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(title, author || null, type, url || null, description || null, tier || 1, required ? 1 : 0, thought_leader || null, sort_order || 0);

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('Error adding resource:', err.message);
    res.status(500).json({ error: 'Failed to add resource' });
  }
});

router.put('/resources/:id', requireAdmin, (req, res) => {
  try {
    const db = getDb();
    const { title, author, type, url, description, tier, required, thought_leader, sort_order } = req.body;

    db.prepare(`
      UPDATE la_learning_resources
      SET title = ?, author = ?, type = ?, url = ?, description = ?, tier = ?, required = ?, thought_leader = ?, sort_order = ?
      WHERE id = ?
    `).run(title, author || null, type, url || null, description || null, tier || 1, required ? 1 : 0, thought_leader || null, sort_order || 0, req.params.id);

    res.json({ success: true });
  } catch (err) {
    console.error('Error updating resource:', err.message);
    res.status(500).json({ error: 'Failed to update resource' });
  }
});

router.delete('/resources/:id', requireAdmin, (req, res) => {
  try {
    const db = getDb();
    db.transaction(() => {
      db.prepare('DELETE FROM la_resource_progress WHERE resource_id = ?').run(req.params.id);
      db.prepare('DELETE FROM la_learning_resources WHERE id = ?').run(req.params.id);
    })();
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting resource:', err.message);
    res.status(500).json({ error: 'Failed to delete resource' });
  }
});

// ── Checkpoint-Resource Linking (Admin) ─────────────────────────────

// GET linked resources for a checkpoint
router.get('/checkpoints/:checkpointId/resources', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT r.* FROM la_learning_resources r
      JOIN la_checkpoint_resources cr ON cr.resource_id = r.id
      WHERE cr.checkpoint_id = ?
      ORDER BY r.sort_order
    `).all(req.params.checkpointId);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load linked resources' });
  }
});

// POST link a resource to a checkpoint
router.post('/checkpoints/:checkpointId/resources', requireAdmin, (req, res) => {
  try {
    const db = getDb();
    const { resource_id } = req.body;
    db.prepare('INSERT OR IGNORE INTO la_checkpoint_resources (checkpoint_id, resource_id) VALUES (?, ?)')
      .run(req.params.checkpointId, resource_id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to link resource' });
  }
});

// DELETE unlink a resource from a checkpoint
router.delete('/checkpoints/:checkpointId/resources/:resourceId', requireAdmin, (req, res) => {
  try {
    const db = getDb();
    db.prepare('DELETE FROM la_checkpoint_resources WHERE checkpoint_id = ? AND resource_id = ?')
      .run(req.params.checkpointId, req.params.resourceId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unlink resource' });
  }
});

// ── Shared Gap Analysis Builder ──────────────────────────────────
function buildGapAnalysis(db, candidate) {
  const checkpoints = db.prepare(`
    SELECT cp.id, cp.code, cp.title, cp.tier, cp.description, cp.evidence_required,
      ca.name as area_name, ca.slug as area_slug,
      p.status, p.rating, p.leader_notes, p.approved_at, p.completed_date, p.evidence_notes
    FROM la_checkpoint_progress p
    JOIN la_checkpoints cp ON cp.id = p.checkpoint_id
    JOIN la_competency_areas ca ON ca.id = cp.competency_area_id
    WHERE p.candidate_id = ?
    ORDER BY ca.sort_order, cp.tier, cp.sort_order
  `).all(candidate.id);

  const areas = {};
  for (const cp of checkpoints) {
    if (!areas[cp.area_slug]) {
      areas[cp.area_slug] = { name: cp.area_name, slug: cp.area_slug, total: 0, completed: 0, in_progress: 0, not_started: 0, strengths: [], gaps: [] };
    }
    const a = areas[cp.area_slug];
    a.total++;
    if (cp.status === 'completed' || cp.status === 'skill_4' || cp.status === 'skill_5') {
      a.completed++;
      if (cp.rating >= 3) a.strengths.push({ code: cp.code, title: cp.title, rating: cp.rating, tier: cp.tier });
    } else if (cp.status === 'in_progress' || cp.status === 'skill_2' || cp.status === 'skill_3') {
      a.in_progress++;
    } else {
      a.not_started++;
      a.gaps.push({ code: cp.code, title: cp.title, tier: cp.tier, status: cp.status });
    }
  }

  const allGaps = [];
  for (const area of Object.values(areas)) {
    for (const gap of area.gaps) allGaps.push({ ...gap, area: area.name });
  }
  allGaps.sort((a, b) => a.tier - b.tier);

  const allStrengths = [];
  for (const area of Object.values(areas)) {
    for (const s of area.strengths) allStrengths.push({ ...s, area: area.name });
  }
  allStrengths.sort((a, b) => (b.rating || 0) - (a.rating || 0));

  const totalCheckpoints = checkpoints.length;
  const totalCompleted = checkpoints.filter(c => c.status === 'completed' || c.status === 'skill_4' || c.status === 'skill_5').length;
  const overallPct = totalCheckpoints > 0 ? Math.round(totalCompleted / totalCheckpoints * 100) : 0;

  const areaList = Object.values(areas).map(a => ({
    ...a,
    pct: a.total > 0 ? Math.round(a.completed / a.total * 100) : 0,
    strengths: a.strengths.slice(0, 3),
    gaps: a.gaps.slice(0, 5)
  })).sort((a, b) => a.pct - b.pct);

  const gapCheckpointIds = allGaps.slice(0, 10).map(g => {
    const cp = checkpoints.find(c => c.code === g.code);
    return cp ? cp.id : null;
  }).filter(Boolean);

  let suggestedResources = [];
  if (gapCheckpointIds.length > 0) {
    const placeholders = gapCheckpointIds.map(() => '?').join(',');
    suggestedResources = db.prepare(`
      SELECT DISTINCT r.*, cp.code as for_checkpoint
      FROM la_learning_resources r
      JOIN la_checkpoint_resources cr ON cr.resource_id = r.id
      JOIN la_checkpoints cp ON cp.id = cr.checkpoint_id
      WHERE cr.checkpoint_id IN (${placeholders})
      ORDER BY r.sort_order
    `).all(...gapCheckpointIds);
  }
  if (suggestedResources.length === 0) {
    suggestedResources = db.prepare(`
      SELECT * FROM la_learning_resources WHERE tier = ? AND required = 1 ORDER BY sort_order
    `).all(candidate.current_tier);
  }

  return {
    candidate: { name: null, tier: candidate.current_tier, status: candidate.status, enrolled_at: candidate.enrolled_at },
    overallPct, totalCompleted, totalCheckpoints,
    areas: areaList,
    topGaps: allGaps.slice(0, 10),
    topStrengths: allStrengths.slice(0, 10),
    suggestedResources,
    developmentPlan: areaList.filter(a => a.pct < 100).map(a => ({
      area: a.name, pct: a.pct,
      focus: a.gaps.slice(0, 3).map(g => g.code + ': ' + g.title),
      recommendation: a.pct < 25 ? 'Priority focus area — start with foundational checkpoints'
        : a.pct < 50 ? 'Building momentum — continue current pace'
        : a.pct < 75 ? 'Good progress — push to complete remaining items'
        : 'Almost there — finish the final checkpoints'
    }))
  };
}

// ── Gap Analysis (Admin — any candidate) ─────────────────────────
router.get('/candidates/:id/gap-analysis', requireAdminOrDirector, (req, res) => {
  try {
    const db = getDb();
    const candidate = db.prepare(`
      SELECT c.*, e.first_name, e.last_name, e.department
      FROM la_candidates c JOIN employees e ON e.id = c.employee_id
      WHERE c.id = ?
    `).get(req.params.id);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

    const result = buildGapAnalysis(db, candidate);
    result.candidate.name = candidate.first_name + ' ' + candidate.last_name;
    result.candidate.department = candidate.department;
    res.json(result);
  } catch (err) {
    console.error('Admin gap analysis error:', err.message);
    res.status(500).json({ error: 'Failed to generate gap analysis' });
  }
});

// ── Self-Assessment Gap Analysis (Employee) ────────────────────────

router.get('/my-gap-analysis', (req, res) => {
  if (!req.session?.employeeId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const db = getDb();
    const candidate = db.prepare('SELECT * FROM la_candidates WHERE employee_id = ?').get(req.session.employeeId);
    if (!candidate) return res.status(404).json({ error: 'Not enrolled' });

    const result = buildGapAnalysis(db, candidate);
    res.json(result);
  } catch (err) {
    console.error('Gap analysis error:', err.message);
    res.status(500).json({ error: 'Failed to generate gap analysis' });
  }
});

module.exports = router;
