const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('../db');
const stripe  = require('../stripe');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'You must be logged in.' });
  }
  next();
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { name, email, password, referralCode } = req.body || {};

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

  // Look up the referrer (if any) BEFORE inserting the new user so we can
  // validate the code and avoid self-referral.
  let referrer = null;
  if (referralCode && typeof referralCode === 'string' && referralCode.trim()) {
    const code = referralCode.trim().toUpperCase();
    referrer = (await db.query(
      'SELECT id FROM users WHERE referral_code = $1',
      [code]
    )).rows[0] || null;
    // Silently ignore unknown codes — never expose code-enumeration data.
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    const cleanName = name.trim();
    // Generate a unique referral code for the new user. Collisions are
    // astronomically unlikely (32^8 ≈ 1.1 × 10^12) but we retry to be safe.
    let newCode;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = db.generateReferralCode();
      const taken = (await db.query('SELECT 1 FROM users WHERE referral_code = $1', [candidate])).rows[0];
      if (!taken) { newCode = candidate; break; }
    }
    if (!newCode) newCode = db.generateReferralCode();  // last-ditch fallback

    const insertResult = await db.query(
      `INSERT INTO users (name, email, password_hash, referral_code, referred_by_user_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, stripe_customer_id`,
      [cleanName, emailLower, hash, newCode, referrer ? referrer.id : null]
    );
    const insertedUser = insertResult.rows[0];
    const userId = insertedUser.id;
    await stripe.ensureStripeCustomerForUser(insertedUser);

    // Record a pending referral row. The credit is paid out when the new
    // user places their first order (handled in routes/orders.js).
    if (referrer && referrer.id !== userId) {
      await db.query(
        `INSERT INTO referrals (referrer_user_id, referred_user_id, status)
         VALUES ($1, $2, 'pending')
         ON CONFLICT (referred_user_id) DO NOTHING`,
        [referrer.id, userId]
      );
    }

    const user = (await db.query(
      'SELECT id, name, email, role, avatar_url, referral_code, account_credit_cents, created_at FROM users WHERE id = $1',
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
    'SELECT id, name, email, role, avatar_url, referral_code, account_credit_cents, created_at FROM users WHERE id = $1',
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

// GET /api/auth/notifications — fetch the current user's reminder preferences
router.get('/notifications', requireAuth, async (req, res) => {
  const row = (await db.query(
    `SELECT reminder_email_enabled, reminder_sms_enabled, phone_number
     FROM users WHERE id = $1`,
    [req.session.userId]
  )).rows[0];
  if (!row) return res.status(404).json({ error: 'User not found.' });
  res.json({
    reminderEmailEnabled: row.reminder_email_enabled,
    reminderSmsEnabled:   row.reminder_sms_enabled,
    phoneNumber:          row.phone_number || ''
  });
});

// PUT /api/auth/notifications — update the user's reminder preferences
router.put('/notifications', requireAuth, async (req, res) => {
  const { reminderEmailEnabled, reminderSmsEnabled, phoneNumber } = req.body || {};

  // Validate phone — accept E.164-ish or US national; we only require digits
  // (10–15) for MVP. Empty string clears the field.
  let cleanPhone = null;
  if (phoneNumber !== undefined && phoneNumber !== null) {
    const raw = String(phoneNumber).trim();
    if (raw === '') {
      cleanPhone = null;
    } else {
      const digits = raw.replace(/[^\d]/g, '');
      if (digits.length < 10 || digits.length > 15) {
        return res.status(400).json({ error: 'phoneNumber must contain 10–15 digits.' });
      }
      cleanPhone = raw;
    }
  }

  // If SMS is being enabled, we need a phone number on file.
  if (reminderSmsEnabled === true) {
    const existing = (await db.query(
      'SELECT phone_number FROM users WHERE id = $1',
      [req.session.userId]
    )).rows[0];
    const finalPhone = cleanPhone !== null ? cleanPhone : existing && existing.phone_number;
    if (!finalPhone) {
      return res.status(400).json({ error: 'A phone number is required to enable SMS reminders.' });
    }
  }

  // Build a single atomic UPDATE. We use sentinel values so we can
  // distinguish "leave unchanged" (NULL parameter) from "set to NULL"
  // (the special string '__CLEAR__'). This is simpler and race-safe
  // compared to issuing two UPDATE statements.
  const PHONE_CLEAR = '__CLEAR__';
  let phoneParam;
  if (phoneNumber === '' || phoneNumber === null) {
    phoneParam = PHONE_CLEAR;
  } else if (cleanPhone !== null) {
    phoneParam = cleanPhone;
  } else {
    phoneParam = null;  // leave unchanged
  }

  await db.query(
    `UPDATE users
     SET reminder_email_enabled = COALESCE($1, reminder_email_enabled),
         reminder_sms_enabled   = COALESCE($2, reminder_sms_enabled),
         phone_number           = CASE
           WHEN $3::text = '${PHONE_CLEAR}' THEN NULL
           WHEN $3::text IS NULL            THEN phone_number
           ELSE $3
         END
     WHERE id = $4`,
    [
      typeof reminderEmailEnabled === 'boolean' ? reminderEmailEnabled : null,
      typeof reminderSmsEnabled   === 'boolean' ? reminderSmsEnabled   : null,
      phoneParam,
      req.session.userId
    ]
  );

  const row = (await db.query(
    `SELECT reminder_email_enabled, reminder_sms_enabled, phone_number
     FROM users WHERE id = $1`,
    [req.session.userId]
  )).rows[0];
  res.json({
    reminderEmailEnabled: row.reminder_email_enabled,
    reminderSmsEnabled:   row.reminder_sms_enabled,
    phoneNumber:          row.phone_number || ''
  });
});

module.exports = router;
