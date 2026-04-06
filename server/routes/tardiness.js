/**
 * Tardiness analysis routes — upload, preview, commit, and PDF reports.
 *
 * Two-step flow:
 *   1. POST /preview — parse PDF, return preview without saving
 *   2. POST /commit  — save parsed data to DB, post Slack summary
 *
 * Report endpoints:
 *   GET /reports                    — list all reports
 *   GET /report/:id                — report detail + records
 *   GET /report/:id/pdf            — full analysis PDF
 *   GET /report/:id/infractions    — combined infraction notices PDF
 *   GET /infraction/:recordId/pdf  — single infraction notice PDF
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { getDb } = require('../db');
const { parsePunchVarianceReport } = require('../services/tardinessParser');
const { sendSlackToChannel, sendSlackDM, isBotConfigured, uploadFileToSlack, openGroupDM } = require('../services/slackService');
const { PassThrough } = require('stream');

const router = express.Router();

const uploadDir = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 20 * 1024 * 1024 } // 20 MB for large PDFs
});

const COLORS = {
  navy: '#004F71',
  dark: '#1F2937',
  darkHeader: '#374151',
  gray: '#6B7280',
  rowAlt: '#F9FAFB',
  rowAltWarm: '#FDF6EC',
  red: '#C53030',
  orange: '#DD6B20',
  green: '#38A169',
  blue: '#3182CE',
  blueLine: '#2563EB',
  white: '#FFFFFF',
};

/* ─── Format helpers ──────────────────────────────────────────────── */

/**
 * Convert an ISO date string (YYYY-MM-DD) to US format (MM/DD/YYYY).
 *
 * @param {string|null} dateStr - ISO date, e.g. "2025-02-15"
 * @returns {string} Formatted date "02/15/2025", or "N/A" if falsy
 */
function formatDateMDY(dateStr) {
  if (!dateStr) return 'N/A';
  const parts = dateStr.split('-');
  return parts.length === 3 ? `${parts[1]}/${parts[2]}/${parts[0]}` : dateStr;
}

/**
 * Format a JS Date object as "MM/DD/YYYY HH:MM AM/PM".
 *
 * @param {Date} date - Date object to format
 * @returns {string} e.g. "02/15/2025 09:30 AM"
 */
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

/**
 * Format a clock-in variance in minutes to a signed H:MM string.
 * Negative values (late) get a '-' prefix, positive (early) get '+'.
 *
 * @param {number|null} minutes - Variance in minutes (negative = late)
 * @returns {string} Formatted string, e.g. "-0:12" or "+0:03", or "N/A"
 */
function formatVariance(minutes) {
  if (minutes == null) return 'N/A';
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${h}:${String(m).padStart(2, '0')}`;
}

/**
 * Compute detailed summary statistics from a report and its records.
 * Counts unique employees per classification bucket.
 *
 * @param {object} report - DB row from tardiness_reports
 * @param {object[]} records - Array of DB rows from tardiness_records
 * @returns {{ totalEmployees: number, totalInfractions: number,
 *             employeesWithInfractions: number, totalFlags: number,
 *             employeesFlagsOnly: number, employeesWithAnyIssue: number,
 *             cleanRecord: number }}
 */
function computeDetailedSummary(report, records) {
  const empInf = new Set();
  const empFlag = new Set();
  const empAbs = new Set();
  for (const r of records) {
    if (r.classification === 'INFRACTION') empInf.add(r.employee_name);
    if (r.classification === 'FLAG') empFlag.add(r.employee_name);
    if (r.classification === 'ABSENCE') empAbs.add(r.employee_name);
  }
  const empAny = new Set([...empInf, ...empFlag, ...empAbs]);
  const flagsOnly = [...empFlag].filter(e => !empInf.has(e)).length;
  return {
    totalEmployees: report.total_employees,
    totalInfractions: report.infraction_count,
    employeesWithInfractions: empInf.size,
    totalFlags: report.flag_count,
    employeesFlagsOnly: flagsOnly,
    employeesWithAnyIssue: empAny.size,
    cleanRecord: report.total_employees - empAny.size,
  };
}

/* ─── DB helpers ─────────────────────────────────────────────────── */

/**
 * Fetch a tardiness report and its associated records from the DB.
 * Optionally filter records by classification.
 *
 * @param {object} db - better-sqlite3 Database instance
 * @param {number|string} reportId - Report primary key
 * @param {string} [classificationFilter] - If set, only return records with this classification
 * @returns {{ report: object, records: object[] }|null} Null if report not found
 */
function getReportWithRecords(db, reportId, classificationFilter) {
  const report = db.prepare('SELECT * FROM tardiness_reports WHERE id = ?').get(reportId);
  if (!report) return null;

  let sql = 'SELECT * FROM tardiness_records WHERE report_id = ?';
  const params = [reportId];
  if (classificationFilter) {
    sql += ' AND classification = ?';
    params.push(classificationFilter);
  }
  sql += ' ORDER BY employee_name, shift_date';
  const records = db.prepare(sql).all(...params);
  return { report, records };
}

/**
 * Map a parsed record to the compact preview shape sent to the frontend.
 * Used by both INFRACTION/FLAG previews (with minutesLate) and ABSENCE previews.
 *
 * @param {object} r - Parsed record from tardinessParser
 * @param {boolean} [includeVariance=true] - Include minutesLate, scheduledIn, actualIn
 * @returns {object} Preview-ready record
 */
function mapRecordForPreview(r, includeVariance = true) {
  const base = { employeeName: r.employeeName, date: r.date };
  if (includeVariance) {
    base.minutesLate = Math.abs(r.clockInVarianceMinutes);
    base.scheduledIn = r.scheduledIn;
    base.actualIn = r.actualIn;
  } else {
    base.scheduledIn = r.scheduledIn;
  }
  return base;
}

/* ─── Route param validation ─────────────────────────────────────── */

/**
 * Validate that :id and :recordId route params are positive integers.
 * Returns 400 early if not, preventing silent 404s on malformed input.
 */
router.param('id', (req, res, next, value) => {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    return res.status(400).json({ error: 'Invalid report ID — must be a positive integer' });
  }
  next();
});
router.param('recordId', (req, res, next, value) => {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    return res.status(400).json({ error: 'Invalid record ID — must be a positive integer' });
  }
  next();
});

// ── POST /api/tardiness/preview ─────────────────────────────────────
router.post('/preview', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const result = parsePunchVarianceReport(req.file.path);

    res.json({
      success: true,
      preview: {
        payPeriod: { start: result.payPeriodStart, end: result.payPeriodEnd },
        totalRows: result.totalRows,
        ...result.summary,
        infractionRecords: result.records
          .filter(r => r.classification === 'INFRACTION')
          .map(r => mapRecordForPreview(r)),
        flagRecords: result.records
          .filter(r => r.classification === 'FLAG')
          .map(r => mapRecordForPreview(r)),
        absenceRecords: result.records
          .filter(r => r.classification === 'ABSENCE')
          .map(r => mapRecordForPreview(r, false))
      },
      tempFile: req.file.filename
    });
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.status(400).json({ error: 'Failed to parse file: ' + err.message });
  }
});

// ── POST /api/tardiness/commit ──────────────────────────────────────
router.post('/commit', (req, res) => {
  const { tempFile, excludedInfractions } = req.body;
  if (!tempFile) return res.status(400).json({ error: 'No temp file specified' });

  const safeName = path.basename(tempFile);
  const filePath = path.join(uploadDir, safeName);
  if (!fs.existsSync(filePath)) return res.status(400).json({ error: 'Temp file not found. Please re-upload.' });

  try {
    const db = getDb();
    const result = parsePunchVarianceReport(filePath);

    // Build exclusion set from removed infractions
    const exclusionSet = new Set();
    if (Array.isArray(excludedInfractions)) {
      for (const ex of excludedInfractions) {
        exclusionSet.add(`${ex.employeeName}|${ex.date}`);
      }
    }

    // Reclassify excluded infractions to OK and recalculate counts
    if (exclusionSet.size > 0) {
      let reclassified = 0;
      for (const rec of result.records) {
        if (rec.classification === 'INFRACTION' && exclusionSet.has(`${rec.employeeName}|${rec.date}`)) {
          rec.classification = 'OK';
          reclassified++;
        }
      }
      if (reclassified > 0) {
        result.summary.infractions -= reclassified;
        result.summary.ok += reclassified;
        console.log(`[Commit] Reclassified ${reclassified} excluded infractions to OK`);
      }
    }

    const insertReport = db.prepare(`
      INSERT INTO tardiness_reports
        (pay_period_start, pay_period_end, total_employees, total_records,
         infraction_count, flag_count, absence_count, ok_count, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertRecord = db.prepare(`
      INSERT INTO tardiness_records
        (report_id, employee_name, shift_date, scheduled_in, scheduled_out,
         actual_in, actual_out, clockin_variance_minutes, clockout_variance_minutes,
         classification)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let reportId;
    const commitAll = db.transaction(() => {
      const info = insertReport.run(
        result.payPeriodStart, result.payPeriodEnd,
        result.summary.totalEmployees, result.totalRows,
        result.summary.infractions, result.summary.flags,
        result.summary.absences, result.summary.ok,
        req.session?.username || 'admin'
      );
      reportId = Number(info.lastInsertRowid);

      for (const rec of result.records) {
        insertRecord.run(
          reportId, rec.employeeName, rec.date,
          rec.scheduledIn, rec.scheduledOut,
          rec.actualIn, rec.actualOut,
          rec.clockInVarianceMinutes, rec.clockOutVarianceMinutes,
          rec.classification
        );
      }
    });

    commitAll();
    try { fs.unlinkSync(filePath); } catch (_) {}

    // Async Slack notification
    postTardinessSlack(result, reportId).catch(err => {
      console.error('Slack tardiness notification failed:', err.message);
    });

    const slackSent = isBotConfigured() && !!process.env.TARDINESS_SLACK_CHANNEL_ID;

    res.json({
      success: true,
      slackSent,
      report: {
        id: reportId,
        payPeriodStart: result.payPeriodStart,
        payPeriodEnd: result.payPeriodEnd,
        totalEmployees: result.summary.totalEmployees,
        totalRecords: result.totalRows,
        infractions: result.summary.infractions,
        flags: result.summary.flags,
        absences: result.summary.absences
      }
    });
  } catch (err) {
    console.error('Tardiness commit failed:', err.message);
    res.status(500).json({ error: 'Commit failed: ' + err.message });
  }
});

// ── GET /api/tardiness/reports ──────────────────────────────────────
router.get('/reports', (req, res) => {
  try {
    const db = getDb();
    const reports = db.prepare(
      'SELECT * FROM tardiness_reports ORDER BY created_at DESC'
    ).all();
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/tardiness/report/:id ────────────────────────────────
router.delete('/report/:id', (req, res) => {
  try {
    const db = getDb();
    const report = db.prepare('SELECT id FROM tardiness_reports WHERE id = ?').get(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const deleteAll = db.transaction(() => {
      db.prepare('DELETE FROM tardiness_records WHERE report_id = ?').run(req.params.id);
      db.prepare('DELETE FROM tardiness_reports WHERE id = ?').run(req.params.id);
    });
    deleteAll();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/tardiness/report/:id ───────────────────────────────────
router.get('/report/:id', (req, res) => {
  try {
    const data = getReportWithRecords(getDb(), req.params.id);
    if (!data) return res.status(404).json({ error: 'Report not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/tardiness/report/:id/pdf — Full Analysis Report PDF ────
router.get('/report/:id/pdf', async (req, res) => {
  try {
    const data = getReportWithRecords(getDb(), req.params.id);
    if (!data) return res.status(404).json({ error: 'Report not found' });

    const { report, records } = data;
    const buffer = await pdfToBuffer(() => {
      const doc = new PDFDocument({ margin: 40, size: 'letter' });
      buildFullReportPDF(doc, report, records);
      return doc;
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="tardiness-report-${report.pay_period_start}-to-${report.pay_period_end}.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error('Tardiness PDF error:', err.message);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

// ── GET /api/tardiness/report/:id/infractions — Combined infraction notices ─
router.get('/report/:id/infractions', async (req, res) => {
  try {
    const data = getReportWithRecords(getDb(), req.params.id, 'INFRACTION');
    if (!data) return res.status(404).json({ error: 'Report not found' });

    const { report, records: infractions } = data;
    if (infractions.length === 0) return res.status(404).json({ error: 'No infractions found' });

    const buffer = await pdfToBuffer(() => {
      const doc = new PDFDocument({ margin: 50, size: 'letter' });
      for (let i = 0; i < infractions.length; i++) {
        if (i > 0) doc.addPage();
        drawInfractionNotice(doc, infractions[i], report);
      }
      return doc;
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="infraction-notices-${report.pay_period_start}-to-${report.pay_period_end}.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error('Infraction notices PDF error:', err.message);
    res.status(500).json({ error: 'Failed to generate infraction notices' });
  }
});

// ── GET /api/tardiness/infraction/:recordId/pdf — Single infraction notice ──
router.get('/infraction/:recordId/pdf', async (req, res) => {
  try {
    const db = getDb();
    const record = db.prepare(`
      SELECT tr.*, tp.pay_period_start, tp.pay_period_end
      FROM tardiness_records tr
      JOIN tardiness_reports tp ON tr.report_id = tp.id
      WHERE tr.id = ? AND tr.classification = 'INFRACTION'
    `).get(req.params.recordId);

    if (!record) return res.status(404).json({ error: 'Infraction record not found' });

    const buffer = await pdfToBuffer(() => {
      const doc = new PDFDocument({ margin: 50, size: 'letter' });
      drawInfractionNotice(doc, record, {
        pay_period_start: record.pay_period_start,
        pay_period_end: record.pay_period_end
      });
      return doc;
    });

    const safeName = record.employee_name.replace(/[^a-zA-Z0-9]/g, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="infraction-${safeName}-${record.shift_date}.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error('Single infraction PDF error:', err.message);
    res.status(500).json({ error: 'Failed to generate infraction notice' });
  }
});

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Draw a styled, paginated table in a PDFKit document.
 * Supports colored header rows, alternating row backgrounds, and rich
 * cell objects with custom color/bg/bold/align.
 *
 * @param {PDFDocument} doc - Active PDFKit document
 * @param {object} opts - Table configuration
 * @param {{ label: string, width: number, align?: string }[]} opts.cols - Column definitions
 * @param {Array<Array<string|{ text: string, color?: string, bg?: string, bold?: boolean, align?: string }>>} opts.rows
 * @param {string} [opts.headerBg] - Header background color (default: COLORS.darkHeader)
 * @param {number} [opts.startX=40] - Left edge X coordinate
 * @param {number} [opts.rowH=22] - Row height in points
 * @param {number} [opts.fontSize=8] - Font size in points
 */
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

    // Alternating row bg
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

/**
 * Build the full Tardiness Analysis Report PDF (v3 branded format).
 * Renders: classification rules, executive summary, infraction table,
 * flag table, and per-employee detail sections.
 *
 * Caller must create the PDFDocument and call doc.end() afterward
 * (or use via pdfToBuffer which handles lifecycle).
 *
 * @param {PDFDocument} doc - Active PDFKit document (letter size, 40pt margin)
 * @param {object} report - DB row from tardiness_reports
 * @param {object[]} records - Array of DB rows from tardiness_records
 */
function buildFullReportPDF(doc, report, records) {
  const summary = computeDetailedSummary(report, records);
  const infractions = records.filter(r => r.classification === 'INFRACTION');
  const flags = records.filter(r => r.classification === 'FLAG');

  // ── Page 1: Header ──
  doc.fontSize(22).font('Helvetica-Bold').fillColor(COLORS.dark)
    .text('Informe de Análisis de Tardanza', { align: 'center' });
  doc.fontSize(11).font('Helvetica').fillColor(COLORS.gray)
    .text('La Rambla FSU', { align: 'center' });
  doc.fontSize(9).fillColor(COLORS.gray)
    .text(`Período de Pago: ${formatDateMDY(report.pay_period_start)} - ${formatDateMDY(report.pay_period_end)}`, { align: 'center' });
  doc.text(`Generado: ${formatDateTime(new Date())}`, { align: 'center' });
  doc.moveDown(0.8);

  // Blue separator line
  doc.moveTo(40, doc.y).lineTo(572, doc.y)
    .strokeColor(COLORS.blueLine).lineWidth(2).stroke();
  doc.moveDown(1.5);

  // ── Classification Rules ──
  doc.fontSize(14).font('Helvetica-Bold').fillColor(COLORS.dark)
    .text('Reglas de Clasificación (Variación de Entrada)');
  doc.moveDown(0.5);

  drawStyledTable(doc, {
    cols: [
      { label: 'Estado', width: 130, align: 'center' },
      { label: 'Criterio', width: 245, align: 'center' },
      { label: 'Acción Requerida', width: 157, align: 'center' },
    ],
    rows: [
      [{ text: 'INFRACCIÓN', bg: COLORS.red, color: COLORS.white, bold: true, align: 'center' },
       'Entrada >= 10 minutos tarde', 'Aviso de infracción emitido'],
      [{ text: 'ALERTA', bg: COLORS.orange, color: COLORS.white, bold: true, align: 'center' },
       'Entrada > 5 min y < 10 min tarde', 'Advertencia -- monitorear empleado'],
      [{ text: 'AUSENCIA', bg: COLORS.green, color: COLORS.white, bold: true, align: 'center' },
       'Sin registro de entrada (solo programado)', 'Verificar con el empleado'],
      [{ text: 'OK', bg: COLORS.blue, color: COLORS.white, bold: true, align: 'center' },
       'Entrada <= 5 minutos tarde o temprano', 'Sin acción requerida'],
    ],
    headerBg: COLORS.darkHeader,
    rowH: 28,
    fontSize: 8,
  });
  doc.moveDown(1.5);

  // ── Executive Summary ──
  doc.fontSize(14).font('Helvetica-Bold').fillColor(COLORS.dark)
    .text('Resumen Ejecutivo');
  doc.moveDown(0.5);

  drawStyledTable(doc, {
    cols: [
      { label: 'Métrica', width: 380 },
      { label: 'Cantidad', width: 152, align: 'center' },
    ],
    rows: [
      ['Total de Empleados', String(summary.totalEmployees)],
      ['Total de Infracciones de Entrada (>10 min)', String(summary.totalInfractions)],
      ['Empleados con Infracciones', String(summary.employeesWithInfractions)],
      ['Total de Alertas de Entrada (>5 min)', String(summary.totalFlags)],
      ['Empleados solo con Alertas (sin infracciones)', String(summary.employeesFlagsOnly)],
      ['Empleados con Algún Problema', String(summary.employeesWithAnyIssue)],
      ['Récord Limpio (sin problemas)', String(summary.cleanRecord)],
    ],
    headerBg: COLORS.darkHeader,
    rowH: 24,
    fontSize: 9,
  });

  // ── Page 2+: Infractions Table ──
  doc.addPage();
  doc.fontSize(16).font('Helvetica-Bold').fillColor(COLORS.red)
    .text('Infracciones de Entrada (Tarde > 10 minutos)');
  doc.moveDown(0.3);
  doc.fontSize(9).font('Helvetica').fillColor(COLORS.dark)
    .text('Empleados que registraron entrada más de 10 minutos después de su hora programada. Estas entradas requieren un aviso de infracción según la política de la empresa.');
  doc.moveDown(0.5);

  if (infractions.length > 0) {
    drawStyledTable(doc, {
      cols: [
        { label: 'Empleado', width: 230 },
        { label: 'Fecha', width: 100, align: 'center' },
        { label: 'Variación de Entrada', width: 110, align: 'center' },
        { label: 'Min. Tarde', width: 92, align: 'center' },
      ],
      rows: infractions.map(r => [
        r.employee_name,
        formatDateMDY(r.shift_date),
        formatVariance(r.clockin_variance_minutes),
        String(Math.abs(r.clockin_variance_minutes || 0)),
      ]),
      headerBg: COLORS.red,
      rowH: 22,
      fontSize: 8,
    });
  }

  // ── Flags Table ──
  if (doc.y > doc.page.height - 150) doc.addPage();
  else doc.moveDown(1.5);

  doc.fontSize(16).font('Helvetica-Bold').fillColor(COLORS.orange)
    .text('Alertas de Entrada (Tarde > 5 minutos, <= 10 minutos)');
  doc.moveDown(0.3);
  doc.fontSize(9).font('Helvetica').fillColor(COLORS.dark)
    .text('Empleados que registraron entrada entre 5 y 10 minutos tarde. Estos se marcan como advertencias y deben ser monitoreados.');
  doc.moveDown(0.5);

  if (flags.length > 0) {
    drawStyledTable(doc, {
      cols: [
        { label: 'Empleado', width: 230 },
        { label: 'Fecha', width: 100, align: 'center' },
        { label: 'Variación de Entrada', width: 110, align: 'center' },
        { label: 'Min. Tarde', width: 92, align: 'center' },
      ],
      rows: flags.map(r => [
        r.employee_name,
        formatDateMDY(r.shift_date),
        formatVariance(r.clockin_variance_minutes),
        String(Math.abs(r.clockin_variance_minutes || 0)),
      ]),
      headerBg: COLORS.orange,
      rowH: 22,
      fontSize: 8,
    });
  }

  // ── Employee Detail — Infracted Employees ──
  doc.addPage();
  doc.fontSize(16).font('Helvetica-Bold').fillColor(COLORS.dark)
    .text('Detalle por Empleado -- Empleados con Infracciones', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(9).font('Helvetica').fillColor(COLORS.dark)
    .text('Detalle de infracciones de entrada y ausencias para cada empleado que registró entrada 10 o más minutos tarde. Las ausencias (sin registro de entrada) se muestran en azul.');
  doc.moveDown(0.8);

  const infEmployees = [...new Set(infractions.map(r => r.employee_name))].sort();
  for (const empName of infEmployees) {
    const empRecords = records.filter(r => r.employee_name === empName &&
      (r.classification === 'INFRACTION' || r.classification === 'ABSENCE'));
    const infCount = empRecords.filter(r => r.classification === 'INFRACTION').length;
    const absCount = empRecords.filter(r => r.classification === 'ABSENCE').length;

    if (doc.y > doc.page.height - 100) doc.addPage();

    // Employee name with colored counts
    doc.font('Helvetica-BoldOblique').fontSize(11);
    doc.fillColor(COLORS.dark).text(`${empName} -- `, { continued: true });
    doc.fillColor(COLORS.red).text(`${infCount} Infracción(es)`, { continued: absCount > 0 });
    if (absCount > 0) {
      doc.fillColor(COLORS.dark).text(' | ', { continued: true });
      doc.fillColor(COLORS.blue).text(`${absCount} Ausencia(s)`);
    }
    doc.moveDown(0.3);

    drawStyledTable(doc, {
      cols: [
        { label: 'Fecha', width: 80, align: 'center' },
        { label: 'Hora Real', width: 90, align: 'center' },
        { label: 'Hora Programada', width: 95, align: 'center' },
        { label: 'Variación de Entrada', width: 100, align: 'center' },
        { label: 'Min. Tarde', width: 82, align: 'center' },
        { label: 'Estado', width: 85, align: 'center' },
      ],
      rows: empRecords.map(r => {
        const isAbs = r.classification === 'ABSENCE';
        const statusColor = r.classification === 'INFRACTION' ? COLORS.red :
                            r.classification === 'ABSENCE' ? COLORS.blue : COLORS.dark;
        return [
          formatDateMDY(r.shift_date),
          isAbs ? 'N/A' : (r.actual_in || '--'),
          isAbs ? 'N/A' : (r.scheduled_in || 'N/A'),
          isAbs ? 'N/A' : formatVariance(r.clockin_variance_minutes),
          isAbs ? 'N/A' : String(Math.abs(r.clockin_variance_minutes || 0)),
          { text: r.classification, color: statusColor, bold: true, align: 'center' },
        ];
      }),
      headerBg: COLORS.darkHeader,
      rowH: 22,
      fontSize: 8,
    });
    doc.moveDown(0.8);
  }
}

/**
 * Draw a single-page infraction notice for one employee record.
 * Includes header, infraction details, policy text, and signature lines.
 *
 * @param {PDFDocument} doc - Active PDFKit document (letter size, 50pt margin)
 * @param {object} record - DB row from tardiness_records
 * @param {{ pay_period_start: string, pay_period_end: string }} report - Report date range
 */
function drawInfractionNotice(doc, record, report) {
  const minutesLate = Math.abs(record.clockin_variance_minutes || 0);

  // Header
  doc.fontSize(20).fillColor(COLORS.navy).text('La Rambla', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(16).fillColor(COLORS.dark).text('Aviso de Infracción por Tardanza', { align: 'center' });
  doc.moveDown(0.2);
  doc.fontSize(9).fillColor(COLORS.gray)
    .text(`Período de Pago: ${report.pay_period_start} al ${report.pay_period_end}`, { align: 'center' });
  doc.moveDown(2);

  // Details
  doc.fontSize(11).fillColor(COLORS.dark);
  const details = [
    ['Empleado(a)', record.employee_name],
    ['Fecha de Infracción', record.shift_date],
    ['Hora Programada de Entrada', record.scheduled_in || 'N/A'],
    ['Hora Real de Entrada', record.actual_in || 'N/A'],
    ['Minutos Tarde', String(minutesLate)],
  ];

  for (const [label, val] of details) {
    doc.font('Helvetica-Bold').text(`${label}: `, { continued: true });
    doc.font('Helvetica').text(val);
  }
  doc.moveDown(1.5);

  // Notice text
  doc.fontSize(10).fillColor(COLORS.dark);
  doc.text(
    'Este aviso sirve como constancia formal de que el/la empleado(a) mencionado(a) llegó tarde a su ' +
    'turno programado. De acuerdo con la política de asistencia de la empresa, se espera que los empleados ' +
    'registren su entrada a la hora programada o antes. La tardanza repetida puede resultar en acciones ' +
    'disciplinarias adicionales.',
    { lineGap: 4 }
  );
  doc.moveDown(1);
  doc.text(
    'Al firmar a continuación, tanto el/la empleado(a) como el/la gerente reconocen que esta infracción ' +
    'ha sido revisada y discutida.',
    { lineGap: 4 }
  );
  doc.moveDown(3);

  // Signature lines
  const sigY = doc.y;
  doc.fontSize(10).fillColor(COLORS.dark);

  // Employee signature
  doc.text('_________________________________________', 50, sigY);
  doc.text('Firma del Empleado(a)', 50, sigY + 16);
  doc.text('Fecha: _______________', 50, sigY + 32);

  // Manager signature
  doc.text('_________________________________________', 330, sigY);
  doc.text('Firma del Gerente', 330, sigY + 16);
  doc.text('Fecha: _______________', 330, sigY + 32);
}

/**
 * Generate a PDFDocument into a Buffer using a PassThrough stream.
 * The build function should create a PDFDocument, render content, and return it
 * (without calling doc.end() — this function handles that).
 *
 * @param {() => PDFDocument} buildFn - Factory that creates and populates a PDFDocument
 * @returns {Promise<Buffer>} Complete PDF as a Buffer
 */
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

/**
 * Post tardiness analysis to Slack: summary message + PDF attachments.
 * Sends to TARDINESS_SLACK_CHANNEL_ID. Non-critical — failures are logged
 * but don't affect the commit response.
 *
 * @param {object} result - Parsed report from tardinessParser
 * @param {number} reportId - Database report ID (for re-fetching records)
 */
async function postTardinessSlack(result, reportId) {
  const channelId = process.env.TARDINESS_SLACK_CHANNEL_ID;
  if (!channelId || !isBotConfigured()) return;

  const text = [
    `*:clock1: Tardiness Analysis Report*`,
    `*Pay Period:* ${result.payPeriodStart} to ${result.payPeriodEnd}`,
    `*Employees Analyzed:* ${result.summary.totalEmployees}`,
    ``,
    `*Results:*`,
    `  :red_circle: Infractions (10+ min late): *${result.summary.infractions}*`,
    `  :large_yellow_circle: Flags (5-10 min late): *${result.summary.flags}*`,
    `  :white_circle: Absences: *${result.summary.absences}*`,
    `  :large_green_circle: Clean: *${result.summary.ok}*`,
  ].join('\n');

  // Post the summary text message
  await sendSlackToChannel(channelId, text);

  // Generate & upload full report PDF
  try {
    const data = getReportWithRecords(getDb(), reportId);

    if (data && data.records.length > 0) {
      const { report, records } = data;
      const reportBuf = await pdfToBuffer(() => {
        const doc = new PDFDocument({ margin: 40, size: 'letter' });
        buildFullReportPDF(doc, report, records);
        return doc;
      });

      await uploadFileToSlack(channelId, reportBuf,
        `tardiness-report-${report.pay_period_start}-to-${report.pay_period_end}.pdf`,
        `Tardiness Report: ${report.pay_period_start} to ${report.pay_period_end}`);

      // Upload infraction notices if any
      const infractions = records.filter(r => r.classification === 'INFRACTION');
      if (infractions.length > 0) {
        const noticesBuf = await pdfToBuffer(() => {
          const doc = new PDFDocument({ margin: 50, size: 'letter' });
          for (let i = 0; i < infractions.length; i++) {
            if (i > 0) doc.addPage();
            drawInfractionNotice(doc, infractions[i], report);
          }
          return doc;
        });

        await uploadFileToSlack(channelId, noticesBuf,
          `infraction-notices-${report.pay_period_start}-to-${report.pay_period_end}.pdf`,
          `Infraction Notices (${infractions.length})`);
      }
    }
  } catch (fileErr) {
    console.error('Slack file upload failed (non-critical):', fileErr.message);
    // Text message was already sent, file upload failure is non-critical
  }
}

/* ─── Name-matching helper ─────────────────────────────────────── */

/**
 * Match a Cowork "Last, First Middle" name to the employees table.
 * Returns { slack_user_id, first_name, last_name } or undefined.
 */
function matchEmployeeByCoworkName(db, coworkName) {
  const commaIdx = coworkName.indexOf(',');
  if (commaIdx === -1) return undefined;
  const lastName  = coworkName.slice(0, commaIdx).trim();
  const firstName = coworkName.slice(commaIdx + 1).trim();
  const firstWord = firstName.split(' ')[0];

  // Try exact match first, then fallback to first-word match
  return db.prepare(
    `SELECT slack_user_id, first_name, last_name FROM employees
     WHERE last_name = ? AND (first_name = ? OR first_name LIKE ?)`
  ).get(lastName, firstName, firstWord + '%');
}

/* ─── Notify infracted employees via Slack DM ─────────────────── */

/**
 * POST /report/:id/notify-infractions
 * Send Spanish infraction DMs to each employee with infractions.
 * Opens a group DM (admin + employee) so the admin sees replies,
 * falling back to 1:1 DMs if no admin Slack ID is configured.
 */
router.post('/report/:id/notify-infractions', async (req, res) => {
  if (!isBotConfigured()) {
    return res.status(400).json({ error: 'Slack bot not configured' });
  }

  try {
    const db = getDb();

    // Resolve admin's Slack ID (env var primary, session fallback)
    let adminSlackId = process.env.ADMIN_SLACK_USER_ID || null;
    if (!adminSlackId && req.session?.employeeId) {
      const adminEmp = db.prepare('SELECT slack_user_id FROM employees WHERE id = ?').get(req.session.employeeId);
      adminSlackId = adminEmp?.slack_user_id || null;
    }

    const data = getReportWithRecords(db, req.params.id, 'INFRACTION');
    if (!data) return res.status(404).json({ error: 'Report not found' });

    const { report, records: infractions } = data;
    if (infractions.length === 0) {
      return res.json({ success: true, sent: [], notFound: [], noSlackId: [], message: 'No infractions to notify.' });
    }

    // Group infractions by employee_name
    const byEmployee = {};
    for (const rec of infractions) {
      if (!byEmployee[rec.employee_name]) byEmployee[rec.employee_name] = [];
      byEmployee[rec.employee_name].push(rec);
    }

    console.log(`[Notify] Report ${req.params.id}: ${Object.keys(byEmployee).length} employees, ${infractions.length} infractions`);

    const results = { sent: [], notFound: [], noSlackId: [], errors: [] };

    for (const [coworkName, records] of Object.entries(byEmployee)) {
      const emp = matchEmployeeByCoworkName(db, coworkName);

      if (!emp) {
        results.notFound.push(coworkName);
        continue;
      }
      if (!emp.slack_user_id) {
        results.noSlackId.push(`${emp.first_name} ${emp.last_name}`);
        continue;
      }

      // Build Spanish DM
      const infractionLines = records.map(r => {
        const mins = Math.abs(r.clockin_variance_minutes || 0);
        return `  \u2022 *${r.shift_date}*: Horario ${r.scheduled_in || 'N/A'}, Entrada ${r.actual_in || 'N/A'} (${mins} min tarde)`;
      });

      const text = [
        `:red_circle: *Notificacion de Infraccion por Tardanza*`,
        `*Periodo de Pago:* ${report.pay_period_start} al ${report.pay_period_end}`,
        ``,
        `Hola ${emp.first_name}, tienes ${records.length} infraccion(es) de entrada en este periodo:`,
        ``,
        ...infractionLines,
        ``,
        `Tienes *24 horas* para responder a este mensaje con una de las siguientes opciones:`,
        `1. Justificacion de la tardanza`,
        `2. Si olvido ponchar a la hora correcta- solicitar un ajuste en la hora de entrada`,
        ``,
        `De no recibir respuesta, la infraccion quedara registrada sin justificacion.`,
      ].join('\n');

      try {
        if (adminSlackId && adminSlackId !== emp.slack_user_id) {
          const groupChannelId = await openGroupDM([adminSlackId, emp.slack_user_id]);
          await sendSlackToChannel(groupChannelId, text);
        } else {
          await sendSlackDM(emp.slack_user_id, text);
        }
        results.sent.push(`${emp.first_name} ${emp.last_name}`);
      } catch (dmErr) {
        console.error(`[Notify] DM failed for ${coworkName}:`, dmErr.message);
        results.errors.push(`${emp.first_name} ${emp.last_name}: ${dmErr.message}`);
      }
    }

    console.log(`[Notify] Done: ${results.sent.length} sent, ${results.notFound.length} not found, ${results.errors.length} errors`);
    res.json({ success: true, ...results });
  } catch (err) {
    console.error('[Notify] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
