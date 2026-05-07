const express = require('express');
const db      = require('../db');

const router = express.Router();

// GET /api/plan-config — public, returns all plan configurations
router.get('/', async (req, res) => {
  const plans = (await db.query('SELECT * FROM plan_config ORDER BY id ASC')).rows;
  res.json({ plans });
});

module.exports = router;
