/**
 * La Rambla — Restaurant Admin Hub
 * Express application entry point.
 *
 * Stack: Express + better-sqlite3 + express-session (SQLite store)
 * Deployed behind Nginx (SSL termination) on DigitalOcean.
 *
 * Security: rate limiting on auth, body size limits, security headers,
 *           parameterized SQL, bcrypt passwords, session-based auth.
 */

// ── Environment & Dependencies ──────────────────────────────────────
require('./utils/loadEnv');

const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');
const { initDb, getDb } = require('./db');
const { SESSION_MAX_AGE_MS, DEFAULT_PORT } = require('./utils/constants');

const app = express();
const PORT = process.env.PORT || DEFAULT_PORT;

// ── Startup Validation ─────────────────────────────────────────────
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'dev-secret-change-me') {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: SESSION_SECRET must be set in production. Exiting.');
    process.exit(1);
  }
  console.warn('WARNING: SESSION_SECRET not set — using insecure fallback (dev only)');
}

// ── Process Error Handlers ─────────────────────────────────────────
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process] Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception:', err);
  process.exit(1);
});

// ── Reverse Proxy & Database ────────────────────────────────────────
app.set('trust proxy', '127.0.0.1');
initDb();

// ── Security Headers ────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'");
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// ── Body Parsing (with size limits) ─────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ── Rate Limiting (auth endpoints) ──────────────────────────────────
const loginAttempts = new Map(); // IP -> { count, resetAt }
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 15; // max attempts per window

function rateLimitAuth(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const entry = loginAttempts.get(ip);

  if (entry && entry.resetAt > now) {
    if (entry.count >= RATE_LIMIT_MAX) {
      return res.status(429).json({
        error: 'Too many login attempts. Please try again in 15 minutes.'
      });
    }
    entry.count++;
  } else {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
  }

  // Cleanup stale entries periodically
  if (loginAttempts.size > 500) {
    for (const [key, val] of loginAttempts) {
      if (val.resetAt < now) loginAttempts.delete(key);
    }
  }

  next();
}

// Periodic cleanup of rate-limit map every 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of loginAttempts) {
    if (val.resetAt < now) loginAttempts.delete(key);
  }
}, 15 * 60 * 1000).unref();

// ── Session Management ──────────────────────────────────────────────
app.use(session({
  store: new SQLiteStore({
    dir: path.join(__dirname, '..', 'data'),
    db: 'sessions.db'
  }),
  name: '__Host-adminhub',
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: SESSION_MAX_AGE_MS,
    secure: true,    // HTTPS only (via Nginx)
    httpOnly: true,  // not accessible from client JS
    sameSite: 'lax'  // CSRF protection, works on mobile redirects
  }
}));

// ── Auth Middleware ──────────────────────────────────────────────────

/** Require any authenticated session. Redirects browsers; returns 401 for API clients. */
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.path.startsWith('/api/') || req.originalUrl.startsWith('/api/') || req.headers.accept?.includes('application/json') || req.headers['content-type']?.includes('multipart/form-data')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.redirect('/login.html');
}

/** Require admin role. Returns 403 for non-admins. */
function requireAdmin(req, res, next) {
  if (req.session?.role === 'admin') return next();
  res.status(403).json({ error: 'Admin access required' });
}

/** Require admin or Director/Senior Director/Shift Leader role. Trainers get read-only (GET) access. */
function requireAdminOrDirector(req, res, next) {
  if (req.session?.role === 'admin') return next();
  if (req.session?.employeeId) {
    const { getDb } = require('./db');
    const db = getDb();
    const emp = db.prepare('SELECT role FROM employees WHERE id = ?').get(req.session.employeeId);
    if (emp && ['Director', 'Senior Director', 'Shift Leader', 'Instructor'].includes(emp.role)) return next();
    // Trainers/Instructors get read-only access (needed for AC evaluation employee dropdowns)
    if (emp && ['Trainer', 'Instructor'].includes(emp.role) && req.method === 'GET') return next();
  }
  res.status(403).json({ error: 'Director access required' });
}

/** Require admin role or employee with 'Administrator' role. For Gastos module. */
function requireAdminOrAdministrator(req, res, next) {
  if (req.session?.role === 'admin') return next();
  if (req.session?.employeeId) {
    const { getDb } = require('./db');
    const db = getDb();
    const emp = db.prepare('SELECT role FROM employees WHERE id = ?').get(req.session.employeeId);
    if (emp && emp.role === 'Administrator') return next();
  }
  res.status(403).json({ error: 'Administrator access required' });
}

// ── Public Routes (no auth required) ────────────────────────────────
const publicDir = path.join(__dirname, '..', 'public');

app.use('/login.html', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
}, express.static(path.join(publicDir, 'login.html')));

app.use('/css', express.static(path.join(publicDir, 'css'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache, must-revalidate')
}));
app.use('/js/login.js', express.static(path.join(publicDir, 'js', 'login.js')));
app.use('/img', express.static(path.join(publicDir, 'img')));
app.use('/fonts', express.static(path.join(publicDir, 'fonts')));
app.use('/uploads', requireAuth, express.static(path.join(__dirname, '..', 'uploads')));

// ── API Routes ──────────────────────────────────────────────────────
app.use('/api/auth',          rateLimitAuth, require('./routes/auth'));
app.use('/api/employees',     requireAuth, requireAdminOrDirector, require('./routes/employees'));
app.use('/api/import',        requireAuth, requireAdmin, require('./routes/imports'));
app.use('/api/accruals',      requireAuth, require('./routes/accruals'));
app.use('/api/dashboard',     requireAuth, requireAdmin, require('./routes/dashboard'));
app.use('/api/requests',      requireAuth, require('./routes/requests'));
app.use('/api/reports',       requireAuth, requireAdmin, require('./routes/reports'));
app.use('/api/notifications', requireAuth, requireAdmin, require('./routes/notifications'));
app.use('/api/tardiness',     requireAuth, requireAdmin, require('./routes/tardiness'));
app.use('/api/meal-penalty',  requireAuth, requireAdmin, require('./routes/mealPenalty'));
app.use('/api/reconciliation', requireAuth, requireAdmin, require('./routes/reconciliation'));
app.use('/api/performance-reviews', requireAuth, require('./routes/performanceReviews'));
app.use('/api/ac-evaluations',     requireAuth, require('./routes/acEvaluations'));
app.use('/api/leadership-academy', requireAuth, require('./routes/leadershipAcademy'));
// Scorecard: Directors+ only (no Shift Leaders, no Trainers). API key for automated scripts.
function requireDirectorPlus(req, res, next) {
  if (req.session?.role === 'admin') return next();
  if (req.session?.employeeId) {
    const { getDb } = require('./db');
    const db = getDb();
    const emp = db.prepare('SELECT role FROM employees WHERE id = ?').get(req.session.employeeId);
    if (emp && ['Director', 'Senior Director'].includes(emp.role)) return next();
  }
  res.status(403).json({ error: 'Director access required' });
}
function scorecardAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  const expected = process.env.SCORECARD_API_KEY;
  if (apiKey && expected && apiKey.length === expected.length) {
    try {
      if (crypto.timingSafeEqual(Buffer.from(apiKey), Buffer.from(expected))) {
        return next(); // API key valid — skip session auth
      }
    } catch (_) { /* length mismatch or encoding error */ }
  }
  requireAuth(req, res, () => requireDirectorPlus(req, res, next));
}
app.use('/api/scorecard',          scorecardAuth, require('./routes/scorecard'));
app.use('/api/social-posts',       requireAuth, requireAdminOrDirector, require('./routes/socialPosts'));
const gastosModule = require('./routes/gastos');
app.use('/api/gastos',             requireAuth, requireAdminOrAdministrator, gastosModule.router);
// Bookmarklet routes — token-based auth (no session), for cross-origin use on Inc. website
app.use('/api/gastos-bk',          gastosModule.bookmarkletRouter);
const apprModule = require('./routes/apprenticeship');
app.use('/api/apprenticeship',      requireAuth, apprModule.requireApprAccess, apprModule.router);
app.use('/api/apprenticeship/self', requireAuth, apprModule.selfRouter);

// ── Protected Static Files ──────────────────────────────────────────
// Everything not matched above requires authentication.
// HTML: no-cache; CSS/JS: short revalidation cache.
app.use(requireAuth, express.static(publicDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (filePath.endsWith('.css') || filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

// ── Global Error Handler ────────────────────────────────────────────
// Catches unhandled errors from async route handlers.
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start Server ────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`Restaurant Admin Hub running at http://localhost:${PORT}`);
});

// ── Graceful Shutdown ──────────────────────────────────────────────
function gracefulShutdown(signal) {
  console.log(`[Process] ${signal} received — shutting down gracefully`);
  server.close(() => {
    try { getDb().close(); } catch (_) {}
    console.log('[Process] Server closed. Goodbye.');
    process.exit(0);
  });
  // Force exit after 5 seconds if connections hang
  setTimeout(() => {
    console.error('[Process] Forced shutdown after timeout');
    process.exit(1);
  }, 5000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
