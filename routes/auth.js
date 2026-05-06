const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('../db');

const router = express.Router();

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { name, email, password } = req.body || {};

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  const emailLower = email.toLowerCase().trim();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(emailLower);
  if (existing) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare(
      'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)'
    ).run(name.trim(), emailLower, hash);

    const user = db.prepare('SELECT id, name, email, created_at FROM users WHERE id = ?')
                   .get(result.lastInsertRowid);
    req.session.userId = user.id;
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const emailLower = email.toLowerCase().trim();
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(emailLower);
  if (!row) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  try {
    const match = await bcrypt.compare(password, row.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    const user = { id: row.id, name: row.name, email: row.email };
    req.session.userId = user.id;
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  // Preserve CSRF token across session regeneration so the user can log in again
  // without needing to re-fetch a new CSRF token.
  const csrf = req.session.csrfToken;
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Logout failed.' });
    req.session.csrfToken = csrf;
    res.json({ ok: true });
  });
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  if (!req.session.userId) {
    return res.json({ user: null });
  }
  const row = db.prepare('SELECT id, name, email, created_at FROM users WHERE id = ?')
                .get(req.session.userId);
  if (!row) {
    req.session.destroy(() => {});
    return res.json({ user: null });
  }
  res.json({ user: row });
});

module.exports = router;
