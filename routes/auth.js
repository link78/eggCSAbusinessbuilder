const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('../db');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'You must be logged in.' });
  }
  next();
}

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
  const existing = (await db.query('SELECT id FROM users WHERE email = $1', [emailLower])).rows[0];
  if (existing) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    const insertResult = await db.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [name.trim(), emailLower, hash]
    );
    const userId = insertResult.rows[0].id;

    const user = (await db.query(
      'SELECT id, name, email, role, avatar_url, created_at FROM users WHERE id = $1',
      [userId]
    )).rows[0];
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
  const row = (await db.query('SELECT * FROM users WHERE email = $1', [emailLower])).rows[0];
  if (!row) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  try {
    const match = await bcrypt.compare(password, row.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    const user = { id: row.id, name: row.name, email: row.email, role: row.role, avatar_url: row.avatar_url };
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
router.get('/me', async (req, res) => {
  if (!req.session.userId) {
    return res.json({ user: null });
  }
  const row = (await db.query(
    'SELECT id, name, email, role, avatar_url, created_at FROM users WHERE id = $1',
    [req.session.userId]
  )).rows[0];
  if (!row) {
    req.session.destroy(() => {});
    return res.json({ user: null });
  }
  res.json({ user: row });
});

// PUT /api/auth/me — edit name, email, and/or password
router.put('/me', requireAuth, async (req, res) => {
  const { name, email, currentPassword, newPassword } = req.body || {};

  const row = (await db.query('SELECT * FROM users WHERE id = $1', [req.session.userId])).rows[0];
  if (!row) return res.status(404).json({ error: 'User not found.' });

  const newName  = name  ? String(name).trim()                    : row.name;
  let   newEmail = email ? String(email).toLowerCase().trim() : row.email;

  if (!newName) return res.status(400).json({ error: 'Name cannot be empty.' });

  // Validate new email uniqueness
  if (newEmail !== row.email) {
    const conflict = (await db.query(
      'SELECT id FROM users WHERE email = $1 AND id != $2',
      [newEmail, row.id]
    )).rows[0];
    if (conflict) return res.status(409).json({ error: 'That email is already in use.' });
  }

  let newHash = row.password_hash;
  if (newPassword) {
    if (!currentPassword) {
      return res.status(400).json({ error: 'Current password is required to set a new password.' });
    }
    const match = await bcrypt.compare(currentPassword, row.password_hash);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect.' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    newHash = await bcrypt.hash(newPassword, 12);
  }

  await db.query(
    'UPDATE users SET name = $1, email = $2, password_hash = $3 WHERE id = $4',
    [newName, newEmail, newHash, row.id]
  );

  const updated = (await db.query(
    'SELECT id, name, email, role, avatar_url, created_at FROM users WHERE id = $1',
    [row.id]
  )).rows[0];
  res.json({ user: updated });
});

// PUT /api/auth/avatar — update profile picture (base64 data URL)
router.put('/avatar', requireAuth, async (req, res) => {
  const { avatarUrl } = req.body || {};

  if (!avatarUrl) {
    // Allow clearing the avatar
    await db.query('UPDATE users SET avatar_url = NULL WHERE id = $1', [req.session.userId]);
    return res.json({ ok: true, avatar_url: null });
  }

  // Validate it is a data URL with an image MIME type
  if (!/^data:image\/(jpeg|png|gif|webp);base64,/.test(avatarUrl)) {
    return res.status(400).json({ error: 'avatarUrl must be a base64-encoded image data URL (jpeg, png, gif, or webp).' });
  }

  // Limit size to ~2 MB (base64 string length)
  if (avatarUrl.length > 2 * 1024 * 1024 * 1.4) {
    return res.status(400).json({ error: 'Image is too large. Please use an image under 2 MB.' });
  }

  await db.query('UPDATE users SET avatar_url = $1 WHERE id = $2', [avatarUrl, req.session.userId]);
  res.json({ ok: true, avatar_url: avatarUrl });
});

module.exports = router;
