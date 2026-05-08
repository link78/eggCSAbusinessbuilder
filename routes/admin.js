const express = require('express');
const db      = require('../db');

const router = express.Router();

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

  const { display_name, price_monthly, eggs_per_week, delivery_fee_enabled } = req.body || {};

  if (display_name !== undefined && (!display_name || !String(display_name).trim())) {
    return res.status(400).json({ error: 'display_name cannot be empty.' });
  }
  if (price_monthly !== undefined && (isNaN(Number(price_monthly)) || Number(price_monthly) < 0)) {
    return res.status(400).json({ error: 'price_monthly must be a non-negative number.' });
  }
  if (eggs_per_week !== undefined && (isNaN(Number(eggs_per_week)) || Number(eggs_per_week) < 0)) {
    return res.status(400).json({ error: 'eggs_per_week must be a non-negative number.' });
  }

  const newName     = display_name          !== undefined ? String(display_name).trim()  : plan.display_name;
  const newPrice    = price_monthly         !== undefined ? Number(price_monthly)         : plan.price_monthly;
  const newEggs     = eggs_per_week         !== undefined ? Number(eggs_per_week)         : plan.eggs_per_week;
  const newDelivery = delivery_fee_enabled  !== undefined ? Boolean(delivery_fee_enabled) : plan.delivery_fee_enabled;

  await db.query(
    'UPDATE plan_config SET display_name = $1, price_monthly = $2, eggs_per_week = $3, delivery_fee_enabled = $4 WHERE id = $5',
    [newName, newPrice, newEggs, newDelivery, plan.id]
  );

  const updated = (await db.query('SELECT * FROM plan_config WHERE id = $1', [plan.id])).rows[0];
  res.json({ plan: updated });
});

// ── Farm Updates ──────────────────────────────────────────────────────────────

// POST /api/admin/farm-updates — add a new farm update
router.post('/farm-updates', requireAdmin, async (req, res) => {
  const { body, date_label, author, photo_caption, photo_url } = req.body || {};
  if (!body || !String(body).trim()) {
    return res.status(400).json({ error: 'body is required.' });
  }
  const now = new Date();
  const label = date_label
    ? String(date_label).trim()
    : now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const authorStr = author ? String(author).trim() : 'Sakinah Ridge Farm';
  const caption   = photo_caption ? String(photo_caption).trim() : null;
  const imgUrl    = photo_url    ? String(photo_url).trim()    : null;

  const row = (await db.query(
    'INSERT INTO farm_updates (author, date_label, body, photo_caption, photo_url) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [authorStr, label, String(body).trim(), caption, imgUrl]
  )).rows[0];
  res.status(201).json({ update: row });
});

// PUT /api/admin/farm-updates/:id — edit an existing farm update
router.put('/farm-updates/:id', requireAdmin, async (req, res) => {
  const existing = (await db.query('SELECT * FROM farm_updates WHERE id = $1', [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: 'Update not found.' });

  const { body, date_label, author, photo_caption, photo_url } = req.body || {};

  const newBody    = body          !== undefined ? String(body).trim()          : existing.body;
  const newLabel   = date_label    !== undefined ? String(date_label).trim()    : existing.date_label;
  const newAuthor  = author        !== undefined ? String(author).trim()        : existing.author;
  const newCaption = photo_caption !== undefined ? (String(photo_caption).trim() || null) : existing.photo_caption;
  const newImgUrl  = photo_url     !== undefined ? (String(photo_url).trim()    || null) : existing.photo_url;

  if (!newBody) return res.status(400).json({ error: 'body cannot be empty.' });

  const row = (await db.query(
    'UPDATE farm_updates SET body = $1, date_label = $2, author = $3, photo_caption = $4, photo_url = $5 WHERE id = $6 RETURNING *',
    [newBody, newLabel, newAuthor || 'Sakinah Ridge Farm', newCaption, newImgUrl, req.params.id]
  )).rows[0];
  res.json({ update: row });
});

// DELETE /api/admin/farm-updates/:id — remove a farm update
router.delete('/farm-updates/:id', requireAdmin, async (req, res) => {
  const row = (await db.query('SELECT id FROM farm_updates WHERE id = $1', [req.params.id])).rows[0];
  if (!row) return res.status(404).json({ error: 'Update not found.' });
  await db.query('DELETE FROM farm_updates WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
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

module.exports = router;
