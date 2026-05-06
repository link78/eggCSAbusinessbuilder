const express = require('express');
const db      = require('../db');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'You must be logged in.' });
  }
  next();
}

// GET /api/checklist — get user's saved checklist progress
router.get('/', requireAuth, (req, res) => {
  const row = db.prepare(
    'SELECT completed_steps FROM checklist_progress WHERE user_id = ?'
  ).get(req.session.userId);

  const completedSteps = row ? JSON.parse(row.completed_steps) : [];
  res.json({ completedSteps });
});

// PUT /api/checklist — save user's checklist progress
router.put('/', requireAuth, (req, res) => {
  const { completedSteps } = req.body || {};

  if (!Array.isArray(completedSteps)) {
    return res.status(400).json({ error: 'completedSteps must be an array.' });
  }

  const stepsJson = JSON.stringify(completedSteps.map(Number).filter(n => !isNaN(n)));

  db.prepare(`
    INSERT INTO checklist_progress (user_id, completed_steps)
    VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET completed_steps = excluded.completed_steps
  `).run(req.session.userId, stepsJson);

  res.json({ ok: true });
});

module.exports = router;
