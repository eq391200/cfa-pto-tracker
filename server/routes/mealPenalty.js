/**
 * Meal penalty analysis routes — upload, preview, commit, PDF reports.
 *
 * Two-step flow:
 *   1. POST /preview — parse Employee Time Detail PDF, return preview
 *   2. POST /commit  — save parsed penalties to DB
 *
 * Report endpoints:
 *   GET /reports               — list all reports
 *   GET /report/:id            — report detail + records
 *   GET /report/:id/pdf        — full analysis PDF
 *   DELETE /report/:id         — delete report + records
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { getDb } = require('../db');
const { parseEmployeeTimeDetail } = require('../services/mealPenaltyParser');
const { PassThrough } = require('stream');

const router = express.Router();

const uploadDir = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 20 * 1024 * 1024 }
});

const COLORS = {
  navy: '#004F71',
  dark: '#1F2937',
  darkHeader: '#374151',
  gray: '#6B7280',
  rowAlt: '#F9FAFB',
  red: '#C53030',
  orange: '#DD6B20',
  green: '#38A169',
  blue: '#3182CE',
  blueLine: '#2563EB',
  white: '#FFFFFF',
};

/* ─── Format helpers ──────────────────────────────────────────────── */

function formatDateMDY(dateStr) {
  if (!dateStr) return 'N/A';
  const parts = dateStr.split('-');
  return parts.length === 3 ? `${parts[1]}/${parts[2]}/${parts[0]}` : dateStr;
}

function formatDateTime(date) {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const y = date.getFullYear();
  let h = date.getHours();
  const min = String(date.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${m}/${d}/${y} ${String(h).padStart(2, '0')}:${min} ${ampm}`;
}

/* ─── Route param validation ─────────────────────────────────────── */

router.param('id', (req, res, next, value) => {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    return res.status(400).json({ error: 'Invalid report ID — must be a positive integer' });
  }
  next();
});

// ── POST /api/meal-penalty/preview ──────────────────────────────────
router.post('/preview', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const result = parseEmployeeTimeDetail(req.file.path);

    res.json({
      success: true,
      preview: {
        dateRange: { start: result.dateRangeStart, end: result.dateRangeEnd },
        ...result.summary,
        penaltyRecords: result.penalties.map(p => ({
          employeeName: p.employeeName,
          date: p.date,
          shiftDetail: p.shiftDetail,
          consecutiveFormatted: p.consecutiveFormatted,
          consecutiveMinutes: p.consecutiveMinutes
        }))
      },
      tempFile: req.file.filename
    });
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.status(400).json({ error: 'Failed to parse file: ' + err.message });
  }
});

// ── POST /api/meal-penalty/commit ───────────────────────────────────
router.post('/commit', (req, res) => {
  const { tempFile } = req.body;
  if (!tempFile) return res.status(400).json({ error: 'No temp file specified' });

  const safeName = path.basename(tempFile);
  const filePath = path.join(uploadDir, safeName);
  if (!fs.existsSync(filePath)) {
    return res.status(400).json({ error: 'Temp file not found. Please re-upload.' });
  }

  try {
    const db = getDb();
    const result = parseEmployeeTimeDetail(filePath);

    const insertReport = db.prepare(`
      INSERT INTO meal_penalty_reports
        (date_range_start, date_range_end, total_employees, total_penalties,
         employees_with_penalties, employees_clean, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertRecord = db.prepare(`
      INSERT INTO meal_penalty_records
        (report_id, employee_name, violation_date, work_period_start,
         work_period_end, consecutive_minutes, consecutive_formatted)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    let reportId;
    const commitAll = db.transaction(() => {
      const info = insertReport.run(
        result.dateRangeStart, result.dateRangeEnd,
        result.summary.totalEmployees, result.summary.totalPenalties,
        result.summary.employeesWithPenalties, result.summary.employeesClean,
        req.session?.username || 'admin'
      );
      reportId = Number(info.lastInsertRowid);

      for (const p of result.penalties) {
        insertRecord.run(
          reportId, p.employeeName, p.date,
          p.workPeriodStart, p.workPeriodEnd,
          p.consecutiveMinutes, p.consecutiveFormatted
        );
      }
    });

    commitAll();
    try { fs.unlinkSync(filePath); } catch (_) {}

    res.json({
      success: true,
      report: {
        id: reportId,
        dateRangeStart: result.dateRangeStart,
        dateRangeEnd: result.dateRangeEnd,
        ...result.summary
      }
    });
  } catch (err) {
    console.error('Meal penalty commit failed:', err.message);
    res.status(500).json({ error: 'Commit failed: ' + err.message });
  }
});

// ── GET /api/meal-penalty/reports ───────────────────────────────────
router.get('/reports', (req, res) => {
  try {
    const db = getDb();
    const reports = db.prepare(
      'SELECT * FROM meal_penalty_reports ORDER BY created_at DESC'
    ).all();
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/meal-penalty/report/:id ────────────────────────────────
router.get('/report/:id', (req, res) => {
  try {
    const db = getDb();
    const report = db.prepare('SELECT * FROM meal_penalty_reports WHERE id = ?').get(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const records = db.prepare(
      'SELECT * FROM meal_penalty_records WHERE report_id = ? ORDER BY employee_name, violation_date'
    ).all(req.params.id);

    res.json({ report, records });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/meal-penalty/report/:id ─────────────────────────────
router.delete('/report/:id', (req, res) => {
  try {
    const db = getDb();
    const report = db.prepare('SELECT id FROM meal_penalty_reports WHERE id = ?').get(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const deleteAll = db.transaction(() => {
      db.prepare('DELETE FROM meal_penalty_records WHERE report_id = ?').run(req.params.id);
      db.prepare('DELETE FROM meal_penalty_reports WHERE id = ?').run(req.params.id);
    });
    deleteAll();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/meal-penalty/report/:id/pdf ────────────────────────────
router.get('/report/:id/pdf', async (req, res) => {
  try {
    const db = getDb();
    const report = db.prepare('SELECT * FROM meal_penalty_reports WHERE id = ?').get(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const records = db.prepare(
      'SELECT * FROM meal_penalty_records WHERE report_id = ? ORDER BY employee_name, violation_date'
    ).all(req.params.id);

    const buffer = await pdfToBuffer(() => {
      const doc = new PDFDocument({ margin: 40, size: 'letter' });
      buildMealPenaltyPDF(doc, report, records);
      return doc;
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="meal-penalty-report-${report.date_range_start}-to-${report.date_range_end}.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error('Meal penalty PDF error:', err.message);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

/* ─── PDF Helpers ─────────────────────────────────────────────────── */

function pdfToBuffer(buildFn) {
  return new Promise((resolve, reject) => {
    const doc = buildFn();
    const chunks = [];
    const stream = new PassThrough();
    doc.pipe(stream);
    doc.on('error', reject);
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    doc.end();
  });
}

function drawStyledTable(doc, { cols, rows, headerBg, startX, rowH, fontSize }) {
  startX = startX || 40;
  rowH = rowH || 22;
  fontSize = fontSize || 8;
  headerBg = headerBg || COLORS.darkHeader;
  const totalW = cols.reduce((s, c) => s + c.width, 0);
  let y = doc.y;

  function drawHeader(atY) {
    doc.rect(startX, atY, totalW, rowH).fill(headerBg);
    let x = startX;
    doc.font('Helvetica-Bold').fontSize(fontSize).fillColor(COLORS.white);
    for (const col of cols) {
      doc.text(col.label, x + 6, atY + (rowH - fontSize) / 2 - 1, {
        width: col.width - 12, align: col.align || 'left', lineBreak: false
      });
      x += col.width;
    }
    return atY + rowH;
  }

  y = drawHeader(y);

  for (let i = 0; i < rows.length; i++) {
    if (y + rowH > doc.page.height - 50) {
      doc.addPage();
      y = drawHeader(40);
    }

    if (i % 2 === 0) {
      doc.rect(startX, y, totalW, rowH).fill(COLORS.rowAlt);
    }

    let x = startX;
    for (let j = 0; j < cols.length; j++) {
      const cell = rows[i][j];
      if (cell && typeof cell === 'object') {
        if (cell.bg) {
          const pad = 3;
          doc.rect(x + pad, y + pad, cols[j].width - pad * 2, rowH - pad * 2).fill(cell.bg);
        }
        doc.font(cell.bold ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(fontSize)
          .fillColor(cell.color || COLORS.dark)
          .text(String(cell.text), x + 6, y + (rowH - fontSize) / 2 - 1, {
            width: cols[j].width - 12, align: cell.align || cols[j].align || 'left', lineBreak: false
          });
      } else {
        doc.font('Helvetica').fontSize(fontSize).fillColor(COLORS.dark)
          .text(String(cell ?? ''), x + 6, y + (rowH - fontSize) / 2 - 1, {
            width: cols[j].width - 12, align: cols[j].align || 'left', lineBreak: false
          });
      }
      x += cols[j].width;
    }
    y += rowH;
  }

  doc.x = 40;
  doc.y = y;
}

function buildMealPenaltyPDF(doc, report, records) {
  // ── Page 1: Header ──
  doc.fontSize(22).font('Helvetica-Bold').fillColor(COLORS.dark)
    .text('Meal Penalty Analysis Report', { align: 'center' });
  doc.fontSize(11).font('Helvetica').fillColor(COLORS.gray)
    .text('La Rambla FSU', { align: 'center' });
  doc.fontSize(9).fillColor(COLORS.gray)
    .text(`Date Range: ${formatDateMDY(report.date_range_start)} - ${formatDateMDY(report.date_range_end)}`, { align: 'center' });
  doc.text(`Generated: ${formatDateTime(new Date())}`, { align: 'center' });
  doc.moveDown(0.8);

  // Blue separator line
  doc.moveTo(40, doc.y).lineTo(572, doc.y)
    .strokeColor(COLORS.blueLine).lineWidth(2).stroke();
  doc.moveDown(1.5);

  // ── Meal Penalty Rule ──
  doc.fontSize(14).font('Helvetica-Bold').fillColor(COLORS.dark)
    .text('Meal Penalty Rule (Puerto Rico)');
  doc.moveDown(0.5);

  drawStyledTable(doc, {
    cols: [
      { label: 'Condition', width: 280 },
      { label: 'Result', width: 252, align: 'center' },
    ],
    rows: [
      ['Employee works MORE THAN 6 consecutive hours', { text: 'MEAL PENALTY', bg: COLORS.red, color: COLORS.white, bold: true, align: 'center' }],
      ['Any Unpaid break taken during shift', 'Resets the consecutive work clock'],
      ['"Break (Conv To Paid)" punch type', 'Counts as work time (not a break)'],
      ['Gap between shifts (clock out, clock in later)', 'Treated as separate shifts'],
    ],
    headerBg: COLORS.darkHeader,
    rowH: 28,
    fontSize: 8,
  });
  doc.moveDown(1.5);

  // ── Executive Summary ──
  doc.fontSize(14).font('Helvetica-Bold').fillColor(COLORS.dark)
    .text('Executive Summary');
  doc.moveDown(0.5);

  drawStyledTable(doc, {
    cols: [
      { label: 'Metric', width: 380 },
      { label: 'Count', width: 152, align: 'center' },
    ],
    rows: [
      ['Total Employees Analyzed', String(report.total_employees)],
      [{ text: 'Total Meal Penalties Found', bold: true, color: COLORS.red }, { text: String(report.total_penalties), bold: true, color: COLORS.red, align: 'center' }],
      ['Employees with Penalties', String(report.employees_with_penalties)],
      ['Employees with Clean Record', String(report.employees_clean)],
    ],
    headerBg: COLORS.darkHeader,
    rowH: 24,
    fontSize: 9,
  });

  // ── Page 2+: Penalty Detail Table ──
  doc.addPage();
  doc.fontSize(16).font('Helvetica-Bold').fillColor(COLORS.red)
    .text('Meal Penalty Violations');
  doc.moveDown(0.3);
  doc.fontSize(9).font('Helvetica').fillColor(COLORS.dark)
    .text('Employees who worked more than 6 consecutive hours without taking any break (Unpaid punch) during their shift.');
  doc.moveDown(0.5);

  if (records.length > 0) {
    drawStyledTable(doc, {
      cols: [
        { label: 'Employee', width: 200 },
        { label: 'Date', width: 90, align: 'center' },
        { label: 'Shift Period', width: 152, align: 'center' },
        { label: 'Consecutive Hours', width: 90, align: 'center' },
      ],
      rows: records.map(r => [
        r.employee_name,
        formatDateMDY(r.violation_date),
        `${r.work_period_start} - ${r.work_period_end}`,
        { text: r.consecutive_formatted, color: COLORS.red, bold: true, align: 'center' },
      ]),
      headerBg: COLORS.red,
      rowH: 22,
      fontSize: 8,
    });
  } else {
    doc.fontSize(11).font('Helvetica').fillColor(COLORS.green)
      .text('No meal penalty violations found.', { align: 'center' });
  }

  // ── Per-Employee Summary ──
  if (records.length > 0) {
    if (doc.y > doc.page.height - 150) doc.addPage();
    else doc.moveDown(1.5);

    doc.fontSize(16).font('Helvetica-Bold').fillColor(COLORS.dark)
      .text('Employee Detail — Penalized Employees', { align: 'center' });
    doc.moveDown(0.8);

    const byEmployee = {};
    for (const r of records) {
      if (!byEmployee[r.employee_name]) byEmployee[r.employee_name] = [];
      byEmployee[r.employee_name].push(r);
    }

    for (const [empName, empRecords] of Object.entries(byEmployee).sort((a, b) => a[0].localeCompare(b[0]))) {
      if (doc.y > doc.page.height - 100) doc.addPage();

      doc.font('Helvetica-BoldOblique').fontSize(11)
        .fillColor(COLORS.dark).text(`${empName} — `, { continued: true })
        .fillColor(COLORS.red).text(`${empRecords.length} Penalty(ies)`);
      doc.moveDown(0.3);

      drawStyledTable(doc, {
        cols: [
          { label: 'Date', width: 100, align: 'center' },
          { label: 'Shift Period', width: 200, align: 'center' },
          { label: 'Consecutive Hours', width: 130, align: 'center' },
        ],
        rows: empRecords.map(r => [
          formatDateMDY(r.violation_date),
          `${r.work_period_start} - ${r.work_period_end}`,
          { text: r.consecutive_formatted, color: COLORS.red, bold: true, align: 'center' },
        ]),
        headerBg: COLORS.darkHeader,
        rowH: 22,
        fontSize: 8,
      });
      doc.moveDown(0.8);
    }
  }
}

module.exports = router;
