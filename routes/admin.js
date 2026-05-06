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

module.exports = router;
