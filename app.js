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
const messagesRoutes   = require('./routes/messages');
const referralsRoutes  = require('./routes/referrals');
const addonsRoutes     = require('./routes/addons');
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
  windowMs: 60 * 1000,  // 1 minute
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  // Disable in tests so the high register/login volume across test files
  // doesn't trigger 429 responses and cascade into unrelated 401 failures.
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many requests, please try again later.' }
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 100,
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
app.use('/api/messages',    apiLimiter,   messagesRoutes);
app.use('/api/referrals',   apiLimiter,   referralsRoutes);
app.use('/api/addons',      apiLimiter,   addonsRoutes.router);
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

// GET /api/farm-updates/:id — fetch a single farm update by ID (for permalinks)
app.get('/api/farm-updates/:id', apiLimiter, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid update id.' });
  }
  const row = (await db.query(`
    SELECT fu.*, COALESCE(l.likes_count, 0)::int AS likes_count
    FROM farm_updates fu
    LEFT JOIN (
      SELECT update_id, COUNT(*) AS likes_count
      FROM farm_update_likes
      GROUP BY update_id
    ) l ON l.update_id = fu.id
    WHERE fu.id = $1
  `, [id])).rows[0];
  if (!row) return res.status(404).json({ error: 'Update not found.' });
  res.json({ update: row });
});

// ── RSS feed for the Farm Journal ────────────────────────────────────────────

// Minimal XML escaper sufficient for body text inside <description>/<title>.
function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Build the absolute base URL from the incoming request so the feed works
// in dev (http://localhost:3000) and in production (https://your.domain).
function siteBaseUrl(req) {
  const proto = req.protocol;
  const host  = req.get('host');
  return `${proto}://${host}`;
}

// GET /feed.xml — RSS 2.0 feed of the most recent farm-journal posts
app.get('/feed.xml', apiLimiter, async (req, res) => {
  const rows = (await db.query(
    'SELECT id, author, date_label, body, photo_caption, photo_url, image_urls, created_at FROM farm_updates ORDER BY created_at DESC LIMIT 50'
  )).rows;

  const base = siteBaseUrl(req);
  const pubDate = (rows[0] && rows[0].created_at) ? new Date(rows[0].created_at).toUTCString() : new Date().toUTCString();

  const items = rows.map((r) => {
    const link = `${base}/journal.html#post-${r.id}`;
    const guid = `${base}/journal.html#post-${r.id}`;
    const titleText = r.date_label ? `Farm Journal — ${r.date_label}` : `Farm Journal — Update #${r.id}`;
    let desc = r.body || '';
    if (r.photo_caption) desc += `\n\n${r.photo_caption}`;
    const imgs = (r.image_urls && r.image_urls.length) ? r.image_urls : (r.photo_url ? [r.photo_url] : []);
    const enclosure = imgs[0]
      ? `\n      <enclosure url="${xmlEscape(base + imgs[0])}" type="image/jpeg" />`
      : '';
    return `    <item>
      <title>${xmlEscape(titleText)}</title>
      <link>${xmlEscape(link)}</link>
      <guid isPermaLink="true">${xmlEscape(guid)}</guid>
      <pubDate>${new Date(r.created_at).toUTCString()}</pubDate>
      <author>${xmlEscape(r.author || 'Sakinah Ridge Farm')}</author>
      <description>${xmlEscape(desc)}</description>${enclosure}
    </item>`;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Sakinah Ridge Farm — Farm Journal</title>
    <link>${xmlEscape(base + '/journal.html')}</link>
    <atom:link href="${xmlEscape(base + '/feed.xml')}" rel="self" type="application/rss+xml" />
    <description>Photos, notes, and updates from Sakinah Ridge Farm in Raymond, Nebraska.</description>
    <language>en-us</language>
    <lastBuildDate>${pubDate}</lastBuildDate>
${items}
  </channel>
</rss>
`;

  res.set('Content-Type', 'application/rss+xml; charset=utf-8');
  res.send(xml);
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

// Farm Journal — chronological blog view of farm updates with permalinks/RSS.
app.get('/journal', apiLimiter, (req, res) => {
  res.sendFile(path.join(__dirname, 'journal.html'));
});

// Catch-all: serve index.html (landing page) for any unmatched route
app.get('*', apiLimiter, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

module.exports = app;
