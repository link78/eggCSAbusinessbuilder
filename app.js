const express        = require('express');
const path           = require('path');
const session        = require('express-session');
const rateLimit      = require('express-rate-limit');
const crypto         = require('crypto');

const db             = require('./db');
const authRoutes      = require('./routes/auth');
const ordersRoutes    = require('./routes/orders');
const reviewsRoutes   = require('./routes/reviews');
const checklistRoutes = require('./routes/checklist');
const adminRoutes     = require('./routes/admin');
const planConfigRoutes = require('./routes/planConfig');
const billingRoutes    = require('./routes/billing');
const stripeService    = require('./stripe');

// Load any DB-stored Stripe keys as soon as the database is ready.
// Environment variables always take precedence; this is a fallback for keys
// configured through the admin dashboard.
db.ready.then(() => stripeService.loadFromDb()).catch(() => {});

const app        = express();
const IS_PROD    = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET;

// Trust the first proxy (Railway / Heroku / Render etc.) so that req.secure
// is correct when the app runs behind an HTTPS-terminating reverse proxy.
// Without this, express-session never sends the session cookie (secure:true
// fails the req.secure check) and every request gets a fresh empty session,
// making req.session.csrfToken always undefined → 403 on every POST.
if (IS_PROD) {
  app.set('trust proxy', 1);
}

if (!SESSION_SECRET && IS_PROD) {
  console.error('FATAL: SESSION_SECRET environment variable is required in production.');
  process.exit(1);
} else if (!SESSION_SECRET && process.env.NODE_ENV !== 'test') {
  console.warn('WARNING: SESSION_SECRET not set. Using an insecure default. Set SESSION_SECRET before deploying to production.');
}

// ── Rate Limiters ────────────────────────────────────────────────────────────

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

// ── Middleware ───────────────────────────────────────────────────────────────

app.post('/webhook', express.raw({ type: 'application/json' }), billingRoutes.webhookHandler);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(session({
  secret:            SESSION_SECRET || 'egg-csa-lincoln-dev-only-secret',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure:   IS_PROD,
    maxAge:   7 * 24 * 60 * 60 * 1000  // 7 days
  }
}));

// ── CSRF Token ───────────────────────────────────────────────────────────────

// GET /api/csrf-token — issue a per-session CSRF token
app.get('/api/csrf-token', (req, res) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.json({ csrfToken: req.session.csrfToken });
});

// Middleware to validate CSRF token on all state-changing API requests
app.use('/api', (req, res, next) => {
  const safe = ['GET', 'HEAD', 'OPTIONS'];
  if (safe.includes(req.method)) return next();
  // Skip CSRF check on auth/csrf-token route itself
  if (req.path === '/csrf-token') return next();
  const token = req.headers['x-csrf-token'];
  if (!token || token !== req.session.csrfToken) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token.' });
  }
  next();
});

// ── Health Check ─────────────────────────────────────────────────────────────

// Lightweight liveness probe for Railway / Railpack healthchecks.
// Returns 200 as soon as the Express app is accepting connections.
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// ── API Routes ───────────────────────────────────────────────────────────────

app.use('/api/auth',        authLimiter,  authRoutes);
app.use('/api/orders',      apiLimiter,   ordersRoutes);
app.use('/api/reviews',     apiLimiter,   reviewsRoutes);
app.use('/api/checklist',   apiLimiter,   checklistRoutes);
app.use('/api/admin',       apiLimiter,   adminRoutes);
app.use('/api/plan-config', apiLimiter,   planConfigRoutes);
app.use('/',                apiLimiter,   billingRoutes.router);

// ── Public content endpoints ──────────────────────────────────────────────────

// GET /api/farm-updates — list all farm updates, newest first
app.get('/api/farm-updates', apiLimiter, async (req, res) => {
  const userId = req.session.userId || null;
  const rows = (await db.query(`
    SELECT fu.*,
           COALESCE(l.likes_count, 0)::int AS likes_count,
           CASE WHEN $1::int IS NOT NULL AND ml.user_id IS NOT NULL THEN true ELSE false END AS liked
    FROM farm_updates fu
    LEFT JOIN (
      SELECT update_id, COUNT(*) AS likes_count
      FROM farm_update_likes
      GROUP BY update_id
    ) l ON l.update_id = fu.id
    LEFT JOIN farm_update_likes ml
      ON ml.update_id = fu.id AND ml.user_id = $1
    ORDER BY fu.created_at DESC
  `, [userId])).rows;
  res.json({ updates: rows });
});

// POST /api/farm-updates/:id/like — toggle a thumbs-up on an update
app.post('/api/farm-updates/:id/like', apiLimiter, async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'You must be logged in to like an update.' });
  }
  const updateId = parseInt(req.params.id, 10);
  if (!Number.isInteger(updateId) || updateId <= 0) {
    return res.status(400).json({ error: 'Invalid update id.' });
  }

  const exists = (await db.query('SELECT id FROM farm_updates WHERE id = $1', [updateId])).rows[0];
  if (!exists) return res.status(404).json({ error: 'Update not found.' });

  const existing = (await db.query(
    'SELECT 1 FROM farm_update_likes WHERE update_id = $1 AND user_id = $2',
    [updateId, req.session.userId]
  )).rows[0];

  let liked;
  if (existing) {
    await db.query(
      'DELETE FROM farm_update_likes WHERE update_id = $1 AND user_id = $2',
      [updateId, req.session.userId]
    );
    liked = false;
  } else {
    await db.query(
      `INSERT INTO farm_update_likes (update_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [updateId, req.session.userId]
    );
    liked = true;
  }

  const countRow = (await db.query(
    'SELECT COUNT(*)::int AS likes_count FROM farm_update_likes WHERE update_id = $1',
    [updateId]
  )).rows[0];

  res.json({ liked, likes_count: countRow.likes_count });
});

// GET /api/about-content — list all about-page sections
app.get('/api/about-content', apiLimiter, async (req, res) => {
  const rows = (await db.query('SELECT * FROM about_content ORDER BY id ASC')).rows;
  const sections = {};
  for (const row of rows) {
    try { sections[row.section_key] = JSON.parse(row.content_json); }
    catch (_) { sections[row.section_key] = {}; }
  }
  res.json({ sections });
});

// ── Static Files ─────────────────────────────────────────────────────────────

// Serve uploaded user files (e.g. farm-update images) from /uploads/*
app.use('/uploads', apiLimiter, express.static(path.join(__dirname, 'uploads'), {
  index: false,
  dotfiles: 'ignore'
}));

app.use(apiLimiter, express.static(path.join(__dirname)));

// Farm dashboard — served to all; client-side auth gate handles login/access control
app.get('/dashboard', apiLimiter, (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Catch-all: serve index.html (landing page) for any unmatched route
app.get('*', apiLimiter, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

module.exports = app;
