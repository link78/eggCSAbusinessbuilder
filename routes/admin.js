const express = require('express');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const multer  = require('multer');
const db      = require('../db');
const stripeService = require('../stripe');

const router = express.Router();

// ── Image upload (farm updates) ──────────────────────────────────────────────
// Files are stored under /uploads/updates and exposed via the /uploads static
// route configured in app.js. Random filenames prevent path traversal and
// guessable URLs.
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'updates');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_IMAGE_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp'
]);
const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png':  '.png',
  'image/gif':  '.gif',
  'image/webp': '.webp'
};

const updateImageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const ext = EXT_BY_MIME[file.mimetype] || '.bin';
    const name = crypto.randomBytes(16).toString('hex') + ext;
    cb(null, name);
  }
});
const uploadUpdateImages = multer({
  storage: updateImageStorage,
  limits: {
    fileSize: 5 * 1024 * 1024,  // 5 MB per file
    files: 10                    // up to 10 images per update
  },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_IMAGE_MIME.has(file.mimetype)) return cb(null, true);
    cb(new Error('Only JPEG, PNG, GIF, or WEBP images are allowed.'));
  }
}).array('images', 10);

// Wrap multer so its errors come back as JSON 400s instead of HTML 500s.
function handleUpdateImageUpload(req, res, next) {
  uploadUpdateImages(req, res, (err) => {
    if (!err) return next();
    const message = (err instanceof multer.MulterError)
      ? `Upload error: ${err.message}`
      : (err.message || 'Upload error.');
    return res.status(400).json({ error: message });
  });
}

async function requireAdmin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'You must be logged in.' });
  }
  const row = (await db.query('SELECT role FROM users WHERE id = $1', [req.session.userId])).rows[0];
  if (!row || row.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

// GET /api/admin/users — list all users
router.get('/users', requireAdmin, async (req, res) => {
  const users = (await db.query(
    'SELECT id, name, email, role, created_at FROM users ORDER BY created_at ASC'
  )).rows;
  res.json({ users });
});

// GET /api/admin/users/:id — get a single user + their orders
router.get('/users/:id', requireAdmin, async (req, res) => {
  const user = (await db.query(
    'SELECT id, name, email, role, avatar_url, notes, created_at FROM users WHERE id = $1',
    [req.params.id]
  )).rows[0];
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const orders = (await db.query(
    'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
    [req.params.id]
  )).rows;

  res.json({ user, orders });
});

// PUT /api/admin/users/:id/role — set role to 'user' or 'admin'
router.put('/users/:id/role', requireAdmin, async (req, res) => {
  const { role } = req.body || {};
  if (role !== 'user' && role !== 'admin') {
    return res.status(400).json({ error: 'role must be "user" or "admin".' });
  }

  const target = (await db.query('SELECT id FROM users WHERE id = $1', [req.params.id])).rows[0];
  if (!target) return res.status(404).json({ error: 'User not found.' });

  // Prevent an admin from removing their own admin role
  if (Number(req.params.id) === req.session.userId && role !== 'admin') {
    return res.status(400).json({ error: 'You cannot remove your own admin role.' });
  }

  await db.query('UPDATE users SET role = $1 WHERE id = $2', [role, req.params.id]);
  res.json({ ok: true });
});

// PUT /api/admin/users/:id/notes — update admin notes for a customer
router.put('/users/:id/notes', requireAdmin, async (req, res) => {
  const target = (await db.query('SELECT id FROM users WHERE id = $1', [req.params.id])).rows[0];
  if (!target) return res.status(404).json({ error: 'User not found.' });

  const { notes } = req.body || {};
  const newNotes = notes !== undefined ? String(notes) : '';

  await db.query('UPDATE users SET notes = $1 WHERE id = $2', [newNotes, req.params.id]);
  res.json({ ok: true });
});

// ── Order Inventory ───────────────────────────────────────────────────────────

// GET /api/admin/orders — list all orders with subscriber name and email
router.get('/orders', requireAdmin, async (req, res) => {
  const orders = (await db.query(`
    SELECT o.*, u.name AS user_name, u.email AS user_email
    FROM orders o
    JOIN users u ON u.id = o.user_id
    ORDER BY o.created_at DESC
  `)).rows;
  res.json({ orders });
});

// PUT /api/admin/orders/:id — edit an order's plan_name and/or status
router.put('/orders/:id', requireAdmin, async (req, res) => {
  const order = (await db.query('SELECT * FROM orders WHERE id = $1', [req.params.id])).rows[0];
  if (!order) return res.status(404).json({ error: 'Order not found.' });

  const { status, plan_name } = req.body || {};

  const VALID_STATUSES = ['active', 'cancelled'];
  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'status must be "active" or "cancelled".' });
  }

  const newStatus   = status    !== undefined ? status              : order.status;
  const newPlanName = plan_name !== undefined ? plan_name.trim() : order.plan_name;

  if (!newPlanName) {
    return res.status(400).json({ error: 'plan_name cannot be empty.' });
  }

  await db.query(
    'UPDATE orders SET status = $1, plan_name = $2 WHERE id = $3',
    [newStatus, newPlanName, order.id]
  );

  const updated = (await db.query('SELECT * FROM orders WHERE id = $1', [order.id])).rows[0];
  res.json({ order: updated });
});

// DELETE /api/admin/orders/:id — cancel an order
router.delete('/orders/:id', requireAdmin, async (req, res) => {
  const order = (await db.query('SELECT * FROM orders WHERE id = $1', [req.params.id])).rows[0];
  if (!order) return res.status(404).json({ error: 'Order not found.' });

  await db.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [order.id]);
  res.json({ ok: true });
});

// ── Plan Configuration ────────────────────────────────────────────────────────

// GET /api/admin/plan-config — list all plan configurations
router.get('/plan-config', requireAdmin, async (req, res) => {
  const plans = (await db.query('SELECT * FROM plan_config ORDER BY id ASC')).rows;
  res.json({ plans });
});

// PUT /api/admin/plan-config/:id — update a plan configuration
router.put('/plan-config/:id', requireAdmin, async (req, res) => {
  const plan = (await db.query('SELECT * FROM plan_config WHERE id = $1', [req.params.id])).rows[0];
  if (!plan) return res.status(404).json({ error: 'Plan not found.' });

  const { display_name, price_monthly, eggs_per_week, delivery_fee_enabled, delivery_frequency } = req.body || {};

  if (display_name !== undefined && (!display_name || !String(display_name).trim())) {
    return res.status(400).json({ error: 'display_name cannot be empty.' });
  }
  if (price_monthly !== undefined && (isNaN(Number(price_monthly)) || Number(price_monthly) < 0)) {
    return res.status(400).json({ error: 'price_monthly must be a non-negative number.' });
  }
  if (eggs_per_week !== undefined && (isNaN(Number(eggs_per_week)) || Number(eggs_per_week) < 0)) {
    return res.status(400).json({ error: 'eggs_per_week must be a non-negative number.' });
  }
  const VALID_FREQUENCIES = new Set(['biweekly', 'weekly']);
  if (delivery_frequency !== undefined && !VALID_FREQUENCIES.has(String(delivery_frequency))) {
    return res.status(400).json({ error: 'delivery_frequency must be "biweekly" or "weekly".' });
  }

  const newName     = display_name          !== undefined ? String(display_name).trim()  : plan.display_name;
  const newPrice    = price_monthly         !== undefined ? Number(price_monthly)         : plan.price_monthly;
  const newEggs     = eggs_per_week         !== undefined ? Number(eggs_per_week)         : plan.eggs_per_week;
  const newDelivery = delivery_fee_enabled  !== undefined ? Boolean(delivery_fee_enabled) : plan.delivery_fee_enabled;
  const newFreq     = delivery_frequency    !== undefined ? String(delivery_frequency)    : (plan.delivery_frequency || 'biweekly');
  // Bi-weekly plans deliver every 2 weeks; weekly plans every 1 week.
  const weeksPer    = newFreq === 'weekly' ? 1 : 2;
  const newEggsDel  = newEggs * weeksPer;

  await db.query(
    `UPDATE plan_config
     SET display_name = $1, price_monthly = $2, eggs_per_week = $3, delivery_fee_enabled = $4,
         delivery_frequency = $5, eggs_per_delivery = $6
     WHERE id = $7`,
    [newName, newPrice, newEggs, newDelivery, newFreq, newEggsDel, plan.id]
  );

  const updated = (await db.query('SELECT * FROM plan_config WHERE id = $1', [plan.id])).rows[0];
  res.json({ plan: updated });
});

// ── Farm Updates ──────────────────────────────────────────────────────────────

// Helpers --------------------------------------------------------------------

function uploadedImageUrls(req) {
  if (!Array.isArray(req.files)) return [];
  return req.files.map(f => `/uploads/updates/${path.basename(f.filename)}`);
}

// Only delete files that live inside our uploads/updates directory and that
// match the random-filename pattern we generate. This prevents an attacker
// from supplying a crafted image_urls value to delete arbitrary files.
const SAFE_UPDATE_IMG_RE = /^\/uploads\/updates\/[a-f0-9]{32}\.(?:jpg|png|gif|webp)$/i;
function deleteUpdateImageFile(urlPath) {
  if (typeof urlPath !== 'string' || !SAFE_UPDATE_IMG_RE.test(urlPath)) return;
  const filename = path.basename(urlPath);
  const full = path.join(UPLOAD_DIR, filename);
  // Confirm the resolved path is still inside UPLOAD_DIR.
  if (path.dirname(full) !== UPLOAD_DIR) return;
  fs.unlink(full, () => { /* best-effort */ });
}

// Accept either a single string or array of strings for image_urls in the body
// (used by the PUT endpoint to allow removing existing images).
function parseImageUrlsField(value) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return [];
    // Allow JSON-encoded array (multipart form fields are strings).
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed.map(v => String(v).trim()).filter(Boolean);
      } catch (_) { /* fall through */ }
    }
    return [s];
  }
  return undefined;
}

// POST /api/admin/farm-updates — add a new farm update (supports image upload)
router.post('/farm-updates', requireAdmin, handleUpdateImageUpload, async (req, res) => {
  const { body, date_label, author, photo_caption, photo_url } = req.body || {};
  if (!body || !String(body).trim()) {
    // Clean up any uploaded files since we are rejecting the request.
    uploadedImageUrls(req).forEach(deleteUpdateImageFile);
    return res.status(400).json({ error: 'body is required.' });
  }
  const now = new Date();
  const label = date_label
    ? String(date_label).trim()
    : now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const authorStr = author ? String(author).trim() : 'Sakinah Ridge Farm';
  const caption   = photo_caption ? String(photo_caption).trim() : null;
  const imgUrl    = photo_url    ? String(photo_url).trim()    : null;
  const imageUrls = uploadedImageUrls(req);

  const row = (await db.query(
    `INSERT INTO farm_updates (author, date_label, body, photo_caption, photo_url, image_urls)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [authorStr, label, String(body).trim(), caption, imgUrl, imageUrls]
  )).rows[0];
  res.status(201).json({ update: row });
});

// PUT /api/admin/farm-updates/:id — edit an existing farm update
router.put('/farm-updates/:id', requireAdmin, handleUpdateImageUpload, async (req, res) => {
  const existing = (await db.query('SELECT * FROM farm_updates WHERE id = $1', [req.params.id])).rows[0];
  if (!existing) {
    uploadedImageUrls(req).forEach(deleteUpdateImageFile);
    return res.status(404).json({ error: 'Update not found.' });
  }

  const { body, date_label, author, photo_caption, photo_url, image_urls } = req.body || {};

  const newBody    = body          !== undefined ? String(body).trim()          : existing.body;
  const newLabel   = date_label    !== undefined ? String(date_label).trim()    : existing.date_label;
  const newAuthor  = author        !== undefined ? String(author).trim()        : existing.author;
  const newCaption = photo_caption !== undefined ? (String(photo_caption).trim() || null) : existing.photo_caption;
  const newImgUrl  = photo_url     !== undefined ? (String(photo_url).trim()    || null) : existing.photo_url;

  if (!newBody) {
    uploadedImageUrls(req).forEach(deleteUpdateImageFile);
    return res.status(400).json({ error: 'body cannot be empty.' });
  }

  // Determine the new image_urls value.
  // - If the client supplied `image_urls` we treat that as the kept set,
  //   then append any newly uploaded files.
  // - If not supplied, we keep all existing urls and append new uploads.
  const existingUrls = Array.isArray(existing.image_urls) ? existing.image_urls : [];
  const keptUrls     = parseImageUrlsField(image_urls);
  const newUploads   = uploadedImageUrls(req);

  let finalUrls;
  if (keptUrls !== undefined) {
    // Only keep urls that were originally on this row (prevents injecting
    // arbitrary paths through the form).
    const allowed = new Set(existingUrls);
    finalUrls = keptUrls.filter(u => allowed.has(u)).concat(newUploads);
    // Delete files that were removed.
    const keepSet = new Set(finalUrls);
    existingUrls.filter(u => !keepSet.has(u)).forEach(deleteUpdateImageFile);
  } else {
    finalUrls = existingUrls.concat(newUploads);
  }

  const row = (await db.query(
    `UPDATE farm_updates
     SET body = $1, date_label = $2, author = $3, photo_caption = $4, photo_url = $5, image_urls = $6
     WHERE id = $7 RETURNING *`,
    [newBody, newLabel, newAuthor || 'Sakinah Ridge Farm', newCaption, newImgUrl, finalUrls, req.params.id]
  )).rows[0];
  res.json({ update: row });
});

// DELETE /api/admin/farm-updates/:id — remove a farm update
router.delete('/farm-updates/:id', requireAdmin, async (req, res) => {
  const row = (await db.query('SELECT id, image_urls FROM farm_updates WHERE id = $1', [req.params.id])).rows[0];
  if (!row) return res.status(404).json({ error: 'Update not found.' });
  await db.query('DELETE FROM farm_updates WHERE id = $1', [req.params.id]);
  // Best-effort cleanup of associated image files.
  if (Array.isArray(row.image_urls)) {
    row.image_urls.forEach(deleteUpdateImageFile);
  }
  res.json({ ok: true });
});

// ── About-page image uploads ──────────────────────────────────────────────────
// Admins upload images for the public About page (flock chickens + story).
// Files are saved under /uploads/flock/ or /uploads/story/ and the resolved
// public URLs are returned so the caller can persist them inside the
// `about_content` JSON for the relevant section.

const ABOUT_IMAGE_KINDS = {
  flock: path.join(__dirname, '..', 'uploads', 'flock'),
  story: path.join(__dirname, '..', 'uploads', 'story'),
};
for (const dir of Object.values(ABOUT_IMAGE_KINDS)) {
  fs.mkdirSync(dir, { recursive: true });
}

const aboutImageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = ABOUT_IMAGE_KINDS[req.params.kind];
    if (!dir) return cb(new Error('Invalid image kind.'));
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = EXT_BY_MIME[file.mimetype] || '.bin';
    cb(null, crypto.randomBytes(16).toString('hex') + ext);
  }
});
const uploadAboutImages = multer({
  storage: aboutImageStorage,
  limits: {
    fileSize: 5 * 1024 * 1024,  // 5 MB per file
    files: 10                    // up to 10 images per request
  },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_IMAGE_MIME.has(file.mimetype)) return cb(null, true);
    cb(new Error('Only JPEG, PNG, GIF, or WEBP images are allowed.'));
  }
}).array('images', 10);

function handleAboutImageUpload(req, res, next) {
  if (!ABOUT_IMAGE_KINDS[req.params.kind]) {
    return res.status(400).json({ error: 'kind must be "flock" or "story".' });
  }
  uploadAboutImages(req, res, (err) => {
    if (!err) return next();
    const message = (err instanceof multer.MulterError)
      ? `Upload error: ${err.message}`
      : (err.message || 'Upload error.');
    return res.status(400).json({ error: message });
  });
}

// POST /api/admin/about-images/:kind — upload one or more images for the
// About page. `kind` must be "flock" or "story". Files are sent as the
// multipart field `images`. Returns { urls: ["/uploads/<kind>/<file>", ...] }.
router.post('/about-images/:kind', requireAdmin, handleAboutImageUpload, (req, res) => {
  const kind = req.params.kind;
  const files = Array.isArray(req.files) ? req.files : [];
  if (files.length === 0) {
    return res.status(400).json({ error: 'No images uploaded.' });
  }
  const urls = files.map(f => `/uploads/${kind}/${path.basename(f.filename)}`);
  res.status(201).json({ urls });
});

// ── About Content ─────────────────────────────────────────────────────────────

// PUT /api/admin/about-content/:section_key — save a section's content JSON
router.put('/about-content/:section_key', requireAdmin, async (req, res) => {
  const { section_key } = req.params;
  const { content } = req.body || {};
  if (content === undefined || content === null) {
    return res.status(400).json({ error: 'content is required.' });
  }
  // Validate it is a plain object
  if (typeof content !== 'object' || Array.isArray(content)) {
    return res.status(400).json({ error: 'content must be a JSON object.' });
  }

  await db.query(
    `INSERT INTO about_content (section_key, content_json, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (section_key) DO UPDATE
       SET content_json = EXCLUDED.content_json,
           updated_at   = NOW()`,
    [section_key, JSON.stringify(content)]
  );

  const row = (await db.query('SELECT * FROM about_content WHERE section_key = $1', [section_key])).rows[0];
  res.json({ section: row });
});

// ── Stripe Settings ───────────────────────────────────────────────────────────

// GET /api/admin/stripe-settings — return current Stripe key status.
// The secret key is never returned; only whether it is set.
// The publishable key is returned when it originates from the DB;
// if it is set via environment variable the UI shows it read-only.
router.get('/stripe-settings', requireAdmin, async (req, res) => {
  const rows = (await db.query(
    "SELECT key, value FROM settings WHERE key IN ('stripe_secret_key', 'stripe_publishable_key')"
  )).rows;
  const byKey = {};
  for (const row of rows) byKey[row.key] = row.value;

  const envSecretSet      = Boolean(process.env.STRIPE_SECRET_KEY);
  const envPublishableSet = Boolean(process.env.STRIPE_PUBLISHABLE_KEY);

  res.json({
    publishableKey:    envPublishableSet ? process.env.STRIPE_PUBLISHABLE_KEY : (byKey.stripe_publishable_key || null),
    secretKeySet:      envSecretSet || Boolean(byKey.stripe_secret_key),
    publishableSource: envPublishableSet ? 'env' : (byKey.stripe_publishable_key ? 'db' : null),
    secretSource:      envSecretSet      ? 'env' : (byKey.stripe_secret_key      ? 'db' : null)
  });
});

// PUT /api/admin/stripe-settings — save Stripe keys to the settings table and
// reload the in-memory Stripe client.  Only keys explicitly provided are updated.
// Sending an empty string clears a DB-stored key (env-sourced keys are unaffected).
router.put('/stripe-settings', requireAdmin, async (req, res) => {
  const { publishableKey, secretKey } = req.body || {};

  if (publishableKey !== undefined) {
    const val = String(publishableKey).trim();
    await db.query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ('stripe_publishable_key', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [val]
    );
  }

  if (secretKey !== undefined) {
    const val = String(secretKey).trim();
    await db.query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ('stripe_secret_key', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [val]
    );
  }

  await stripeService.loadFromDb();
  res.json({ ok: true });
});

// GET /api/admin/stripe-price-ids — return the configured Stripe price IDs for each plan.
// Shows both the active value and its source (env var or db).
router.get('/stripe-price-ids', requireAdmin, async (req, res) => {
  const planKeys = ['small_family', 'family', 'solo_couple', 'custom'];
  const dbRows = (await db.query(
    `SELECT key, value FROM settings WHERE key = ANY($1)`,
    [planKeys.map(k => `stripe_price_${k}`)]
  )).rows;
  const dbByKey = {};
  for (const row of dbRows) dbByKey[row.key] = row.value;

  const result = {};
  for (const planKey of planKeys) {
    const envKey = `STRIPE_PRICE_${planKey.toUpperCase()}`;
    const envVal = process.env[envKey] || null;
    const dbVal  = dbByKey[`stripe_price_${planKey}`] || null;
    result[planKey] = {
      priceId: envVal || dbVal || null,
      source:  envVal ? 'env' : (dbVal ? 'db' : null)
    };
  }
  res.json(result);
});

// PUT /api/admin/stripe-price-ids — save plan price IDs to the settings table
// and reload the in-memory Stripe service.  Only keys explicitly provided are updated.
// Send an empty string to clear a DB-stored price ID.
router.put('/stripe-price-ids', requireAdmin, async (req, res) => {
  const planKeys = ['small_family', 'family', 'solo_couple', 'custom'];
  const body = req.body || {};

  for (const planKey of planKeys) {
    if (body[planKey] !== undefined) {
      const val = String(body[planKey]).trim();
      await db.query(
        `INSERT INTO settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [`stripe_price_${planKey}`, val]
      );
    }
  }

  await stripeService.loadFromDb();
  res.json({ ok: true });
});

// ── Internal Messenger (admin side) ───────────────────────────────────────────
// All messages between admins and a particular customer form a single thread
// scoped to that customer. The admin UI lists conversations grouped by
// customer; opening one shows the full thread and lets the admin reply.

const MAX_MSG_BODY_LEN = 4000;

// GET /api/admin/messages — list one row per customer who has any messages,
// with the last message preview, last activity timestamp, and unread count
// (messages from the customer that no admin has read yet).
router.get('/messages', requireAdmin, async (req, res) => {
  const conversations = (await db.query(`
    WITH thread AS (
      SELECT
        CASE WHEN s.role = 'admin' THEN m.recipient_id ELSE m.sender_id END AS customer_id,
        m.id, m.body, m.created_at, m.sender_id, m.recipient_id, m.read_at,
        s.role AS sender_role
      FROM messages m
      JOIN users s ON s.id = m.sender_id
      JOIN users r ON r.id = m.recipient_id
      WHERE s.role = 'admin' OR r.role = 'admin'
    ),
    latest AS (
      SELECT DISTINCT ON (customer_id)
        customer_id, id, body, created_at, sender_role
      FROM thread
      ORDER BY customer_id, created_at DESC, id DESC
    ),
    unread AS (
      SELECT customer_id, COUNT(*)::int AS unread_count
      FROM thread
      WHERE sender_role <> 'admin' AND read_at IS NULL
      GROUP BY customer_id
    )
    SELECT
      u.id            AS user_id,
      u.name          AS user_name,
      u.email         AS user_email,
      u.avatar_url    AS user_avatar_url,
      l.body          AS last_body,
      l.created_at    AS last_created_at,
      l.sender_role   AS last_sender_role,
      COALESCE(un.unread_count, 0) AS unread_count
    FROM latest l
    JOIN users u ON u.id = l.customer_id
    LEFT JOIN unread un ON un.customer_id = l.customer_id
    ORDER BY l.created_at DESC
  `)).rows;
  res.json({ conversations });
});

// GET /api/admin/messages/:userId — full thread between any admin and the
// given customer. Also marks the customer's messages to admins as read.
router.get('/messages/:userId', requireAdmin, async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'Invalid user id.' });
  }
  const user = (await db.query(
    'SELECT id, name, email, avatar_url, role FROM users WHERE id = $1',
    [userId]
  )).rows[0];
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (user.role === 'admin') {
    return res.status(400).json({ error: 'Cannot open a customer thread with another admin.' });
  }

  const rows = (await db.query(
    `SELECT m.id, m.sender_id, m.recipient_id, m.body, m.read_at, m.created_at,
            s.role AS sender_role, s.name AS sender_name
       FROM messages m
       JOIN users s ON s.id = m.sender_id
       JOIN users r ON r.id = m.recipient_id
      WHERE (m.sender_id    = $1 AND r.role = 'admin')
         OR (m.recipient_id = $1 AND s.role = 'admin')
      ORDER BY m.created_at ASC, m.id ASC`,
    [userId]
  )).rows;

  // Mark all customer → admin messages in this thread as read.
  await db.query(
    `UPDATE messages
        SET read_at = NOW()
      WHERE sender_id = $1
        AND read_at IS NULL
        AND recipient_id IN (SELECT id FROM users WHERE role = 'admin')`,
    [userId]
  );

  res.json({ user, messages: rows });
});

// POST /api/admin/messages/:userId — admin sends a message to the customer.
router.post('/messages/:userId', requireAdmin, async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'Invalid user id.' });
  }
  const recipient = (await db.query(
    'SELECT id, role FROM users WHERE id = $1',
    [userId]
  )).rows[0];
  if (!recipient) return res.status(404).json({ error: 'User not found.' });
  if (recipient.role === 'admin') {
    return res.status(400).json({ error: 'Cannot send a customer message to another admin.' });
  }

  const body = req.body && typeof req.body.body === 'string' ? req.body.body.trim() : '';
  if (!body) return res.status(400).json({ error: 'Message body is required.' });
  if (body.length > MAX_MSG_BODY_LEN) {
    return res.status(400).json({ error: `Message is too long (max ${MAX_MSG_BODY_LEN} characters).` });
  }

  const row = (await db.query(
    `INSERT INTO messages (sender_id, recipient_id, body)
     VALUES ($1, $2, $3) RETURNING *`,
    [req.session.userId, userId, body]
  )).rows[0];
  res.status(201).json({ message: row });
});

// ── Delivery reminders ──────────────────────────────────────────────────────
// Admin triggers a one-shot reminder send for all active subscribers whose
// next non-skipped delivery falls on `deliveryDate` (YYYY-MM-DD). Email/SMS
// preferences and the per-user phone number are honored. Sends are recorded
// in `reminder_log` with a UNIQUE constraint so re-running the job is a
// safe no-op (already-notified users are skipped).

const schedule = require('../lib/deliverySchedule');
const notifier = require('../lib/notifier');
const { validateAddonInput } = require('./addons');

router.post('/send-reminders', requireAdmin, async (req, res) => {
  const { deliveryDate } = req.body || {};
  const parsed = schedule.parseISODate(deliveryDate);
  if (!parsed) {
    return res.status(400).json({ error: 'deliveryDate must be a YYYY-MM-DD date.' });
  }
  const iso = schedule.toISODate(parsed);

  // Fetch every active subscription and its owner's preferences.
  const orders = (await db.query(
    `SELECT o.*, u.id AS uid, u.name, u.email, u.phone_number,
            u.reminder_email_enabled, u.reminder_sms_enabled
     FROM orders o
     JOIN users  u ON u.id = o.user_id
     WHERE o.status = 'active'`
  )).rows;

  let emailsSent = 0, smsSent = 0, skipped = 0;
  for (const o of orders) {
    const nextActive = schedule.nextActiveDelivery(o);
    if (nextActive !== iso) { skipped++; continue; }

    const subject = `Your eggs arrive on ${iso}`;
    const body    = `Hi ${o.name}, this is a friendly reminder that your `
                  + `Sakinah Ridge Farm delivery is scheduled for ${iso}. `
                  + (o.fulfillment_method === 'delivery'
                       ? 'Please make sure your cooler is out by 8am.'
                       : `Pickup day: ${o.pickup_day}.`);

    if (o.reminder_email_enabled && o.email) {
      try {
        // Try to insert the log row first — UNIQUE constraint dedupes.
        await db.query(
          `INSERT INTO reminder_log (user_id, order_id, channel, delivery_date)
           VALUES ($1, $2, 'email', $3)`,
          [o.uid, o.id, iso]
        );
        await notifier.sendEmail({ to: o.email, subject, body });
        emailsSent++;
      } catch (err) {
        // 23505 = unique_violation → reminder already sent. Otherwise log and continue.
        if (err && err.code !== '23505') {
          // eslint-disable-next-line no-console
          console.warn('send-reminders email failed', err.message);
        }
      }
    }
    if (o.reminder_sms_enabled && o.phone_number) {
      try {
        await db.query(
          `INSERT INTO reminder_log (user_id, order_id, channel, delivery_date)
           VALUES ($1, $2, 'sms', $3)`,
          [o.uid, o.id, iso]
        );
        await notifier.sendSms({ to: o.phone_number, body: `${subject}. ${body}` });
        smsSent++;
      } catch (err) {
        if (err && err.code !== '23505') {
          // eslint-disable-next-line no-console
          console.warn('send-reminders sms failed', err.message);
        }
      }
    }
  }

  res.json({ deliveryDate: iso, emailsSent, smsSent, ordersChecked: orders.length, skipped });
});

// ── Add-on marketplace (admin CRUD) ─────────────────────────────────────────

// GET /api/admin/addons — list all add-ons (including inactive)
router.get('/addons', requireAdmin, async (req, res) => {
  const rows = (await db.query(
    `SELECT id, name, description, price_cents, photo_url, active, created_at
     FROM addons ORDER BY created_at DESC`
  )).rows;
  res.json({ addons: rows });
});

// POST /api/admin/addons — create a new add-on
router.post('/addons', requireAdmin, async (req, res) => {
  const v = validateAddonInput(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const { name, description, priceCents, photoUrl, active } = v.values;
  const row = (await db.query(
    `INSERT INTO addons (name, description, price_cents, photo_url, active)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [name, description || '', priceCents, photoUrl || null, active !== false]
  )).rows[0];
  res.status(201).json({ addon: row });
});

// PUT /api/admin/addons/:id — partially update an add-on
router.put('/addons/:id', requireAdmin, async (req, res) => {
  const v = validateAddonInput(req.body || {}, { partial: true });
  if (v.error) return res.status(400).json({ error: v.error });
  const existing = (await db.query('SELECT * FROM addons WHERE id = $1', [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: 'Add-on not found.' });

  const merged = {
    name:        v.values.name        !== undefined ? v.values.name        : existing.name,
    description: v.values.description !== undefined ? v.values.description : existing.description,
    priceCents:  v.values.priceCents  !== undefined ? v.values.priceCents  : existing.price_cents,
    photoUrl:    v.values.photoUrl    !== undefined ? v.values.photoUrl    : existing.photo_url,
    active:      v.values.active      !== undefined ? v.values.active      : existing.active
  };
  const row = (await db.query(
    `UPDATE addons
     SET name = $1, description = $2, price_cents = $3, photo_url = $4, active = $5
     WHERE id = $6 RETURNING *`,
    [merged.name, merged.description, merged.priceCents, merged.photoUrl, merged.active, req.params.id]
  )).rows[0];
  res.json({ addon: row });
});

// DELETE /api/admin/addons/:id — remove an add-on (cascades to order_addons)
router.delete('/addons/:id', requireAdmin, async (req, res) => {
  const result = await db.query('DELETE FROM addons WHERE id = $1', [req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Add-on not found.' });
  res.json({ ok: true });
});

module.exports = router;
