/**
 * Report generation routes — PDF and CSV exports.
 *
 * Provides:
 *   - Filtered CSV export (by status)
 *   - Full roster PDF report (landscape, paginated)
 *   - Individual employee PTO statement PDF
 *   - Year-end summary PDF
 */

const express = require('express');
const PDFDocument = require('pdfkit');
const { getDb } = require('../db');
const { SICK_BALANCE_CAP } = require('../services/accrualEngine');
const { MONTH_NAMES_SHORT } = require('../utils/constants');

const router = express.Router();

// ── Shared: build accrual summary with optional status filter ───────
function getSummaryData(filters = {}) {
  const db = getDb();
  let where = '';
  const params = [];

  if (filters.status) {
    where += ' AND e.status = ?';
    params.push(filters.status);
  }

  return db.prepare(`
    SELECT
      e.id, e.first_name, e.last_name, e.full_name, e.employee_type,
      e.status, e.first_clock_in,
      COALESCE(SUM(a.sick_days_earned), 0)  AS sick_earned,
      COALESCE(SUM(a.vacation_days_earned), 0) AS vacation_earned,
      COALESCE(sick_t.total, 0)  AS sick_taken,
      COALESCE(vac_t.total, 0)   AS vacation_taken
    FROM employees e
    LEFT JOIN accruals a ON e.id = a.employee_id
    LEFT JOIN (SELECT employee_id, SUM(days_taken) AS total FROM time_off_taken WHERE type = 'sick' GROUP BY employee_id) sick_t ON e.id = sick_t.employee_id
    LEFT JOIN (SELECT employee_id, SUM(days_taken) AS total FROM time_off_taken WHERE type = 'vacation' GROUP BY employee_id) vac_t ON e.id = vac_t.employee_id
    WHERE 1=1 ${where}
    GROUP BY e.id
    ORDER BY e.last_name, e.first_name
  `).all(...params);
}

// ── CFA brand colors ────────────────────────────────────────────────
const COLORS = {
  navy: '#004F71',
  gray: '#5B6770',
  dark: '#1F2937',
  rowAlt: '#FAFAF8',
  headerBg: '#EEEDEB'
};

// ── GET /api/reports/export/csv — Filtered CSV export ───────────────
router.get('/export/csv', (req, res) => {
  try {
    const { status } = req.query;
    const data = getSummaryData({ status: status || undefined });

    let csv = 'First Name,Last Name,Type,Status,Start Date,Sick Earned,Vacation Earned,Sick Taken,Vacation Taken,Sick Balance,Vacation Balance\n';

    for (const row of data) {
      const sickBal = Math.min(row.sick_earned - row.sick_taken, SICK_BALANCE_CAP).toFixed(2);
      const vacBal = (row.vacation_earned - row.vacation_taken).toFixed(2);
      csv += `"${row.first_name}","${row.last_name}","${row.employee_type}","${row.status}","${row.first_clock_in || ''}",${row.sick_earned.toFixed(2)},${row.vacation_earned.toFixed(2)},${row.sick_taken.toFixed(2)},${row.vacation_taken.toFixed(2)},${sickBal},${vacBal}\n`;
    }

    const statusLabel = status ? `-${status}` : '';
    const today = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="pto-export${statusLabel}-${today}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('Error exporting CSV:', err.message);
    res.status(500).json({ error: 'Failed to export CSV' });
  }
});

// ── GET /api/reports/export/pdf — Full roster PDF report ────────────
router.get('/export/pdf', (req, res) => {
  try {
    const { status } = req.query;
    const data = getSummaryData({ status: status || undefined });

    const doc = new PDFDocument({ margin: 40, size: 'letter', layout: 'landscape' });
    const today = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="pto-report-${today}.pdf"`);
    doc.pipe(res);

    // Header
    doc.fontSize(18).fillColor(COLORS.navy).text('CFA La Rambla — PTO Report', { align: 'center' });
    doc.fontSize(9).fillColor(COLORS.gray).text(`Generated: ${new Date().toLocaleDateString()} | Filter: ${status || 'All'}`, { align: 'center' });
    doc.moveDown(0.5);

    // Column definitions
    const startX = 40;
    const tableWidth = 680;
    const cols = [
      { label: 'Name', width: 140 }, { label: 'Type', width: 55 },
      { label: 'Status', width: 55 }, { label: 'Start Date', width: 70 },
      { label: 'Sick Earned', width: 65 }, { label: 'Sick Taken', width: 60 },
      { label: 'Sick Bal', width: 55 }, { label: 'Vac Earned', width: 65 },
      { label: 'Vac Taken', width: 60 }, { label: 'Vac Bal', width: 55 },
    ];

    let y = doc.y;

    function drawTableHeader() {
      doc.rect(startX, y, tableWidth, 16).fill(COLORS.headerBg);
      let x = startX + 4;
      doc.fontSize(7).fillColor(COLORS.navy);
      for (const col of cols) {
        doc.text(col.label, x, y + 4, { width: col.width - 8, align: 'left' });
        x += col.width;
      }
      y += 18;
    }

    drawTableHeader();

    // Data rows
    doc.fontSize(7).fillColor(COLORS.dark);
    for (let i = 0; i < data.length; i++) {
      if (y > 560) {
        doc.addPage();
        y = 40;
        drawTableHeader();
        doc.fontSize(7).fillColor(COLORS.dark);
      }

      const row = data[i];
      const sickBal = Math.min(row.sick_earned - row.sick_taken, SICK_BALANCE_CAP);
      const vacBal = row.vacation_earned - row.vacation_taken;

      if (i % 2 === 0) {
        doc.rect(startX, y, tableWidth, 14).fill(COLORS.rowAlt);
        doc.fillColor(COLORS.dark);
      }

      let x = startX + 4;
      const values = [
        `${row.first_name} ${row.last_name}`, row.employee_type, row.status,
        row.first_clock_in || 'N/A',
        row.sick_earned.toFixed(1), row.sick_taken.toFixed(1), sickBal.toFixed(1),
        row.vacation_earned.toFixed(2), row.vacation_taken.toFixed(1), vacBal.toFixed(2),
      ];
      for (let j = 0; j < cols.length; j++) {
        doc.text(values[j], x, y + 3, { width: cols[j].width - 8, align: 'left' });
        x += cols[j].width;
      }
      y += 14;
    }

    // Footer
    doc.moveDown(2);
    doc.fontSize(8).fillColor(COLORS.gray).text(`Total employees: ${data.length}`, startX);
    doc.end();
  } catch (err) {
    console.error('Error generating PDF:', err.message);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

// ── GET /api/reports/export/statement/:employeeId — Individual PTO statement ─
router.get('/export/statement/:employeeId', (req, res) => {
  try {
    const db = getDb();
    const { employeeId } = req.params;

    const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
    if (!employee) return res.status(404).json({ error: 'Employee not found' });

    const months = db.prepare(`
      SELECT mh.year, mh.month, mh.total_hours,
             COALESCE(a.sick_days_earned, 0) AS sick_days_earned,
             COALESCE(a.vacation_days_earned, 0) AS vacation_days_earned
      FROM monthly_hours mh
      LEFT JOIN accruals a ON mh.employee_id = a.employee_id AND mh.year = a.year AND mh.month = a.month
      WHERE mh.employee_id = ?
      ORDER BY mh.year, mh.month
    `).all(employeeId);

    const timeOff = db.prepare('SELECT * FROM time_off_taken WHERE employee_id = ? ORDER BY date_taken').all(employeeId);

    const totalSick = months.reduce((s, m) => s + m.sick_days_earned, 0);
    const totalVac = months.reduce((s, m) => s + m.vacation_days_earned, 0);
    const sickTaken = timeOff.filter(t => t.type === 'sick').reduce((s, t) => s + t.days_taken, 0);
    const vacTaken = timeOff.filter(t => t.type === 'vacation').reduce((s, t) => s + t.days_taken, 0);

    const doc = new PDFDocument({ margin: 50, size: 'letter' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="pto-statement-${employee.first_name}-${employee.last_name}.pdf"`);
    doc.pipe(res);

    // Header
    doc.fontSize(18).fillColor(COLORS.navy).text('PTO Statement', { align: 'center' });
    doc.fontSize(10).fillColor(COLORS.gray).text('CFA La Rambla', { align: 'center' });
    doc.moveDown();

    // Employee info
    doc.fontSize(12).fillColor(COLORS.dark).text(`${employee.first_name} ${employee.last_name}`, { underline: true });
    doc.fontSize(9).fillColor(COLORS.gray);
    doc.text(`Type: ${employee.employee_type} | Status: ${employee.status} | Start Date: ${employee.first_clock_in || 'N/A'}`);
    doc.text(`Generated: ${new Date().toLocaleDateString()}`);
    doc.moveDown();

    // Balance summary
    doc.fontSize(11).fillColor(COLORS.navy).text('Balance Summary');
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor(COLORS.dark);
    const sickBal = Math.min(totalSick - sickTaken, SICK_BALANCE_CAP);
    doc.text(`Sick Days:     Earned ${totalSick.toFixed(1)}  |  Taken ${sickTaken.toFixed(1)}  |  Balance ${sickBal.toFixed(1)}${sickBal >= SICK_BALANCE_CAP ? ' (cap)' : ''}`);
    doc.text(`Vacation Days: Earned ${totalVac.toFixed(2)}  |  Taken ${vacTaken.toFixed(1)}  |  Balance ${(totalVac - vacTaken).toFixed(2)}`);
    doc.moveDown();

    // Monthly breakdown table
    doc.fontSize(11).fillColor(COLORS.navy).text('Monthly Accrual History');
    doc.moveDown(0.3);

    let y = doc.y;
    const sx = 50;
    doc.rect(sx, y, 500, 14).fill(COLORS.headerBg);
    doc.fontSize(7).fillColor(COLORS.navy);
    doc.text('Month', sx + 4, y + 3, { width: 80 });
    doc.text('Hours', sx + 84, y + 3, { width: 60 });
    doc.text('Sick Earned', sx + 144, y + 3, { width: 70 });
    doc.text('Vac Earned', sx + 214, y + 3, { width: 70 });
    doc.text('Vac Rate', sx + 284, y + 3, { width: 80 });
    y += 16;

    doc.fontSize(7).fillColor(COLORS.dark);
    for (const m of months) {
      if (y > 700) { doc.addPage(); y = 50; }
      const rate = m.vacation_days_earned === 1.25 ? '10 hrs/mo (15+yr)' :
                   m.vacation_days_earned === 1.00 ? '8 hrs/mo (5-15yr)' :
                   m.vacation_days_earned === 0.75 ? '6 hrs/mo (1-5yr)' :
                   m.vacation_days_earned === 0.50 ? '4 hrs/mo (0-1yr)' : '-';
      doc.text(`${MONTH_NAMES_SHORT[m.month]} ${m.year}`, sx + 4, y + 1, { width: 80 });
      doc.text(m.total_hours.toFixed(1), sx + 84, y + 1, { width: 60 });
      doc.text(m.sick_days_earned.toFixed(0), sx + 144, y + 1, { width: 70 });
      doc.text(m.vacation_days_earned.toFixed(2), sx + 214, y + 1, { width: 70 });
      doc.text(rate, sx + 284, y + 1, { width: 80 });
      y += 12;
    }

    // Time-off history
    if (timeOff.length > 0) {
      doc.x = sx;
      doc.y = y + 10;
      doc.fontSize(11).fillColor(COLORS.navy).text('Time-Off History');
      doc.moveDown(0.3);
      y = doc.y;

      doc.rect(sx, y, 500, 14).fill(COLORS.headerBg);
      doc.fontSize(7).fillColor(COLORS.navy);
      doc.text('Date', sx + 4, y + 3, { width: 80 });
      doc.text('Type', sx + 84, y + 3, { width: 60 });
      doc.text('Days', sx + 144, y + 3, { width: 50 });
      doc.text('Notes', sx + 194, y + 3, { width: 300 });
      y += 16;

      doc.fontSize(7).fillColor(COLORS.dark);
      for (const t of timeOff) {
        if (y > 700) { doc.addPage(); y = 50; }
        doc.text(t.date_taken, sx + 4, y + 1, { width: 80 });
        doc.text(t.type, sx + 84, y + 1, { width: 60 });
        doc.text(t.days_taken.toString(), sx + 144, y + 1, { width: 50 });
        doc.text(t.notes || '', sx + 194, y + 1, { width: 300 });
        y += 12;
      }
    }

    doc.end();
  } catch (err) {
    console.error('Error generating statement PDF:', err.message);
    res.status(500).json({ error: 'Failed to generate statement' });
  }
});

// ── GET /api/reports/export/year-end — Year-end summary PDF ─────────
router.get('/export/year-end', (req, res) => {
  try {
    const db = getDb();
    const year = parseInt(req.query.year) || new Date().getFullYear();

    const data = db.prepare(`
      SELECT
        e.id, e.first_name, e.last_name, e.employee_type, e.status,
        COALESCE(a.sick_earned, 0) AS sick_earned,
        COALESCE(a.vac_earned, 0)  AS vac_earned,
        COALESCE(st.sick_taken, 0) AS sick_taken,
        COALESCE(vt.vac_taken, 0)  AS vac_taken
      FROM employees e
      LEFT JOIN (
        SELECT employee_id, SUM(sick_days_earned) AS sick_earned, SUM(vacation_days_earned) AS vac_earned
        FROM accruals WHERE year = ? GROUP BY employee_id
      ) a ON e.id = a.employee_id
      LEFT JOIN (
        SELECT employee_id, SUM(days_taken) AS sick_taken
        FROM time_off_taken WHERE type = 'sick' AND strftime('%Y', date_taken) = ? GROUP BY employee_id
      ) st ON e.id = st.employee_id
      LEFT JOIN (
        SELECT employee_id, SUM(days_taken) AS vac_taken
        FROM time_off_taken WHERE type = 'vacation' AND strftime('%Y', date_taken) = ? GROUP BY employee_id
      ) vt ON e.id = vt.employee_id
      WHERE COALESCE(a.sick_earned, 0) > 0 OR COALESCE(a.vac_earned, 0) > 0
         OR COALESCE(st.sick_taken, 0) > 0 OR COALESCE(vt.vac_taken, 0) > 0
      ORDER BY e.last_name, e.first_name
    `).all(year, String(year), String(year));

    const doc = new PDFDocument({ margin: 40, size: 'letter', layout: 'landscape' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="pto-year-end-${year}.pdf"`);
    doc.pipe(res);

    doc.fontSize(18).fillColor(COLORS.navy).text(`CFA La Rambla — Year-End PTO Summary ${year}`, { align: 'center' });
    doc.fontSize(9).fillColor(COLORS.gray).text(`Generated: ${new Date().toLocaleDateString()}`, { align: 'center' });
    doc.moveDown();

    const sx = 40;
    const tableWidth = 670;
    let y = doc.y;
    const cols = [
      { label: 'Name', width: 150 }, { label: 'Type', width: 60 },
      { label: 'Status', width: 60 }, { label: 'Sick Earned', width: 70 },
      { label: 'Sick Taken', width: 70 }, { label: 'Sick Net', width: 60 },
      { label: 'Vac Earned', width: 70 }, { label: 'Vac Taken', width: 70 },
      { label: 'Vac Net', width: 60 },
    ];

    function drawYearHeader() {
      doc.rect(sx, y, tableWidth, 16).fill(COLORS.headerBg);
      let x = sx + 4;
      doc.fontSize(7).fillColor(COLORS.navy);
      for (const col of cols) {
        doc.text(col.label, x, y + 4, { width: col.width - 8 });
        x += col.width;
      }
      y += 18;
    }

    drawYearHeader();

    doc.fontSize(7).fillColor(COLORS.dark);
    let totSickE = 0, totSickT = 0, totVacE = 0, totVacT = 0;

    for (let i = 0; i < data.length; i++) {
      if (y > 560) {
        doc.addPage();
        y = 40;
        drawYearHeader();
        doc.fontSize(7).fillColor(COLORS.dark);
      }

      const r = data[i];
      totSickE += r.sick_earned;
      totSickT += r.sick_taken;
      totVacE += r.vac_earned;
      totVacT += r.vac_taken;

      if (i % 2 === 0) {
        doc.rect(sx, y, tableWidth, 14).fill(COLORS.rowAlt);
        doc.fillColor(COLORS.dark);
      }

      let x = sx + 4;
      const values = [
        `${r.first_name} ${r.last_name}`, r.employee_type, r.status,
        r.sick_earned.toFixed(1), r.sick_taken.toFixed(1),
        Math.min(r.sick_earned - r.sick_taken, SICK_BALANCE_CAP).toFixed(1),
        r.vac_earned.toFixed(2), r.vac_taken.toFixed(1),
        (r.vac_earned - r.vac_taken).toFixed(2),
      ];
      for (let j = 0; j < cols.length; j++) {
        doc.text(values[j], x, y + 3, { width: cols[j].width - 8 });
        x += cols[j].width;
      }
      y += 14;
    }

    // Totals row
    y += 4;
    doc.rect(sx, y, tableWidth, 16).fill(COLORS.navy);
    doc.fontSize(7).fillColor('#FFFFFF');
    let x = sx + 4;
    doc.text(`TOTALS (${data.length} employees)`, x, y + 4, { width: 270 });
    x += 270;
    doc.text(totSickE.toFixed(1), x, y + 4, { width: 62 }); x += 70;
    doc.text(totSickT.toFixed(1), x, y + 4, { width: 62 }); x += 70;
    doc.text((totSickE - totSickT).toFixed(1), x, y + 4, { width: 52 }); x += 60;
    doc.text(totVacE.toFixed(2), x, y + 4, { width: 62 }); x += 70;
    doc.text(totVacT.toFixed(1), x, y + 4, { width: 62 }); x += 70;
    doc.text((totVacE - totVacT).toFixed(2), x, y + 4, { width: 52 });

    doc.end();
  } catch (err) {
    console.error('Error generating year-end PDF:', err.message);
    res.status(500).json({ error: 'Failed to generate year-end report' });
  }
});

module.exports = router;
