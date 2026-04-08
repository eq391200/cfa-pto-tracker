/**
 * Gastos (Invoice Entry Automation) Module — Server Routes
 *
 * REST API for managing supplier invoices with:
 *   - AI-powered OCR extraction via Claude Vision
 *   - Full CRUD for invoices and line items
 *   - Bookmarklet API (token-auth, CORS-enabled) for Inc. APEX integration
 *   - Analytics dashboard data
 *   - CSV export and PDF receipt compilation
 *
 * Route groups:
 *   router          → /api/gastos/*          (session-auth, admin only)
 *   bookmarkletRouter → /api/gastos-bk/*     (token-auth, CORS)
 *
 * @module routes/gastos
 */

const express = require('express');
const router = express.Router();
const bookmarkletRouter = express.Router();
const { getDb } = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Lazy-load optional deps (only needed for specific endpoints)
let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch (_) {
  console.warn('Anthropic SDK not installed — OCR upload will be unavailable');
}
const { logApiCall, checkBudget } = require('../services/apiCostTracker');

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS & CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

/** @const {string} Directory where uploaded invoice files are stored */
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'gastos');

/** @const {number} Maximum upload file size (20 MB) */
const MAX_FILE_SIZE = 20 * 1024 * 1024;

/** @const {string[]} Permitted upload file extensions */
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.pdf'];

/** @const {string[]} Valid invoice lifecycle statuses */
const VALID_STATUSES = ['draft', 'ready', 'submitted', 'verified', 'error'];

/** @const {number} Bookmarklet token TTL in milliseconds (24 hours) */
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** @const {number} Token cleanup interval in milliseconds (1 hour) */
const TOKEN_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** @const {string} Claude model used for OCR */
const OCR_MODEL = 'claude-sonnet-4-20250514';

/** @const {string[]} APEX month abbreviations for date formatting */
const APEX_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** @const {Object<string,string>} File extension → MIME type mapping */
const MEDIA_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.pdf': 'application/pdf'
};

// ═══════════════════════════════════════════════════════════════════
// UPLOAD CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomUUID() + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext)) return cb(null, true);
    cb(new Error('Only JPG, PNG, and PDF files are allowed'));
  }
});

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

/**
 * Return the MIME type for a given filename based on its extension.
 * @param {string} filename
 * @returns {string} MIME type (defaults to image/jpeg)
 */
function getMediaType(filename) {
  return MEDIA_TYPES[path.extname(filename).toLowerCase()] || 'image/jpeg';
}

/**
 * Parse and validate an integer route parameter.
 * @param {string} value - Raw param string
 * @returns {number|null} Parsed integer or null if invalid
 */
function parseIntParam(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Look up an invoice by ID. Returns the row or null.
 * @param {import('better-sqlite3').Database} db
 * @param {number} id
 * @returns {Object|null}
 */
function findInvoice(db, id) {
  return db.prepare('SELECT * FROM gastos_invoices WHERE id = ?').get(id) || null;
}

/**
 * Recalculate and persist the total_amount on an invoice from its line items.
 * @param {import('better-sqlite3').Database} db
 * @param {number} invoiceId
 */
function recalcInvoiceTotal(db, invoiceId) {
  const { total } = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM gastos_invoice_lines WHERE invoice_id = ?"
  ).get(invoiceId);
  db.prepare(
    "UPDATE gastos_invoices SET total_amount = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(total, invoiceId);
}

/**
 * Extract the current user ID from the session (works for both admin and employee portals).
 * @param {Object} req - Express request
 * @returns {string|null}
 */
function getSessionUserId(req) {
  if (!req.session) return null;
  return req.session.employeeId || req.session.userId || null;
}

/**
 * Convert a YYYY-MM-DD date string to MM/DD/YYYY (for Oracle APEX).
 * @param {string} isoDate - e.g. "2026-04-05"
 * @returns {string} e.g. "04/05/2026" or original if format doesn't match
 */
function isoToApexDate(isoDate) {
  if (!isoDate) return '';
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : isoDate;
}

/**
 * Convert a YYYY-MM business period to APEX format (01-MON-YY).
 * @param {string} period - e.g. "2026-04"
 * @returns {string} e.g. "01-APR-26" or empty string if format doesn't match
 */
function periodToApexMonth(period) {
  if (!period) return '';
  const m = period.match(/^(\d{4})-(\d{2})$/);
  if (!m) return '';
  const monthIdx = parseInt(m[2], 10) - 1;
  return `01-${APEX_MONTHS[monthIdx]}-${m[1].substring(2)}`;
}

// ── Bookmarklet Token Management ────────────────────────────────

/** @type {Map<string, {userId: string, createdAt: number}>} In-memory token store */
const bookmarkletTokens = new Map();

/**
 * Periodically purge expired tokens to prevent memory leaks.
 * Runs every TOKEN_CLEANUP_INTERVAL_MS.
 */
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of bookmarkletTokens) {
    if (now - entry.createdAt > TOKEN_TTL_MS) {
      bookmarkletTokens.delete(token);
    }
  }
}, TOKEN_CLEANUP_INTERVAL_MS);

/**
 * Validate the Bearer token from the Authorization header.
 * @param {Object} req - Express request
 * @returns {boolean} true if token is valid and not expired
 */
function validateBookmarkletToken(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token || !bookmarkletTokens.has(token)) return false;

  const entry = bookmarkletTokens.get(token);
  if (Date.now() - entry.createdAt > TOKEN_TTL_MS) {
    bookmarkletTokens.delete(token);
    return false;
  }
  return true;
}

/**
 * Set CORS headers for cross-origin bookmarklet requests.
 * @param {Object} res - Express response
 */
/** Allowed origins for bookmarklet CORS — restrict to known domains */
const BOOKMARKLET_ORIGINS = [
  'https://www.cfahome.com',
  'https://cfahome.com',
  'https://apex.cfahome.com'
];

function setCorsHeaders(res, req) {
  const origin = req && req.headers.origin;
  if (origin && BOOKMARKLET_ORIGINS.some(o => origin.startsWith(o))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    // Fallback for development or unknown origins
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ═══════════════════════════════════════════════════════════════════
// MIDDLEWARE: Bookmarklet token generation (session-auth route)
// ═══════════════════════════════════════════════════════════════════

/**
 * POST /bookmarklet-token
 * Generate a 24-hour Bearer token for bookmarklet use.
 * Requires session auth (called from the admin hub).
 */
router.post('/bookmarklet-token', (req, res) => {
  try {
    const token = crypto.randomBytes(32).toString('hex');
    bookmarkletTokens.set(token, {
      userId: getSessionUserId(req),
      createdAt: Date.now()
    });
    res.json({ token });
  } catch (err) {
    console.error('POST /bookmarklet-token error:', err);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// REFERENCE DATA
// ═══════════════════════════════════════════════════════════════════

/** GET /suppliers — list all active suppliers */
router.get('/suppliers', (_req, res) => {
  try {
    const db = getDb();
    const suppliers = db.prepare(
      'SELECT id, name, inc_id FROM gastos_suppliers WHERE active = 1 ORDER BY name'
    ).all();
    res.json(suppliers);
  } catch (err) {
    console.error('GET /suppliers error:', err);
    res.status(500).json({ error: 'Failed to fetch suppliers' });
  }
});

/** GET /categories — list all active expense categories */
router.get('/categories', (_req, res) => {
  try {
    const db = getDb();
    const categories = db.prepare(
      'SELECT id, name, name_es, inc_id FROM gastos_expense_categories WHERE active = 1 ORDER BY name'
    ).all();
    res.json(categories);
  } catch (err) {
    console.error('GET /categories error:', err);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// INVOICE CRUD
// ═══════════════════════════════════════════════════════════════════

/**
 * GET /invoices
 * List invoices with supplier name, line count, and totals.
 * Query params: ?status=draft&month=2026-04
 * Month filter applies to payment_date (the period the expense belongs to).
 */
router.get('/invoices', (req, res) => {
  try {
    const db = getDb();
    const { status, month } = req.query;

    // ── Build filtered invoice list ──
    let sql = `
      SELECT
        i.id, i.invoice_number, i.invoice_date, i.payment_date,
        i.business_period, i.currency, i.total_amount, i.status,
        i.inc_submitted, i.inc_payment_id, i.source_file, i.notes,
        i.created_at, i.updated_at,
        s.name AS supplier_name, s.id AS supplier_id,
        COUNT(l.id) AS line_count
      FROM gastos_invoices i
      LEFT JOIN gastos_suppliers s ON i.supplier_id = s.id
      LEFT JOIN gastos_invoice_lines l ON l.invoice_id = i.id
    `;
    const conditions = [];
    const params = [];

    if (status && VALID_STATUSES.includes(status)) {
      conditions.push('i.status = ?');
      params.push(status);
    }
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      conditions.push("strftime('%Y-%m', i.payment_date) = ?");
      params.push(month);
    }
    if (conditions.length) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' GROUP BY i.id ORDER BY i.created_at DESC';

    const invoices = db.prepare(sql).all(...params);

    // ── Stats (filtered by same criteria so numbers match the table) ──
    let statsSql = `
      SELECT
        SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft,
        SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
        SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) AS submitted,
        SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS verified,
        COALESCE(SUM(total_amount), 0) AS total_amount
      FROM gastos_invoices
    `;
    const statsConds = [];
    const statsParams = [];
    if (status && VALID_STATUSES.includes(status)) {
      statsConds.push('status = ?');
      statsParams.push(status);
    }
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      statsConds.push("strftime('%Y-%m', payment_date) = ?");
      statsParams.push(month);
    }
    if (statsConds.length) {
      statsSql += ' WHERE ' + statsConds.join(' AND ');
    }

    const s = db.prepare(statsSql).get(...statsParams);

    res.json({
      invoices,
      stats: {
        draft: s.draft || 0,
        ready: s.ready || 0,
        submitted: s.submitted || 0,
        verified: s.verified || 0,
        total_amount: s.total_amount || 0
      }
    });
  } catch (err) {
    console.error('GET /invoices error:', err);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

/** GET /invoices/:id — full invoice with lines and supplier info */
router.get('/invoices/:id', (req, res) => {
  try {
    const id = parseIntParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid invoice ID' });

    const db = getDb();
    const invoice = db.prepare(`
      SELECT i.*, s.name AS supplier_name, s.inc_id AS supplier_inc_id
      FROM gastos_invoices i
      LEFT JOIN gastos_suppliers s ON i.supplier_id = s.id
      WHERE i.id = ?
    `).get(id);

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const lines = db.prepare(`
      SELECT l.*, c.name AS category_name, c.name_es AS category_name_es, c.inc_id AS category_inc_id
      FROM gastos_invoice_lines l
      LEFT JOIN gastos_expense_categories c ON l.category_id = c.id
      WHERE l.invoice_id = ?
      ORDER BY l.id
    `).all(id);

    res.json({ ...invoice, lines });
  } catch (err) {
    console.error('GET /invoices/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

/** POST /invoices — create invoice manually */
router.post('/invoices', (req, res) => {
  try {
    const db = getDb();
    const { supplier_id, invoice_number, invoice_date,
            payment_date, business_period, currency, notes } = req.body;

    if (!supplier_id || !invoice_number || !invoice_date) {
      return res.status(400).json({ error: 'supplier_id, invoice_number, and invoice_date are required' });
    }

    const result = db.prepare(`
      INSERT INTO gastos_invoices
        (supplier_id, invoice_number, invoice_date, payment_date, business_period,
         currency, total_amount, status, notes, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 'draft', ?, ?, datetime('now'), datetime('now'))
    `).run(
      supplier_id, invoice_number, invoice_date,
      payment_date || null, business_period || null,
      currency || 'USD', notes || null,
      getSessionUserId(req)
    );

    res.status(201).json({ id: result.lastInsertRowid });
  } catch (err) {
    console.error('POST /invoices error:', err);
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

/** PUT /invoices/:id — update invoice header fields */
router.put('/invoices/:id', (req, res) => {
  try {
    const id = parseIntParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid invoice ID' });

    const db = getDb();
    if (!findInvoice(db, id)) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const { supplier_id, invoice_number, invoice_date,
            payment_date, business_period, currency, notes } = req.body;

    db.prepare(`
      UPDATE gastos_invoices SET
        supplier_id     = COALESCE(?, supplier_id),
        invoice_number  = COALESCE(?, invoice_number),
        invoice_date    = COALESCE(?, invoice_date),
        payment_date    = COALESCE(?, payment_date),
        business_period = COALESCE(?, business_period),
        currency        = COALESCE(?, currency),
        notes           = COALESCE(?, notes),
        updated_at      = datetime('now')
      WHERE id = ?
    `).run(
      supplier_id || null, invoice_number || null, invoice_date || null,
      payment_date || null, business_period || null, currency || null,
      notes || null, id
    );

    res.json({ success: true });
  } catch (err) {
    console.error('PUT /invoices/:id error:', err);
    res.status(500).json({ error: 'Failed to update invoice' });
  }
});

/** DELETE /invoices/:id — delete invoice and cascade lines + logs */
router.delete('/invoices/:id', (req, res) => {
  try {
    const id = parseIntParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid invoice ID' });

    const db = getDb();
    if (!findInvoice(db, id)) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    db.transaction(() => {
      db.prepare('DELETE FROM gastos_invoice_lines WHERE invoice_id = ?').run(id);
      db.prepare('DELETE FROM gastos_submission_log WHERE invoice_id = ?').run(id);
      db.prepare('DELETE FROM gastos_invoices WHERE id = ?').run(id);
    })();

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /invoices/:id error:', err);
    res.status(500).json({ error: 'Failed to delete invoice' });
  }
});

/** PUT /invoices/:id/status — update invoice lifecycle status */
router.put('/invoices/:id/status', (req, res) => {
  try {
    const id = parseIntParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid invoice ID' });

    const { status } = req.body;
    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    const db = getDb();
    if (!findInvoice(db, id)) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    db.prepare("UPDATE gastos_invoices SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, id);

    res.json({ success: true });
  } catch (err) {
    console.error('PUT /invoices/:id/status error:', err);
    res.status(500).json({ error: 'Failed to update invoice status' });
  }
});

/** PUT /invoices/:id/payment-id — set or update the Inc. Payment ID */
router.put('/invoices/:id/payment-id', (req, res) => {
  try {
    const id = parseIntParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid invoice ID' });

    const { payment_id } = req.body;
    if (!payment_id || !String(payment_id).trim()) {
      return res.status(400).json({ error: 'payment_id is required' });
    }

    const db = getDb();
    if (!findInvoice(db, id)) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    db.prepare("UPDATE gastos_invoices SET inc_payment_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(String(payment_id).trim(), id);

    res.json({ success: true });
  } catch (err) {
    console.error('PUT /invoices/:id/payment-id error:', err);
    res.status(500).json({ error: 'Failed to update payment ID' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// INVOICE LINES
// ═══════════════════════════════════════════════════════════════════

/** POST /invoices/:id/lines — add a line item */
router.post('/invoices/:id/lines', (req, res) => {
  try {
    const invoiceId = parseIntParam(req.params.id);
    if (!invoiceId) return res.status(400).json({ error: 'Invalid invoice ID' });

    const { category_id, description, amount } = req.body;
    if (!description || amount == null) {
      return res.status(400).json({ error: 'description and amount are required' });
    }

    const db = getDb();
    if (!findInvoice(db, invoiceId)) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const result = db.prepare(`
      INSERT INTO gastos_invoice_lines (invoice_id, category_id, description, amount, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(invoiceId, category_id || null, description, parseFloat(amount) || 0);

    recalcInvoiceTotal(db, invoiceId);
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (err) {
    console.error('POST /invoices/:id/lines error:', err);
    res.status(500).json({ error: 'Failed to add line item' });
  }
});

/** PUT /lines/:lineId — update a line item */
router.put('/lines/:lineId', (req, res) => {
  try {
    const lineId = parseIntParam(req.params.lineId);
    if (!lineId) return res.status(400).json({ error: 'Invalid line ID' });

    const db = getDb();
    const line = db.prepare('SELECT id, invoice_id FROM gastos_invoice_lines WHERE id = ?').get(lineId);
    if (!line) return res.status(404).json({ error: 'Line item not found' });

    const { category_id, description, amount } = req.body;
    db.prepare(`
      UPDATE gastos_invoice_lines SET
        category_id = COALESCE(?, category_id),
        description = COALESCE(?, description),
        amount      = COALESCE(?, amount)
      WHERE id = ?
    `).run(
      category_id || null,
      description || null,
      amount != null ? parseFloat(amount) : null,
      lineId
    );

    recalcInvoiceTotal(db, line.invoice_id);
    res.json({ success: true });
  } catch (err) {
    console.error('PUT /lines/:lineId error:', err);
    res.status(500).json({ error: 'Failed to update line item' });
  }
});

/** DELETE /lines/:lineId — delete a line item */
router.delete('/lines/:lineId', (req, res) => {
  try {
    const lineId = parseIntParam(req.params.lineId);
    if (!lineId) return res.status(400).json({ error: 'Invalid line ID' });

    const db = getDb();
    const line = db.prepare('SELECT id, invoice_id FROM gastos_invoice_lines WHERE id = ?').get(lineId);
    if (!line) return res.status(404).json({ error: 'Line item not found' });

    db.prepare('DELETE FROM gastos_invoice_lines WHERE id = ?').run(lineId);
    recalcInvoiceTotal(db, line.invoice_id);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /lines/:lineId error:', err);
    res.status(500).json({ error: 'Failed to delete line item' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// AI-POWERED OCR UPLOAD
// ═══════════════════════════════════════════════════════════════════

/**
 * POST /upload-invoice
 * Upload an invoice image/PDF, run Claude Vision OCR, return structured data.
 * The caller reviews and confirms before saving (see /confirm-upload).
 */
router.post('/upload-invoice', upload.single('invoice'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    if (!Anthropic) {
      return res.status(503).json({ error: 'Anthropic SDK not installed. Run: npm install @anthropic-ai/sdk' });
    }

    // Budget check before making API call
    const budgetCheck = checkBudget('anthropic');
    if (!budgetCheck.allowed) {
      return res.status(429).json({ error: 'API budget limit reached: ' + budgetCheck.reason });
    }

    const db = getDb();
    const mediaType = getMediaType(req.file.filename);

    // ── Build OCR prompt (shared across all pages) ──
    const allCategories = db.prepare(
      'SELECT name FROM gastos_expense_categories WHERE active = 1 ORDER BY name'
    ).all();
    const categoryList = allCategories.map(c => c.name).join(', ');

    const ocrPrompt = `Analyze this invoice/receipt. Extract data in JSON format.

CRITICAL RULES:
- "total" MUST be the FINAL GRAND TOTAL shown on the invoice — the last, largest total that INCLUDES all taxes, IVU, shipping, and surcharges. Never sum line items yourself; always use the printed total.
- Each invoice = ONE single JSON object. Do NOT break into multiple entries.
- "description" should be a brief summary of what the invoice is for (e.g. "Produce - bouquets and claveles", "Coffee and food for staff").
- "suggested_category" MUST be one of the exact category names from the list below. Pick the single best match.
- Amounts must be numbers, not strings. Use null for unreadable fields.
- Dates in MM/DD/YYYY format.

AVAILABLE EXPENSE CATEGORIES (pick ONE exact match):
${categoryList}

Return ONLY this JSON (no extra text):
{
  "supplier_name": "exact supplier/vendor name as shown on invoice",
  "invoice_number": "invoice number or null",
  "invoice_date": "MM/DD/YYYY",
  "currency": "USD",
  "description": "brief summary of what invoice is for",
  "suggested_category": "exact category name from the list above",
  "total": 123.45
}`;

    // ── For PDFs: split into individual pages, OCR each separately ──
    // ── For images: single OCR pass ──
    const client = new Anthropic();
    let pageImages = [];

    if (mediaType === 'application/pdf') {
      const { execFileSync } = require('child_process');
      const tmpDir = path.join(UPLOAD_DIR, 'tmp-' + Date.now());
      fs.mkdirSync(tmpDir, { recursive: true });

      try {
        // Convert each PDF page to a JPEG image (execFileSync avoids shell injection)
        execFileSync('pdftoppm', ['-jpeg', '-r', '200', req.file.path, path.join(tmpDir, 'page')], { timeout: 30000 });
        const pageFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.jpg')).sort();
        for (const pf of pageFiles) {
          const imgBuf = fs.readFileSync(path.join(tmpDir, pf));
          pageImages.push({ base64: imgBuf.toString('base64'), mediaType: 'image/jpeg' });
        }
      } finally {
        // Cleanup temp files
        try {
          const tmpFiles = fs.readdirSync(tmpDir);
          for (const f of tmpFiles) fs.unlinkSync(path.join(tmpDir, f));
          fs.rmdirSync(tmpDir);
        } catch (_) {}
      }

      if (pageImages.length === 0) {
        // Fallback: send entire PDF as document if page split failed
        const base64Data = fs.readFileSync(req.file.path).toString('base64');
        pageImages = [{ base64: base64Data, mediaType: 'application/pdf', isDocument: true }];
      }
    } else {
      // Single image file
      const base64Data = fs.readFileSync(req.file.path).toString('base64');
      pageImages = [{ base64: base64Data, mediaType }];
    }

    // ── OCR each page independently ──
    const ocrResults = [];
    for (let i = 0; i < pageImages.length; i++) {
      const page = pageImages[i];
      try {
        const contentBlock = page.isDocument
          ? { type: 'document', source: { type: 'base64', media_type: page.mediaType, data: page.base64 } }
          : { type: 'image', source: { type: 'base64', media_type: page.mediaType, data: page.base64 } };

        const message = await client.messages.create({
          model: OCR_MODEL,
          max_tokens: 2048,
          messages: [{
            role: 'user',
            content: [contentBlock, { type: 'text', text: ocrPrompt }]
          }]
        });

        // Log API usage & cost
        logApiCall({
          service: 'anthropic', endpoint: 'gastos-ocr',
          userId: req.session?.userId, username: req.session?.username,
          inputTokens: message.usage?.input_tokens || 0,
          outputTokens: message.usage?.output_tokens || 0,
          model: OCR_MODEL, status: 'success'
        });

        const responseText = message.content[0].text;
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON in response');
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.supplier_name && parsed.total) {
          ocrResults.push({ parsed, raw: responseText, page: i + 1 });
        }
      } catch (pageErr) {
        logApiCall({
          service: 'anthropic', endpoint: 'gastos-ocr',
          userId: req.session?.userId, username: req.session?.username,
          model: OCR_MODEL, status: 'error', errorMessage: pageErr.message
        });
        console.warn(`OCR page ${i + 1} failed:`, pageErr.message);
        // Skip failed pages — continue with others
      }
    }

    if (ocrResults.length === 0) {
      return res.status(422).json({
        error: 'Could not parse invoice data from image',
        source_file: req.file.filename
      });
    }

    // ── Match suppliers & categories for each result ──
    const categories = db.prepare(
      'SELECT id, name, name_es, inc_id FROM gastos_expense_categories WHERE active = 1'
    ).all();

    const results = ocrResults.map(({ parsed: inv, raw, page }) => {
      const matchedSupplier = matchSupplier(db, inv.supplier_name);
      const { matchedCategory, confidence } = matchCategory(
        db, categories, matchedSupplier, inv.suggested_category
      );

      return {
        supplier_name: inv.supplier_name,
        matched_supplier: matchedSupplier,
        invoice_number: inv.invoice_number,
        invoice_date: inv.invoice_date,
        currency: inv.currency || 'USD',
        total: inv.total,
        page,
        lines: [{
          description: inv.description || '',
          amount: inv.total || 0,
          suggested_category: inv.suggested_category || '',
          matched_category_id: matchedCategory ? matchedCategory.id : null,
          matched_category_name: matchedCategory ? matchedCategory.name : null,
          ai_confidence: confidence
        }],
        ocr_raw: raw
      };
    });

    // Return single invoice (backwards compatible) or multiple
    if (results.length === 1) {
      res.json({
        ...results[0],
        source_file: req.file.filename
      });
    } else {
      res.json({
        multiple: true,
        count: results.length,
        invoices: results,
        source_file: req.file.filename
      });
    }
  } catch (err) {
    console.error('POST /upload-invoice error:', err);
    res.status(500).json({ error: 'Failed to process invoice upload' });
  }
});

/**
 * Fuzzy-match a supplier name against the suppliers table.
 * Tries full name LIKE match first, then individual words.
 * @param {import('better-sqlite3').Database} db
 * @param {string|null} supplierName - Name from OCR
 * @returns {Object|null} Matched supplier row or null
 */
function matchSupplier(db, supplierName) {
  if (!supplierName) return null;
  const name = supplierName.trim();

  // Try full-name match
  let match = db.prepare(
    "SELECT id, name, inc_id FROM gastos_suppliers WHERE active = 1 AND name LIKE ? LIMIT 1"
  ).get(`%${name}%`);
  if (match) return match;

  // Fall back to significant-word match
  const words = name.split(/\s+/).filter(w => w.length > 2);
  for (const word of words) {
    match = db.prepare(
      "SELECT id, name, inc_id FROM gastos_suppliers WHERE active = 1 AND name LIKE ? LIMIT 1"
    ).get(`%${word}%`);
    if (match) return match;
  }
  return null;
}

/**
 * Match an expense category using supplier history (highest confidence)
 * or AI suggestion (fuzzy).
 * @param {import('better-sqlite3').Database} db
 * @param {Object[]} categories - All active categories
 * @param {Object|null} supplier - Matched supplier
 * @param {string} aiSuggestion - Category name suggested by OCR
 * @returns {{matchedCategory: Object|null, confidence: string}}
 */
function matchCategory(db, categories, supplier, aiSuggestion) {
  // Strategy 1: Use the last category this supplier was billed under
  if (supplier) {
    const lastInvoice = db.prepare(`
      SELECT l.category_id, c.name AS category_name, c.inc_id
      FROM gastos_invoice_lines l
      JOIN gastos_invoices i ON l.invoice_id = i.id
      JOIN gastos_expense_categories c ON l.category_id = c.id
      WHERE i.supplier_id = ?
      ORDER BY i.created_at DESC
      LIMIT 1
    `).get(supplier.id);

    if (lastInvoice) {
      const historyMatch = categories.find(c => c.id === lastInvoice.category_id);
      if (historyMatch) return { matchedCategory: historyMatch, confidence: 'history' };
    }
  }

  // Strategy 2: Match AI suggestion against category names
  const suggested = (aiSuggestion || '').toLowerCase().trim();
  if (!suggested) return { matchedCategory: null, confidence: 'low' };

  // Exact match
  let match = categories.find(c =>
    c.name.toLowerCase() === suggested ||
    (c.name_es && c.name_es.toLowerCase() === suggested)
  );
  if (match) return { matchedCategory: match, confidence: 'high' };

  // Substring/keyword match
  match = categories.find(c =>
    suggested.includes(c.name.toLowerCase()) ||
    c.name.toLowerCase().includes(suggested)
  );
  if (match) return { matchedCategory: match, confidence: 'medium' };

  return { matchedCategory: null, confidence: 'low' };
}

/**
 * POST /confirm-upload
 * Save an OCR-extracted invoice after the user has reviewed and adjusted it.
 */
router.post('/confirm-upload', (req, res) => {
  try {
    const db = getDb();
    const { supplier_id, invoice_number, invoice_date, payment_date,
            business_period, currency, lines, source_file, ocr_raw } = req.body;

    if (!invoice_number || !invoice_date || !Array.isArray(lines) || !lines.length) {
      return res.status(400).json({ error: 'invoice_number, invoice_date, and lines are required' });
    }

    const totalAmount = lines.reduce((sum, l) => sum + (parseFloat(l.amount) || 0), 0);

    const invoiceId = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO gastos_invoices
          (supplier_id, invoice_number, invoice_date, payment_date, business_period,
           currency, total_amount, status, source_file, ocr_raw, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, datetime('now'), datetime('now'))
      `).run(
        supplier_id || null, invoice_number, invoice_date,
        payment_date || null, business_period || null,
        currency || 'USD', totalAmount,
        source_file || null, ocr_raw || null,
        getSessionUserId(req) || req.session?.userId || 'system'
      );

      const id = result.lastInsertRowid;
      const insertLine = db.prepare(`
        INSERT INTO gastos_invoice_lines
          (invoice_id, category_id, description, amount, ai_suggested_category, ai_confidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `);

      for (const line of lines) {
        insertLine.run(
          id,
          line.category_id || null,
          line.description || '',
          parseFloat(line.amount) || 0,
          line.ai_suggested_category || null,
          line.ai_confidence || null
        );
      }
      return id;
    })();

    res.status(201).json({ id: invoiceId });
  } catch (err) {
    console.error('POST /confirm-upload error:', err);
    res.status(500).json({ error: 'Failed to save invoice' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// BOOKMARKLET API (token-auth, CORS)
// Mounted at /api/gastos-bk without session auth middleware
// ═══════════════════════════════════════════════════════════════════

// CORS preflight handlers
bookmarkletRouter.options('/next', (_req, res) => { setCorsHeaders(res); res.sendStatus(204); });
bookmarkletRouter.options('/submitted/:id', (_req, res) => { setCorsHeaders(res); res.sendStatus(204); });

/**
 * GET /next
 * Fetch the oldest invoice with status='ready' for bookmarklet auto-fill.
 * Returns formatted data for Oracle APEX page fields.
 */
bookmarkletRouter.get('/next', (req, res) => {
  setCorsHeaders(res);
  if (!validateBookmarkletToken(req)) {
    return res.status(401).json({ error: 'Invalid or expired token. Generate a new bookmarklet from the Gastos tab.' });
  }

  try {
    const db = getDb();
    const invoice = db.prepare(`
      SELECT
        i.id AS invoice_id, i.invoice_number, i.invoice_date,
        i.business_period, i.currency,
        s.name AS supplier_name, s.inc_id AS supplier_inc_id
      FROM gastos_invoices i
      JOIN gastos_suppliers s ON i.supplier_id = s.id
      WHERE i.status = 'ready'
      ORDER BY i.created_at ASC
      LIMIT 1
    `).get();

    if (!invoice) {
      return res.json({ error: 'No invoices ready for submission. Mark an invoice as "Ready" first.' });
    }

    const lines = db.prepare(`
      SELECT c.inc_id AS category_inc_id, c.name AS category_name, l.description, l.amount
      FROM gastos_invoice_lines l
      LEFT JOIN gastos_expense_categories c ON l.category_id = c.id
      WHERE l.invoice_id = ?
      ORDER BY l.id
    `).all(invoice.invoice_id);

    res.json({
      invoice_id: invoice.invoice_id,
      supplier_name: invoice.supplier_name,
      supplier_inc_id: invoice.supplier_inc_id,
      invoice_number: invoice.invoice_number,
      invoice_date: isoToApexDate(invoice.invoice_date),
      payment_month: periodToApexMonth(invoice.business_period),
      currency: invoice.currency,
      lines
    });
  } catch (err) {
    console.error('GET /bookmarklet/next error:', err);
    res.status(500).json({ error: 'Failed to fetch next invoice' });
  }
});

/**
 * PUT /submitted/:id
 * Mark an invoice as submitted to Inc., optionally storing the Payment ID.
 * Called by the bookmarklet after APEX form submission.
 */
bookmarkletRouter.put('/submitted/:id', express.json(), (req, res) => {
  setCorsHeaders(res);
  if (!validateBookmarkletToken(req)) {
    return res.status(401).json({ error: 'Invalid or expired token. Generate a new bookmarklet from the Gastos tab.' });
  }

  try {
    const id = parseIntParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid invoice ID' });

    const db = getDb();
    if (!findInvoice(db, id)) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const paymentId = req.body?.payment_id ? String(req.body.payment_id).trim() : null;

    db.transaction(() => {
      db.prepare(`
        UPDATE gastos_invoices
        SET status = 'submitted', inc_submitted = 1, inc_submitted_at = datetime('now'),
            inc_payment_id = COALESCE(?, inc_payment_id),
            updated_at = datetime('now')
        WHERE id = ?
      `).run(paymentId, id);

      const details = paymentId
        ? `Submitted via bookmarklet — Payment ID: ${paymentId}`
        : 'Marked as submitted via bookmarklet';
      db.prepare(
        "INSERT INTO gastos_submission_log (invoice_id, action, details, created_at) VALUES (?, 'submitted', ?, datetime('now'))"
      ).run(id, details);
    })();

    res.json({ success: true });
  } catch (err) {
    console.error('PUT /bookmarklet/submitted/:id error:', err);
    res.status(500).json({ error: 'Failed to mark invoice as submitted' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════════════════════════════════

/** GET /analytics — dashboard summary data */
router.get('/analytics', (_req, res) => {
  try {
    const db = getDb();

    const byStatus = db.prepare(`
      SELECT status, COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS total_amount
      FROM gastos_invoices GROUP BY status
    `).all();

    const byMonth = db.prepare(`
      SELECT strftime('%Y-%m', payment_date) AS month,
             COUNT(*) AS invoice_count,
             COALESCE(SUM(total_amount), 0) AS total_amount
      FROM gastos_invoices
      WHERE payment_date IS NOT NULL
      GROUP BY strftime('%Y-%m', payment_date)
      ORDER BY month DESC LIMIT 12
    `).all();

    const topSuppliers = db.prepare(`
      SELECT s.name AS supplier_name, COUNT(i.id) AS invoice_count,
             COALESCE(SUM(i.total_amount), 0) AS total_amount
      FROM gastos_invoices i
      JOIN gastos_suppliers s ON i.supplier_id = s.id
      GROUP BY i.supplier_id ORDER BY total_amount DESC LIMIT 10
    `).all();

    const recentActivity = db.prepare(`
      SELECT i.id, i.invoice_number, i.status, i.total_amount, i.updated_at,
             s.name AS supplier_name
      FROM gastos_invoices i
      LEFT JOIN gastos_suppliers s ON i.supplier_id = s.id
      ORDER BY i.updated_at DESC LIMIT 20
    `).all();

    res.json({ byStatus, byMonth, topSuppliers, recentActivity });
  } catch (err) {
    console.error('GET /analytics error:', err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════════

/** GET /export — download all invoices as CSV */
router.get('/export', (_req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT i.invoice_number, i.invoice_date, i.payment_date, i.business_period,
             i.currency, i.total_amount, i.status, i.inc_payment_id,
             s.name AS supplier_name,
             l.description AS line_description, l.amount AS line_amount,
             c.name AS category_name
      FROM gastos_invoices i
      LEFT JOIN gastos_suppliers s ON i.supplier_id = s.id
      LEFT JOIN gastos_invoice_lines l ON l.invoice_id = i.id
      LEFT JOIN gastos_expense_categories c ON l.category_id = c.id
      ORDER BY i.invoice_date DESC, i.id, l.id
    `).all();

    const headers = [
      'Invoice Number', 'Invoice Date', 'Payment Date', 'Business Period',
      'Currency', 'Invoice Total', 'Status', 'Payment ID', 'Supplier',
      'Line Description', 'Line Amount', 'Category'
    ];

    const escapeCsv = (val) => {
      if (val == null) return '';
      const str = String(val);
      return (str.includes(',') || str.includes('"') || str.includes('\n'))
        ? '"' + str.replace(/"/g, '""') + '"'
        : str;
    };

    let csv = headers.map(escapeCsv).join(',') + '\n';
    for (const row of rows) {
      csv += [
        row.invoice_number, row.invoice_date, row.payment_date, row.business_period,
        row.currency, row.total_amount, row.status, row.inc_payment_id,
        row.supplier_name, row.line_description, row.line_amount, row.category_name
      ].map(escapeCsv).join(',') + '\n';
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="gastos-export.csv"');
    res.send(csv);
  } catch (err) {
    console.error('GET /export error:', err);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

/**
 * GET /export-receipts
 * Compile all receipt files (filtered by status/month) into a single PDF.
 * Stamps the Payment ID on each receipt page when available.
 */
router.get('/export-receipts', async (req, res) => {
  try {
    const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
    const db = getDb();
    const { status, month } = req.query;

    // ── Build filtered query ──
    let sql = 'SELECT id, invoice_number, source_file, inc_payment_id FROM gastos_invoices WHERE source_file IS NOT NULL';
    const params = [];

    if (status && VALID_STATUSES.includes(status)) {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      sql += " AND strftime('%Y-%m', payment_date) = ?";
      params.push(month);
    }
    sql += ' ORDER BY created_at ASC';

    const invoices = db.prepare(sql).all(...params);
    if (!invoices.length) {
      return res.status(404).json({ error: 'No invoices with receipts found for the selected filters.' });
    }

    // ── Create merged PDF ──
    const mergedPdf = await PDFDocument.create();
    const font = await mergedPdf.embedFont(StandardFonts.HelveticaBold);

    /**
     * Draw a "Payment ID: XXX" label in the bottom-right corner of a PDF page.
     * @param {Object} page - pdf-lib page object
     * @param {string|null} paymentId
     */
    function stampPaymentId(page, paymentId) {
      if (!paymentId) return;
      const label = 'Payment ID: ' + paymentId;
      const fontSize = 11;
      const padding = 6;
      const textWidth = font.widthOfTextAtSize(label, fontSize);
      const boxW = textWidth + padding * 2;
      const boxH = fontSize + padding * 2;
      const { width: pageW } = page.getSize();
      const boxX = pageW - boxW - 12;
      const boxY = 12;

      page.drawRectangle({
        x: boxX, y: boxY, width: boxW, height: boxH,
        color: rgb(1, 1, 1), opacity: 0.85,
        borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 0.5
      });
      page.drawText(label, {
        x: boxX + padding, y: boxY + padding,
        size: fontSize, font, color: rgb(0.1, 0.1, 0.1)
      });
    }

    /**
     * Embed an image (jpg/png) centered on a new page, scaled to fit with margin.
     * @param {Buffer} fileData - Raw image bytes
     * @param {string} ext - File extension (.jpg, .jpeg, .png)
     * @param {string|null} paymentId
     */
    async function embedImagePage(fileData, ext, paymentId) {
      const image = (ext === '.png')
        ? await mergedPdf.embedPng(fileData)
        : await mergedPdf.embedJpg(fileData);

      const page = mergedPdf.addPage();
      const { width: pageW, height: pageH } = page.getSize();
      const margin = 40;
      const scale = Math.min((pageW - margin) / image.width, (pageH - margin) / image.height, 1);
      const imgW = image.width * scale;
      const imgH = image.height * scale;

      page.drawImage(image, {
        x: (pageW - imgW) / 2,
        y: (pageH - imgH) / 2,
        width: imgW,
        height: imgH
      });
      stampPaymentId(page, paymentId);
    }

    // ── Process each invoice's receipt file ──
    for (const inv of invoices) {
      const filePath = path.join(UPLOAD_DIR, inv.source_file);
      if (!fs.existsSync(filePath)) continue;

      const fileData = fs.readFileSync(filePath);
      const ext = path.extname(inv.source_file).toLowerCase();

      try {
        if (ext === '.pdf') {
          const srcPdf = await PDFDocument.load(fileData);
          const pages = await mergedPdf.copyPages(srcPdf, srcPdf.getPageIndices());
          for (const page of pages) {
            const addedPage = mergedPdf.addPage(page);
            stampPaymentId(addedPage, inv.inc_payment_id);
          }
        } else if (['.jpg', '.jpeg', '.png'].includes(ext)) {
          await embedImagePage(fileData, ext, inv.inc_payment_id);
        }
      } catch (fileErr) {
        console.error(`Error processing receipt ${inv.source_file}:`, fileErr.message);
        // Skip unreadable files rather than failing the entire export
      }
    }

    const pdfBytes = await mergedPdf.save();
    const filename = 'receipts' + (month ? '-' + month : '') + (status ? '-' + status : '') + '.pdf';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error('GET /export-receipts error:', err);
    res.status(500).json({ error: 'Failed to export receipts' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// MODULE EXPORTS
// ═══════════════════════════════════════════════════════════════════

module.exports = { router, bookmarkletRouter };
