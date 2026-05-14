const express = require('express');
const db      = require('../db');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'You must be logged in.' });
  }
  next();
}

// GET /api/referrals/me — returns the current user's referral code, current
// account credit balance, and a list of their referrals with status.
router.get('/me', requireAuth, async (req, res) => {
  const user = (await db.query(
    'SELECT referral_code, account_credit_cents FROM users WHERE id = $1',
    [req.session.userId]
  )).rows[0];
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const referrals = (await db.query(
    `SELECT r.id, r.status, r.credit_cents, r.created_at, r.converted_at,
            u.name AS referred_name
     FROM referrals r
     JOIN users u ON u.id = r.referred_user_id
     WHERE r.referrer_user_id = $1
     ORDER BY r.created_at DESC`,
    [req.session.userId]
  )).rows;

  const convertedCount = referrals.filter(r => r.status === 'converted').length;
  const pendingCount   = referrals.filter(r => r.status === 'pending').length;

  res.json({
    referralCode:       user.referral_code,
    accountCreditCents: user.account_credit_cents,
    referrals,
    summary: {
      total:     referrals.length,
      converted: convertedCount,
      pending:   pendingCount
    }
  });
});

// POST /api/referrals/validate — quick check that a code exists; does NOT
// expose owner identity. Useful for the signup form to give live feedback.
router.post('/validate', async (req, res) => {
  const { referralCode } = req.body || {};
  if (!referralCode || typeof referralCode !== 'string') {
    return res.status(400).json({ valid: false, error: 'referralCode is required.' });
  }
  const code = referralCode.trim().toUpperCase();
  const row = (await db.query(
    'SELECT 1 FROM users WHERE referral_code = $1',
    [code]
  )).rows[0];
  res.json({ valid: !!row });
});

module.exports = router;
