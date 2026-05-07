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
    'SELECT id, name, email, role, avatar_url, created_at FROM users WHERE id = $1',
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

module.exports = router;
