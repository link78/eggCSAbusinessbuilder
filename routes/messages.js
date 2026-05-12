const express = require('express');
const db      = require('../db');

const router = express.Router();

// Maximum length of a single message body. Matches the textarea limit in
// the UI and keeps rows small in PostgreSQL.
const MAX_BODY_LEN = 4000;

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'You must be logged in.' });
  }
  next();
}

/**
 * Pick the "farm" admin a customer should converse with.
 * Strategy: lowest-id admin (typically the primary account). This keeps
 * every customer's thread anchored to a single admin so replies do not
 * fragment across multiple admins. Returns null when no admin exists.
 */
async function getPrimaryAdminId() {
  const row = (await db.query(
    "SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1"
  )).rows[0];
  return row ? row.id : null;
}

// GET /api/messages — fetch the logged-in user's thread with the farm.
// Admins receive an empty thread here (they use /api/admin/messages instead).
router.get('/', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const me = (await db.query('SELECT role FROM users WHERE id = $1', [userId])).rows[0];
  if (!me) return res.status(401).json({ error: 'You must be logged in.' });

  // Customers talk to the primary admin. Admins should use the admin API.
  if (me.role === 'admin') {
    return res.json({ messages: [] });
  }

  const adminId = await getPrimaryAdminId();
  if (!adminId) return res.json({ messages: [] });

  const rows = (await db.query(
    `SELECT m.id, m.sender_id, m.recipient_id, m.body, m.read_at, m.created_at,
            u.role AS sender_role
       FROM messages m
       JOIN users u ON u.id = m.sender_id
      WHERE (m.sender_id    = $1 AND m.recipient_id IN (SELECT id FROM users WHERE role = 'admin'))
         OR (m.recipient_id = $1 AND m.sender_id    IN (SELECT id FROM users WHERE role = 'admin'))
      ORDER BY m.created_at ASC, m.id ASC`,
    [userId]
  )).rows;

  // Mark any unread admin → user messages as read now that the user is viewing them.
  await db.query(
    `UPDATE messages
        SET read_at = NOW()
      WHERE recipient_id = $1
        AND read_at IS NULL
        AND sender_id IN (SELECT id FROM users WHERE role = 'admin')`,
    [userId]
  );

  res.json({ messages: rows });
});

// GET /api/messages/unread-count — count of unread admin → user messages.
router.get('/unread-count', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const row = (await db.query(
    `SELECT COUNT(*)::int AS unread
       FROM messages
      WHERE recipient_id = $1
        AND read_at IS NULL
        AND sender_id IN (SELECT id FROM users WHERE role = 'admin')`,
    [userId]
  )).rows[0];
  res.json({ unread: row ? row.unread : 0 });
});

// POST /api/messages — customer sends a message to the farm/admin.
router.post('/', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const me = (await db.query('SELECT role FROM users WHERE id = $1', [userId])).rows[0];
  if (!me) return res.status(401).json({ error: 'You must be logged in.' });
  if (me.role === 'admin') {
    return res.status(400).json({ error: 'Admins must use the admin messaging endpoints.' });
  }

  const body = req.body && typeof req.body.body === 'string' ? req.body.body.trim() : '';
  if (!body) return res.status(400).json({ error: 'Message body is required.' });
  if (body.length > MAX_BODY_LEN) {
    return res.status(400).json({ error: `Message is too long (max ${MAX_BODY_LEN} characters).` });
  }

  const adminId = await getPrimaryAdminId();
  if (!adminId) {
    return res.status(503).json({ error: 'No admin is available to receive messages.' });
  }

  const row = (await db.query(
    `INSERT INTO messages (sender_id, recipient_id, body)
     VALUES ($1, $2, $3) RETURNING *`,
    [userId, adminId, body]
  )).rows[0];
  res.status(201).json({ message: row });
});

module.exports = router;
