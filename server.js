const express        = require('express');
const path           = require('path');
const session        = require('express-session');
const rateLimit      = require('express-rate-limit');
const crypto         = require('crypto');

const authRoutes      = require('./routes/auth');
const ordersRoutes    = require('./routes/orders');
const reviewsRoutes   = require('./routes/reviews');
const checklistRoutes = require('./routes/checklist');

const app        = express();
const PORT       = process.env.PORT || 3000;
const IS_PROD    = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!SESSION_SECRET && IS_PROD) {
  console.error('FATAL: SESSION_SECRET environment variable is required in production.');
  process.exit(1);
} else if (!SESSION_SECRET) {
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

// ── API Routes ───────────────────────────────────────────────────────────────

app.use('/api/auth',      authLimiter,  authRoutes);
app.use('/api/orders',    apiLimiter,   ordersRoutes);
app.use('/api/reviews',   apiLimiter,   reviewsRoutes);
app.use('/api/checklist', apiLimiter,   checklistRoutes);

// ── Static Files ─────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname)));

// Catch-all: serve index.html for any unmatched route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🥚 Egg CSA Business Builder running at http://localhost:${PORT}`);
});
