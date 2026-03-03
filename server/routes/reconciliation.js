/**
 * Reconciliation routes — multi-file upload, Python execution, HTML report serving.
 *
 * Single-step flow (no preview/commit):
 *   POST /run — upload 6 files + month/year, spawn Python, return result
 *
 * Report endpoints:
 *   GET  /reports          — list all reports
 *   GET  /report/:id/view  — serve the generated HTML report
 *   DELETE /report/:id     — delete report + file
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { getDb } = require('../db');

const router = express.Router();

// Directories
const uploadDir = path.join(__dirname, '..', '..', 'uploads');
const reportsDir = path.join(__dirname, '..', '..', 'data', 'reconciliation-reports');
const scriptsDir = path.join(__dirname, '..', '..', 'scripts');

for (const dir of [uploadDir, reportsDir]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Multer for 6 named file fields
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 20 * 1024 * 1024 }
});

const reconciliationUpload = upload.fields([
  { name: 'gastos', maxCount: 1 },
  { name: 'chase', maxCount: 1 },
  { name: 'amexPlatinum', maxCount: 1 },
  { name: 'amexDelta', maxCount: 1 },
  { name: 'bancoCurrent', maxCount: 1 },
  { name: 'bancoPrior', maxCount: 1 },
]);

// ── POST /api/reconciliation/run ──────────────────────────────────────
router.post('/run', reconciliationUpload, async (req, res) => {
  const { month, year } = req.body;

  const m = parseInt(month, 10);
  const y = parseInt(year, 10);
  if (!m || m < 1 || m > 12 || !y || y < 2020 || y > 2100) {
    cleanupFiles(req.files);
    return res.status(400).json({ error: 'Invalid month or year' });
  }

  // Validate all 6 files present
  const requiredFields = ['gastos', 'chase', 'amexPlatinum', 'amexDelta', 'bancoCurrent', 'bancoPrior'];
  for (const field of requiredFields) {
    if (!req.files[field] || !req.files[field][0]) {
      cleanupFiles(req.files);
      return res.status(400).json({ error: `Missing required file: ${field}` });
    }
  }

  // Create temp working directory
  const runId = `recon-${Date.now()}`;
  const workDir = path.join(uploadDir, runId);
  fs.mkdirSync(workDir, { recursive: true });

  // Map uploaded files → standardized names expected by Python script
  const fileMap = {
    gastos: 'gastos.csv',
    chase: 'chase.csv',
    amexPlatinum: 'amex_platinum.xlsx',
    amexDelta: 'amex_delta.xlsx',
    bancoCurrent: 'banco_current.csv',
    bancoPrior: 'banco_prior.csv',
  };

  try {
    for (const [field, standardName] of Object.entries(fileMap)) {
      const src = req.files[field][0].path;
      const dest = path.join(workDir, standardName);
      fs.copyFileSync(src, dest);
    }
  } catch (err) {
    cleanupFiles(req.files);
    cleanupDir(workDir);
    return res.status(500).json({ error: 'Failed to prepare files: ' + err.message });
  }

  // Clean up multer temp files (already copied)
  cleanupFiles(req.files);

  // Spawn Python
  const pythonScript = path.join(scriptsDir, 'reconcile.py');
  const pythonArgs = [
    pythonScript,
    '--month', String(m),
    '--year', String(y),
    '--uploads-dir', workDir,
    '--output-dir', reportsDir,
    '--work-dir', workDir,
  ];

  const pythonBin = process.env.PYTHON_PATH || 'python3';

  try {
    const result = await runPython(pythonBin, pythonArgs);

    // Parse JSON from last line of stdout
    const lines = result.stdout.trim().split('\n');
    const lastLine = lines[lines.length - 1];
    let output;
    try {
      output = JSON.parse(lastLine);
    } catch {
      throw new Error('Script did not return valid JSON. Output: ' + result.stdout.slice(-500));
    }

    if (!output.success) {
      throw new Error(output.error || 'Reconciliation failed');
    }

    // Get file size
    const outputPath = path.join(reportsDir, output.outputFile);
    const stat = fs.statSync(outputPath);

    // Upsert: delete existing report for same month/year
    const db = getDb();
    const periodLabel = `${y}-${String(m).padStart(2, '0')}`;

    const existing = db.prepare(
      'SELECT id, output_file FROM reconciliation_reports WHERE year = ? AND month = ?'
    ).get(y, m);

    if (existing) {
      if (existing.output_file !== output.outputFile) {
        const oldPath = path.join(reportsDir, existing.output_file);
        try { fs.unlinkSync(oldPath); } catch (_) {}
      }
      db.prepare('DELETE FROM reconciliation_reports WHERE id = ?').run(existing.id);
    }

    const info = db.prepare(`
      INSERT INTO reconciliation_reports
        (month, year, period_label, output_file, file_size, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(m, y, periodLabel, output.outputFile, stat.size, req.session?.username || 'admin');

    res.json({
      success: true,
      report: {
        id: Number(info.lastInsertRowid),
        month: m,
        year: y,
        periodLabel,
        outputFile: output.outputFile,
        fileSize: stat.size,
      }
    });
  } catch (err) {
    console.error('Reconciliation failed:', err.message);
    res.status(500).json({ error: 'Reconciliation failed: ' + err.message });
  } finally {
    cleanupDir(workDir);
  }
});

// ── GET /api/reconciliation/reports ───────────────────────────────────
router.get('/reports', (req, res) => {
  try {
    const db = getDb();
    const reports = db.prepare(
      'SELECT * FROM reconciliation_reports ORDER BY year DESC, month DESC'
    ).all();
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/reconciliation/report/:id/view ───────────────────────────
router.get('/report/:id/view', (req, res) => {
  try {
    const db = getDb();
    const report = db.prepare(
      'SELECT * FROM reconciliation_reports WHERE id = ?'
    ).get(req.params.id);

    if (!report) return res.status(404).json({ error: 'Report not found' });

    const filePath = path.join(reportsDir, report.output_file);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Report file not found on disk' });
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/reconciliation/report/:id ─────────────────────────────
router.delete('/report/:id', (req, res) => {
  try {
    const db = getDb();
    const report = db.prepare(
      'SELECT id, output_file FROM reconciliation_reports WHERE id = ?'
    ).get(req.params.id);

    if (!report) return res.status(404).json({ error: 'Report not found' });

    const filePath = path.join(reportsDir, report.output_file);
    try { fs.unlinkSync(filePath); } catch (_) {}

    db.prepare('DELETE FROM reconciliation_reports WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────

function runPython(pythonBin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonBin, args, {
      timeout: 5 * 60 * 1000,
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', code => {
      if (code !== 0) {
        reject(new Error(`Python exited with code ${code}. stderr: ${stderr.slice(-1000)}`));
      } else {
        resolve({ stdout, stderr });
      }
    });

    proc.on('error', err => {
      reject(new Error(`Failed to spawn Python: ${err.message}`));
    });
  });
}

function cleanupFiles(files) {
  if (!files) return;
  for (const field of Object.values(files)) {
    for (const f of field) {
      try { fs.unlinkSync(f.path); } catch (_) {}
    }
  }
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

module.exports = router;
