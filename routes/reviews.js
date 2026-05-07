const express = require('express');
const db      = require('../db');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'You must be logged in to post a review.' });
  }
  next();
}

// GET /api/reviews — public list of all reviews, newest first
router.get('/', async (req, res) => {
  const rows = (await db.query(
    'SELECT id, user_name, rating, title, body, created_at FROM reviews ORDER BY created_at DESC'
  )).rows;
  res.json({ reviews: rows });
});

// POST /api/reviews — submit a review (requires auth)
router.post('/', requireAuth, async (req, res) => {
  const { rating, title, body } = req.body || {};

  if (!rating || !title || !body) {
    return res.status(400).json({ error: 'rating, title, and body are required.' });
  }

  const ratingNum = parseInt(rating, 10);
  if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ error: 'Rating must be a number between 1 and 5.' });
  }

  const titleTrimmed = String(title).trim();
  const bodyTrimmed  = String(body).trim();

  if (!titleTrimmed || titleTrimmed.length > 120) {
    return res.status(400).json({ error: 'Title must be 1–120 characters.' });
  }
  if (!bodyTrimmed || bodyTrimmed.length > 1000) {
    return res.status(400).json({ error: 'Review must be 1–1000 characters.' });
  }

  const user = (await db.query('SELECT name FROM users WHERE id = $1', [req.session.userId])).rows[0];
  if (!user) {
    return res.status(401).json({ error: 'User not found.' });
  }

  const insertResult = await db.query(
    'INSERT INTO reviews (user_id, user_name, rating, title, body) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [req.session.userId, user.name, ratingNum, titleTrimmed, bodyTrimmed]
  );
  const reviewId = insertResult.rows[0].id;

  const review = (await db.query(
    'SELECT id, user_name, rating, title, body, created_at FROM reviews WHERE id = $1',
    [reviewId]
  )).rows[0];

  res.json({ review });
});

module.exports = router;
