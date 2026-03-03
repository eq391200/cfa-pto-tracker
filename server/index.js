/**
 * La Rambla — Restaurant Admin Hub
 * Express application entry point.
 *
 * Stack: Express + better-sqlite3 + express-session (SQLite store)
 * Deployed behind Nginx (SSL termination) on DigitalOcean.
 */

// ── Environment & Dependencies ──────────────────────────────────────
require('./utils/loadEnv');

const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');
const { initDb } = require('./db');
const { SESSION_MAX_AGE_MS, DEFAULT_PORT } = require('./utils/constants');

const app = express();
const PORT = process.env.PORT || DEFAULT_PORT;

// ── Reverse Proxy & Database ────────────────────────────────────────
// Nginx terminates SSL and proxies to localhost:3000.
// trust proxy is required so Express sees the real client IP and
// honours `secure: true` cookies behind the proxy.
app.set('trust proxy', 1);
initDb();

// ── Body Parsing ────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Session Management ──────────────────────────────────────────────
app.use(session({
  store: new SQLiteStore({
    dir: path.join(__dirname, '..', 'data'),
    db: 'sessions.db'
  }),
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
  if (req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.redirect('/login.html');
}

/** Require admin role. Returns 403 for non-admins. */
function requireAdmin(req, res, next) {
  if (req.session?.role === 'admin') return next();
  res.status(403).json({ error: 'Admin access required' });
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

// ── API Routes ──────────────────────────────────────────────────────
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/employees',     requireAuth, requireAdmin, require('./routes/employees'));
app.use('/api/import',        requireAuth, requireAdmin, require('./routes/imports'));
app.use('/api/accruals',      requireAuth, require('./routes/accruals'));
app.use('/api/dashboard',     requireAuth, requireAdmin, require('./routes/dashboard'));
app.use('/api/requests',      requireAuth, require('./routes/requests'));
app.use('/api/reports',       requireAuth, requireAdmin, require('./routes/reports'));
app.use('/api/notifications', requireAuth, requireAdmin, require('./routes/notifications'));
app.use('/api/tardiness',     requireAuth, requireAdmin, require('./routes/tardiness'));
app.use('/api/meal-penalty',  requireAuth, requireAdmin, require('./routes/mealPenalty'));
app.use('/api/reconciliation', requireAuth, requireAdmin, require('./routes/reconciliation'));

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
app.listen(PORT, () => {
  console.log(`Restaurant Admin Hub running at http://localhost:${PORT}`);
});
