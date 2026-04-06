/**
 * Reconciliation routes — multi-file upload, Python execution, HTML report serving.
 *
 * Single-step flow (no preview/commit):
 *   POST /run — upload 5 files + month/year, spawn Python, return result
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
const cacheDir = path.join(__dirname, '..', '..', 'data', 'statements-cache');

for (const dir of [uploadDir, reportsDir, cacheDir]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Multer for 6 named file fields
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 20 * 1024 * 1024 }
});

const reconciliationUpload = upload.fields([
  { name: 'gastos', maxCount: 12 },
  { name: 'chase', maxCount: 1 },
  { name: 'amexPlatinum', maxCount: 1 },
  { name: 'amexDelta', maxCount: 1 },
  { name: 'banco', maxCount: 1 },
]);

// ── POST /api/reconciliation/run ──────────────────────────────────────
router.post('/run', reconciliationUpload, async (req, res) => {
  // Map uploaded files → standardized names expected by Python script
  const singleFileMap = {
    chase: 'chase.csv',
    amexPlatinum: 'amex_platinum.xlsx',
    amexDelta: 'amex_delta.xlsx',
    banco: 'banco.csv',
  };

  // GASTOS is always required
  if (!req.files.gastos || req.files.gastos.length === 0) {
    cleanupFiles(req.files);
    return res.status(400).json({ error: 'Missing required file: gastos (at least one)' });
  }

  // CC/bank files: use uploaded if present, else fall back to cached versions
  const missingNoCached = [];
  for (const field of Object.keys(singleFileMap)) {
    const hasUpload = req.files[field] && req.files[field][0];
    const cachedPath = path.join(cacheDir, singleFileMap[field]);
    if (!hasUpload && !fs.existsSync(cachedPath)) {
      missingNoCached.push(field);
    }
  }
  if (missingNoCached.length > 0) {
    cleanupFiles(req.files);
    return res.status(400).json({
      error: 'Missing required files (no cached version available): ' + missingNoCached.join(', ')
    });
  }

  // Create temp working directory
  const runId = `recon-${Date.now()}`;
  const workDir = path.join(uploadDir, runId);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    // Copy multiple GASTOS files as gastos_0.csv, gastos_1.csv, ...
    for (let i = 0; i < req.files.gastos.length; i++) {
      const src = req.files.gastos[i].path;
      const dest = path.join(workDir, `gastos_${i}.csv`);
      fs.copyFileSync(src, dest);
    }
    // Copy CC/bank files: from upload (and cache it) or from cache
    for (const [field, standardName] of Object.entries(singleFileMap)) {
      const dest = path.join(workDir, standardName);
      if (req.files[field] && req.files[field][0]) {
        const src = req.files[field][0].path;
        fs.copyFileSync(src, dest);
        // Update cache with the new file
        fs.copyFileSync(src, path.join(cacheDir, standardName));
      } else {
        // Use cached version
        fs.copyFileSync(path.join(cacheDir, standardName), dest);
      }
    }
  } catch (err) {
    cleanupFiles(req.files);
    cleanupDir(workDir);
    return res.status(500).json({ error: 'Failed to prepare files: ' + err.message });
  }

  // Clean up multer temp files (already copied)
  cleanupFiles(req.files);

  // Spawn Python — month/year auto-detected from file contents
  const pythonScript = path.join(scriptsDir, 'reconcile.py');
  const pythonArgs = [
    pythonScript,
    '--uploads-dir', workDir,
    '--output-dir', reportsDir,
    '--work-dir', workDir,
  ];

  const pythonBin = process.env.PYTHON_PATH || 'python3';

  try {
    const result = await runPython(pythonBin, pythonArgs);

    // Log Python diagnostics (stderr) for debugging
    if (result.stderr) {
      console.log('Reconciliation diagnostics:\n' + result.stderr);
    }

    // Parse JSON from last line of stdout
    const stdout = (result.stdout || '').trim();
    if (!stdout) {
      return res.status(500).json({ error: 'Reconciliation script returned no output' });
    }
    const lines = stdout.split('\n').filter(l => l.trim());
    if (!lines.length) {
      return res.status(500).json({ error: 'Reconciliation script returned empty output' });
    }
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

    // Parse auto-detected period from Python output (format: "2026-02")
    const [detectedYear, detectedMonth] = output.period.split('-').map(Number);
    const m = detectedMonth;
    const y = detectedYear;
    const periodLabel = output.period;

    // Get file size
    const outputPath = path.join(reportsDir, output.outputFile);
    const stat = fs.statSync(outputPath);

    // Upsert: delete existing report for same month/year
    const db = getDb();

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
    console.error('Reconciliation failed:', err.message, err.stack);
    res.status(500).json({ error: 'Reconciliation failed. Please try again or contact support.' });
  } finally {
    cleanupDir(workDir);
  }
});

// ── GET /api/reconciliation/cached-statements ─────────────────────────
router.get('/cached-statements', (req, res) => {
  const fileMap = {
    chase: 'chase.csv',
    amexPlatinum: 'amex_platinum.xlsx',
    amexDelta: 'amex_delta.xlsx',
    banco: 'banco.csv',
  };
  const cached = {};
  for (const [field, filename] of Object.entries(fileMap)) {
    const fp = path.join(cacheDir, filename);
    if (fs.existsSync(fp)) {
      const stat = fs.statSync(fp);
      cached[field] = {
        filename,
        size: stat.size,
        modified: stat.mtime.toISOString(),
      };
    }
  }
  res.json(cached);
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

    const filePath = path.resolve(reportsDir, path.basename(report.output_file));
    if (!filePath.startsWith(path.resolve(reportsDir))) {
      return res.status(400).json({ error: 'Invalid file path' });
    }
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Report file not found on disk' });
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.sendFile(filePath);
  } catch (err) {
    console.error('Report view error:', err);
    res.status(500).json({ error: 'Failed to load report' });
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

    const filePath = path.resolve(reportsDir, path.basename(report.output_file));
    if (filePath.startsWith(path.resolve(reportsDir))) {
      try { fs.unlinkSync(filePath); } catch (_) {}
    }

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
