const express = require('express');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const multer  = require('multer');
const db      = require('../db');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'You must be logged in to post a review.' });
  }
  next();
}

// ── Optional photo upload ────────────────────────────────────────────────────
// Reviews can carry one optional image so subscribers can show off their
// breakfast / kids holding a carton / etc. Files live under uploads/reviews
// with random filenames (defeats path traversal and guessable URLs).
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'reviews');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_IMAGE_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp'
]);
const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png':  '.png',
  'image/gif':  '.gif',
  'image/webp': '.webp'
};

const reviewImageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const ext = EXT_BY_MIME[file.mimetype] || '.bin';
    cb(null, crypto.randomBytes(16).toString('hex') + ext);
  }
});

const uploadReviewPhoto = multer({
  storage: reviewImageStorage,
  limits: {
    fileSize: 5 * 1024 * 1024,  // 5 MB
    files: 1
  },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_IMAGE_MIME.has(file.mimetype)) return cb(null, true);
    cb(new Error('Only JPEG, PNG, GIF, or WEBP images are allowed.'));
  }
}).single('photo');

// Wrap multer so its errors come back as JSON 400s instead of HTML 500s.
function handleReviewPhotoUpload(req, res, next) {
  uploadReviewPhoto(req, res, (err) => {
    if (!err) return next();
    const message = (err instanceof multer.MulterError)
      ? `Upload error: ${err.message}`
      : (err.message || 'Upload error.');
    return res.status(400).json({ error: message });
  });
}

// Cleanup helper for failed validations after the file was already written.
const SAFE_REVIEW_IMG_RE = /^\/uploads\/reviews\/[a-f0-9]{32}\.(?:jpg|png|gif|webp)$/i;
function deleteReviewImage(urlPath) {
  if (typeof urlPath !== 'string' || !SAFE_REVIEW_IMG_RE.test(urlPath)) return;
  const filename = path.basename(urlPath);
  const full = path.join(UPLOAD_DIR, filename);
  if (path.dirname(full) !== UPLOAD_DIR) return;
  fs.unlink(full, () => { /* best-effort */ });
}

function uploadedReviewPhotoUrl(req) {
  return req.file ? `/uploads/reviews/${path.basename(req.file.filename)}` : null;
}

// GET /api/reviews — public list of all reviews, newest first
router.get('/', async (req, res) => {
  try {
    const rows = (await db.query(
      'SELECT id, user_name, rating, title, body, photo_url, created_at FROM reviews ORDER BY created_at DESC'
    )).rows;
    res.json({ reviews: rows });
  } catch (err) {
    console.error('GET /api/reviews failed:', err);
    res.status(500).json({ error: 'Failed to load reviews. Please try again.' });
  }
});

// POST /api/reviews — submit a review (requires auth, optional photo)
router.post('/', requireAuth, handleReviewPhotoUpload, async (req, res) => {
  const { rating, title, body } = req.body || {};
  const photoUrl = uploadedReviewPhotoUrl(req);

  // Helper that cleans up any uploaded file before returning a validation error.
  function rejectWith(status, error) {
    if (photoUrl) deleteReviewImage(photoUrl);
    return res.status(status).json({ error });
  }

  if (!rating || !title || !body) {
    return rejectWith(400, 'rating, title, and body are required.');
  }

  const ratingNum = parseInt(rating, 10);
  if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return rejectWith(400, 'Rating must be a number between 1 and 5.');
  }

  const titleTrimmed = String(title).trim();
  const bodyTrimmed  = String(body).trim();

  if (!titleTrimmed || titleTrimmed.length > 120) {
    return rejectWith(400, 'Title must be 1–120 characters.');
  }
  if (!bodyTrimmed || bodyTrimmed.length > 1000) {
    return rejectWith(400, 'Review must be 1–1000 characters.');
  }

  try {
    const user = (await db.query('SELECT name FROM users WHERE id = $1', [req.session.userId])).rows[0];
    if (!user) {
      return rejectWith(401, 'User not found.');
    }

    const insertResult = await db.query(
      'INSERT INTO reviews (user_id, user_name, rating, title, body, photo_url) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [req.session.userId, user.name, ratingNum, titleTrimmed, bodyTrimmed, photoUrl]
    );
    const reviewId = insertResult.rows[0].id;

    const review = (await db.query(
      'SELECT id, user_name, rating, title, body, photo_url, created_at FROM reviews WHERE id = $1',
      [reviewId]
    )).rows[0];

    res.json({ review });
  } catch (err) {
    console.error('POST /api/reviews failed:', err);
    return rejectWith(500, 'Failed to submit review. Please try again.');
  }
});

module.exports = router;
