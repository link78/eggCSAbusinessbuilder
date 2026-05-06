const express = require('express');
const db      = require('../db');

const router = express.Router();

// Canonical plan definitions — price and eggs are never trusted from the client
const PLANS = {
  'Solo / Couple': { price: 26, eggsPerWeek: 6 },
  'Small Family':  { price: 39, eggsPerWeek: 12 },
  'Family':        { price: 52, eggsPerWeek: 18 }
};

const VALID_PICKUP_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Compute the date of the first day of next month (YYYY-MM-DD)
function nextBillingDate() {
  const now = new Date();
  const d   = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return d.toISOString().slice(0, 10);
}

// Auth middleware
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'You must be logged in.' });
  }
  next();
}

// GET /api/orders/plans — public list of available plans
router.get('/plans', (req, res) => {
  const plans = Object.entries(PLANS).map(([name, p]) => ({ name, ...p }));
  res.json({ plans });
});

// GET /api/orders — list current user's orders
router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC'
  ).all(req.session.userId);
  res.json({ orders: rows });
});

// POST /api/orders — place a new subscription order
router.post('/', requireAuth, (req, res) => {
  const { planName, fulfillmentMethod, deliveryAddress, pickupDay } = req.body || {};

  if (!planName) {
    return res.status(400).json({ error: 'planName is required.' });
  }
  const plan = PLANS[planName];
  if (!plan) {
    return res.status(400).json({ error: 'Invalid plan name.' });
  }

  const method = (fulfillmentMethod || '').toLowerCase();
  if (method !== 'pickup' && method !== 'delivery') {
    return res.status(400).json({ error: 'fulfillmentMethod must be "pickup" or "delivery".' });
  }

  if (method === 'delivery') {
    if (!deliveryAddress || !deliveryAddress.trim()) {
      return res.status(400).json({ error: 'deliveryAddress is required for delivery orders.' });
    }
  } else {
    if (!pickupDay || !VALID_PICKUP_DAYS.includes(pickupDay)) {
      return res.status(400).json({
        error: `pickupDay must be one of: ${VALID_PICKUP_DAYS.join(', ')}.`
      });
    }
  }

  const cleanAddress = method === 'delivery' ? deliveryAddress.trim() : null;
  const cleanDay     = method === 'pickup'   ? pickupDay            : null;

  // Cancel any existing active order before creating a new one
  db.prepare(
    "UPDATE orders SET status = 'cancelled' WHERE user_id = ? AND status = 'active'"
  ).run(req.session.userId);

  const result = db.prepare(`
    INSERT INTO orders
      (user_id, plan_name, price, eggs_per_week,
       fulfillment_method, delivery_address, pickup_day, next_billing_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.session.userId, planName, plan.price, plan.eggsPerWeek,
    method, cleanAddress, cleanDay, nextBillingDate()
  );

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(result.lastInsertRowid);
  res.json({ order });
});

// DELETE /api/orders/:id — cancel an order
router.delete('/:id', requireAuth, (req, res) => {
  const order = db.prepare(
    'SELECT * FROM orders WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.session.userId);

  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  db.prepare(
    "UPDATE orders SET status = 'cancelled' WHERE id = ?"
  ).run(order.id);

  res.json({ ok: true });
});

module.exports = router;
