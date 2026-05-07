const express = require('express');
const db      = require('../db');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'You must be logged in.' });
  }
  const row = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId);
  if (!row || row.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

// GET /api/admin/users — list all users
router.get('/users', requireAdmin, (req, res) => {
  const users = db.prepare(
    'SELECT id, name, email, role, created_at FROM users ORDER BY created_at ASC'
  ).all();
  res.json({ users });
});

// PUT /api/admin/users/:id/role — set role to 'user' or 'admin'
router.put('/users/:id/role', requireAdmin, (req, res) => {
  const { role } = req.body || {};
  if (role !== 'user' && role !== 'admin') {
    return res.status(400).json({ error: 'role must be "user" or "admin".' });
  }

  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });

  // Prevent an admin from removing their own admin role
  if (Number(req.params.id) === req.session.userId && role !== 'admin') {
    return res.status(400).json({ error: 'You cannot remove your own admin role.' });
  }

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  res.json({ ok: true });
});

// ── Order Inventory ───────────────────────────────────────────────────────────

// GET /api/admin/orders — list all orders with subscriber name and email
router.get('/orders', requireAdmin, (req, res) => {
  const orders = db.prepare(`
    SELECT o.*, u.name AS user_name, u.email AS user_email
    FROM orders o
    JOIN users u ON u.id = o.user_id
    ORDER BY o.created_at DESC
  `).all();
  res.json({ orders });
});

// PUT /api/admin/orders/:id — edit an order's plan_name and/or status
router.put('/orders/:id', requireAdmin, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });

  const { status, plan_name } = req.body || {};

  const VALID_STATUSES = ['active', 'cancelled'];
  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'status must be "active" or "cancelled".' });
  }

  const newStatus   = status    !== undefined ? status    : order.status;
  const newPlanName = plan_name !== undefined ? plan_name.trim() : order.plan_name;

  if (!newPlanName) {
    return res.status(400).json({ error: 'plan_name cannot be empty.' });
  }

  db.prepare('UPDATE orders SET status = ?, plan_name = ? WHERE id = ?')
    .run(newStatus, newPlanName, order.id);

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  res.json({ order: updated });
});

// DELETE /api/admin/orders/:id — cancel an order
router.delete('/orders/:id', requireAdmin, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });

  db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(order.id);
  res.json({ ok: true });
});

module.exports = router;
