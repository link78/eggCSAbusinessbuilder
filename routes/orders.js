const express = require('express');
const db      = require('../db');

const router = express.Router();

// Canonical plan definitions — price and eggs are never trusted from the client
// Pricing: 18 eggs = $7/week; monthly = weekly price × 4 weeks
const PLANS = {
  'Solo / Couple': { price: 9,  eggsPerWeek: 6  },  // 6 eggs/wk  = $7×(6/18)×4  ≈ $9/mo
  'Small Family':  { price: 19, eggsPerWeek: 12 },  // 12 eggs/wk = $7×(12/18)×4 ≈ $19/mo
  'Family':        { price: 28, eggsPerWeek: 18 }   // 18 eggs/wk = $7×1×4       = $28/mo
};

// Price per box of 18 eggs for custom plans
const PRICE_PER_BOX = 7;
const EGGS_PER_BOX  = 18;

const MIN_BOXES = 2;
const MIN_WEEKS = 2;
const MAX_BOXES = 20;
const MAX_WEEKS = 52;

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

// GET /api/orders/plans — public list of available plans + custom plan info
router.get('/plans', (req, res) => {
  const plans = Object.entries(PLANS).map(([name, p]) => ({ name, ...p }));
  res.json({
    plans,
    customPlan: {
      pricePerBox: PRICE_PER_BOX,
      eggsPerBox:  EGGS_PER_BOX,
      minBoxes:    MIN_BOXES,
      minWeeks:    MIN_WEEKS,
      maxBoxes:    MAX_BOXES,
      maxWeeks:    MAX_WEEKS
    }
  });
});

// GET /api/orders — list current user's orders
router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC'
  ).all(req.session.userId);
  res.json({ orders: rows });
});

// POST /api/orders — place a new subscription order (standard or custom)
router.post('/', requireAuth, (req, res) => {
  const { planName, fulfillmentMethod, deliveryAddress, pickupDay,
          boxesPerDelivery, durationWeeks } = req.body || {};

  if (!planName) {
    return res.status(400).json({ error: 'planName is required.' });
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

  let price, eggsPerWeek, boxes, weeks;

  if (planName === 'Custom') {
    // Validate custom plan parameters
    boxes = parseInt(boxesPerDelivery, 10);
    weeks = parseInt(durationWeeks, 10);

    if (isNaN(boxes) || boxes < MIN_BOXES) {
      return res.status(400).json({ error: `boxesPerDelivery must be at least ${MIN_BOXES}.` });
    }
    if (boxes > MAX_BOXES) {
      return res.status(400).json({ error: `boxesPerDelivery cannot exceed ${MAX_BOXES}.` });
    }
    if (isNaN(weeks) || weeks < MIN_WEEKS) {
      return res.status(400).json({ error: `durationWeeks must be at least ${MIN_WEEKS}.` });
    }
    if (weeks > MAX_WEEKS) {
      return res.status(400).json({ error: `durationWeeks cannot exceed ${MAX_WEEKS}.` });
    }

    eggsPerWeek = boxes * EGGS_PER_BOX;
    price       = boxes * PRICE_PER_BOX * weeks;  // total price for the full subscription period
  } else {
    const plan = PLANS[planName];
    if (!plan) {
      return res.status(400).json({ error: 'Invalid plan name.' });
    }
    price       = plan.price;
    eggsPerWeek = plan.eggsPerWeek;
    boxes       = null;
    weeks       = null;
  }

  // Cancel any existing active order before creating a new one
  db.prepare(
    "UPDATE orders SET status = 'cancelled' WHERE user_id = ? AND status = 'active'"
  ).run(req.session.userId);

  const result = db.prepare(`
    INSERT INTO orders
      (user_id, plan_name, price, eggs_per_week,
       fulfillment_method, delivery_address, pickup_day, next_billing_date,
       boxes_per_delivery, duration_weeks)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.session.userId, planName, price, eggsPerWeek,
    method, cleanAddress, cleanDay, nextBillingDate(),
    boxes, weeks
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
