const express = require('express');
const db      = require('../db');
const schedule = require('../lib/deliverySchedule');

const router = express.Router();

// ── Pricing constants ──────────────────────────────────────────────────────────
const PRICE_PER_12_BOX      = 5;  // $5 per box of 12 eggs
const PRICE_PER_18_BOX      = 7;  // $7 per box of 18 eggs
const DELIVERY_FEE_PER_WEEK = 2;  // $2 per weekly delivery when method = delivery
const MONTHLY_WEEKS         = 2;  // Bi-weekly plans: 2 deliveries per month

// Subscription delivery rules
const DELIVERY_FREQUENCY    = 'biweekly';  // Deliveries occur every 2 weeks
const WEEKS_PER_DELIVERY    = 2;           // → eggs_per_delivery = eggs_per_week * 2
const MIN_EGGS_PER_WEEK     = 12;          // At least one 12-egg box per week

// Referral reward — $5 in account credit (5_00 cents) per converted referral
const REFERRAL_REWARD_CENTS = 500;

// Fixed plans — one box per weekly delivery; price depends on box type chosen by subscriber
const FIXED_PLANS = {
  'Small Family': { boxes: 1 },
  'Family':       { boxes: 1 }
};

// Flexible plan constraints
const SOLO_MIN_BOXES   = 1;   // Solo / Couple: at least 1 box (12-egg or 18-egg)
const CUSTOM_MIN_BOXES = 1;   // Custom: at least 1 box (12-egg or 18-egg) total
const CUSTOM_MIN_WEEKS = 2;   // Custom: at least 2 weeks duration
const MAX_BOXES        = 20;  // max boxes per type per delivery
const MAX_WEEKS        = 52;

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

// GET /api/orders/plans — public plan catalogue and pricing constants
router.get('/plans', (req, res) => {
  const plans = Object.entries(FIXED_PLANS).map(([name, p]) => ({
    name,
    boxes:        p.boxes,
    price12:      p.boxes * PRICE_PER_12_BOX * MONTHLY_WEEKS,
    price18:      p.boxes * PRICE_PER_18_BOX * MONTHLY_WEEKS,
    eggsPerWeek12: p.boxes * 12,
    eggsPerWeek18: p.boxes * 18
  }));
  res.json({
    plans,
    deliveryFeePerWeek: DELIVERY_FEE_PER_WEEK,
    deliveryFrequency:  DELIVERY_FREQUENCY,
    weeksPerDelivery:   WEEKS_PER_DELIVERY,
    minEggsPerWeek:     MIN_EGGS_PER_WEEK,
    soloCoupleConstraints: {
      minBoxes:      SOLO_MIN_BOXES,
      monthlyWeeks:  MONTHLY_WEEKS,
      pricePerBox12: PRICE_PER_12_BOX,
      pricePerBox18: PRICE_PER_18_BOX
    },
    customPlan: {
      pricePerBox12: PRICE_PER_12_BOX,
      pricePerBox18: PRICE_PER_18_BOX,
      minBoxes:      CUSTOM_MIN_BOXES,
      minWeeks:      CUSTOM_MIN_WEEKS,
      maxBoxes:      MAX_BOXES,
      maxWeeks:      MAX_WEEKS
    }
  });
});

// GET /api/orders — list current user's orders
router.get('/', requireAuth, async (req, res) => {
  const rows = (await db.query(
    'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
    [req.session.userId]
  )).rows;
  res.json({ orders: rows });
});

// POST /api/orders — place a new subscription order (standard or flexible)
router.post('/', requireAuth, async (req, res) => {
  const { planName, fulfillmentMethod, deliveryAddress, pickupDay,
          boxes12, boxes18, durationWeeks } = req.body || {};

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

  let price, eggsPerWeek, b12, b18, weeks, totalBoxes;

  if (planName === 'Solo / Couple') {
    // Flexible monthly plan — user picks box sizes (12-egg and/or 18-egg)
    b12 = Math.max(0, parseInt(boxes12, 10) || 0);
    b18 = Math.max(0, parseInt(boxes18, 10) || 0);
    totalBoxes = b12 + b18;

    if (totalBoxes < SOLO_MIN_BOXES) {
      return res.status(400).json({
        error: `Solo / Couple plan requires at least ${SOLO_MIN_BOXES} box (12-egg or 18-egg).`
      });
    }

    weeks        = null;  // recurring monthly plan — no fixed duration
    eggsPerWeek  = b12 * 12 + b18 * 18;
    const base   = (b12 * PRICE_PER_12_BOX + b18 * PRICE_PER_18_BOX) * MONTHLY_WEEKS;
    const dlvFee = method === 'delivery' ? DELIVERY_FEE_PER_WEEK * MONTHLY_WEEKS : 0;
    price        = base + dlvFee;

  } else if (planName === 'Custom') {
    // Fully flexible plan — user picks box sizes and duration
    b12 = Math.max(0, parseInt(boxes12, 10) || 0);
    b18 = Math.max(0, parseInt(boxes18, 10) || 0);
    weeks      = parseInt(durationWeeks, 10);
    totalBoxes = b12 + b18;

    if (totalBoxes < CUSTOM_MIN_BOXES) {
      return res.status(400).json({
        error: `Custom plan requires at least ${CUSTOM_MIN_BOXES} box (12-egg or 18-egg).`
      });
    }
    if (totalBoxes > MAX_BOXES) {
      return res.status(400).json({ error: `Total boxes per delivery cannot exceed ${MAX_BOXES}.` });
    }
    if (isNaN(weeks) || weeks < CUSTOM_MIN_WEEKS) {
      return res.status(400).json({ error: `durationWeeks must be at least ${CUSTOM_MIN_WEEKS}.` });
    }
    if (weeks > MAX_WEEKS) {
      return res.status(400).json({ error: `durationWeeks cannot exceed ${MAX_WEEKS}.` });
    }

    eggsPerWeek  = b12 * 12 + b18 * 18;
    const base   = (b12 * PRICE_PER_12_BOX + b18 * PRICE_PER_18_BOX) * weeks;
    const dlvFee = method === 'delivery' ? DELIVERY_FEE_PER_WEEK * weeks : 0;
    price        = base + dlvFee;

  } else {
    // Fixed plan (Small Family / Family) — subscriber picks box type: dozen or 18-egg
    const plan = FIXED_PLANS[planName];
    if (!plan) {
      return res.status(400).json({ error: 'Invalid plan name.' });
    }

    const rawBoxType = (req.body.boxType || '').toLowerCase();
    // Default: Small Family → dozen, Family → 18-egg (mirrors original plan defaults)
    const boxType = (rawBoxType === 'dozen' || rawBoxType === '18')
      ? rawBoxType
      : (planName === 'Small Family' ? 'dozen' : '18');

    b12        = boxType === 'dozen' ? plan.boxes : 0;
    b18        = boxType === '18'    ? plan.boxes : 0;
    eggsPerWeek = b12 * 12 + b18 * 18;
    totalBoxes  = plan.boxes;
    weeks       = null;

    const dlvFee = method === 'delivery' ? DELIVERY_FEE_PER_WEEK * MONTHLY_WEEKS : 0;
    price        = (b12 * PRICE_PER_12_BOX + b18 * PRICE_PER_18_BOX) * MONTHLY_WEEKS + dlvFee;
  }

  // Enforce the global weekly-egg minimum (at least one 12-egg box per week).
  // For biweekly plans this also implies at least 24 eggs per delivery.
  if (eggsPerWeek < MIN_EGGS_PER_WEEK) {
    return res.status(400).json({
      error: `Each subscription must include at least ${MIN_EGGS_PER_WEEK} eggs per week (one 12-egg or 18-egg box).`
    });
  }

  // Bi-weekly delivery cadence: total eggs per delivery is always 2 weeks worth.
  const eggsPerDelivery = eggsPerWeek * WEEKS_PER_DELIVERY;

  // Default first delivery to 7 days from today, so the farm has lead time.
  // This anchors the recurring biweekly schedule for this subscription.
  const firstDeliveryDate = schedule.toISODate(
    schedule.addDays(schedule.todayUTC(), 7)
  );

  // Cancel any existing active order before creating a new one
  await db.query(
    "UPDATE orders SET status = 'cancelled' WHERE user_id = $1 AND status = 'active'",
    [req.session.userId]
  );

  const insertResult = await db.query(`
    INSERT INTO orders
      (user_id, plan_name, price, eggs_per_week,
       fulfillment_method, delivery_address, pickup_day, next_billing_date,
       boxes_per_delivery, duration_weeks, boxes12_per_delivery, boxes18_per_delivery,
       delivery_frequency, eggs_per_delivery, first_delivery_date)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    RETURNING id
  `, [
    req.session.userId, planName, price, eggsPerWeek,
    method, cleanAddress, cleanDay, nextBillingDate(),
    totalBoxes, weeks, b12, b18,
    DELIVERY_FREQUENCY, eggsPerDelivery, firstDeliveryDate
  ]);

  const orderId = insertResult.rows[0].id;

  // Referral conversion — if this is the customer's first ever order, credit
  // the referrer (if any) with $5 in account credit. Idempotent: the
  // referrals row is set to 'converted' so subsequent orders don't double-pay.
  await convertReferralIfFirstOrder(req.session.userId);

  const order = (await db.query('SELECT * FROM orders WHERE id = $1', [orderId])).rows[0];
  res.json({ order });
});

/**
 * If the user has a pending referral row, mark it converted and credit the
 * referrer's account. Safe to call on every order POST — no-op once converted.
 */
async function convertReferralIfFirstOrder(userId) {
  // Only convert on first order ever placed by this user.
  const orderCount = (await db.query(
    'SELECT COUNT(*)::int AS c FROM orders WHERE user_id = $1',
    [userId]
  )).rows[0].c;
  if (orderCount !== 0) return;

  const pending = (await db.query(
    `SELECT id, referrer_user_id FROM referrals
     WHERE referred_user_id = $1 AND status = 'pending'`,
    [userId]
  )).rows[0];
  if (!pending) return;

  await db.query(
    `UPDATE referrals
     SET status = 'converted', converted_at = NOW(), credit_cents = $2
     WHERE id = $1`,
    [pending.id, REFERRAL_REWARD_CENTS]
  );
  await db.query(
    `UPDATE users
     SET account_credit_cents = account_credit_cents + $2
     WHERE id = $1`,
    [pending.referrer_user_id, REFERRAL_REWARD_CENTS]
  );
}

// ── Subscription management: pause / resume / skip ─────────────────────────

async function getActiveOrderForUser(orderId, userId) {
  return (await db.query(
    'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
    [orderId, userId]
  )).rows[0];
}

// POST /api/orders/:id/pause — pause deliveries until a future date (YYYY-MM-DD)
router.post('/:id/pause', requireAuth, async (req, res) => {
  const { pausedUntil } = req.body || {};
  const parsed = schedule.parseISODate(pausedUntil);
  if (!parsed) {
    return res.status(400).json({ error: 'pausedUntil must be a YYYY-MM-DD date.' });
  }
  if (parsed <= schedule.todayUTC()) {
    return res.status(400).json({ error: 'pausedUntil must be in the future.' });
  }
  // Reasonable cap of 1 year to avoid runaway "pauses".
  const oneYearOut = schedule.addDays(schedule.todayUTC(), 365);
  if (parsed > oneYearOut) {
    return res.status(400).json({ error: 'pausedUntil cannot be more than 1 year in the future.' });
  }

  const order = await getActiveOrderForUser(req.params.id, req.session.userId);
  if (!order)                       return res.status(404).json({ error: 'Order not found.' });
  if (order.status !== 'active')    return res.status(400).json({ error: 'Only active orders can be paused.' });

  await db.query(
    'UPDATE orders SET paused_until = $1 WHERE id = $2',
    [schedule.toISODate(parsed), order.id]
  );
  const updated = (await db.query('SELECT * FROM orders WHERE id = $1', [order.id])).rows[0];
  res.json({ order: updated });
});

// POST /api/orders/:id/resume — clear any active pause
router.post('/:id/resume', requireAuth, async (req, res) => {
  const order = await getActiveOrderForUser(req.params.id, req.session.userId);
  if (!order) return res.status(404).json({ error: 'Order not found.' });

  await db.query(
    'UPDATE orders SET paused_until = NULL WHERE id = $1',
    [order.id]
  );
  const updated = (await db.query('SELECT * FROM orders WHERE id = $1', [order.id])).rows[0];
  res.json({ order: updated });
});

// POST /api/orders/:id/skip — skip a single specific upcoming delivery date
router.post('/:id/skip', requireAuth, async (req, res) => {
  const { deliveryDate } = req.body || {};
  const parsed = schedule.parseISODate(deliveryDate);
  if (!parsed) {
    return res.status(400).json({ error: 'deliveryDate must be a YYYY-MM-DD date.' });
  }
  if (parsed <= schedule.todayUTC()) {
    return res.status(400).json({ error: 'deliveryDate must be in the future.' });
  }

  const order = await getActiveOrderForUser(req.params.id, req.session.userId);
  if (!order)                    return res.status(404).json({ error: 'Order not found.' });
  if (order.status !== 'active') return res.status(400).json({ error: 'Only active orders can have a delivery skipped.' });

  // Validate the date is actually one of the upcoming delivery dates.
  const upcoming = schedule.upcomingDeliveries(order, 12);
  const iso = schedule.toISODate(parsed);
  if (!upcoming.some(s => s.date === iso)) {
    return res.status(400).json({ error: 'deliveryDate is not one of your upcoming delivery dates.' });
  }

  await db.query(
    'UPDATE orders SET skip_next_delivery_date = $1 WHERE id = $2',
    [iso, order.id]
  );
  const updated = (await db.query('SELECT * FROM orders WHERE id = $1', [order.id])).rows[0];
  res.json({ order: updated });
});

// POST /api/orders/:id/unskip — clear any pending single-delivery skip
router.post('/:id/unskip', requireAuth, async (req, res) => {
  const order = await getActiveOrderForUser(req.params.id, req.session.userId);
  if (!order) return res.status(404).json({ error: 'Order not found.' });

  await db.query(
    'UPDATE orders SET skip_next_delivery_date = NULL WHERE id = $1',
    [order.id]
  );
  const updated = (await db.query('SELECT * FROM orders WHERE id = $1', [order.id])).rows[0];
  res.json({ order: updated });
});

// GET /api/orders/:id/schedule — upcoming delivery dates for this order
router.get('/:id/schedule', requireAuth, async (req, res) => {
  const order = await getActiveOrderForUser(req.params.id, req.session.userId);
  if (!order) return res.status(404).json({ error: 'Order not found.' });

  const count = Math.min(Math.max(parseInt(req.query.count, 10) || 6, 1), 24);
  const deliveries = schedule.upcomingDeliveries(order, count);
  res.json({
    deliveries,
    nextActive:      schedule.nextActiveDelivery(order),
    pausedUntil:     order.paused_until || null,
    skipNextDate:    order.skip_next_delivery_date || null,
    firstDelivery:   order.first_delivery_date || null,
    deliveryFrequency: order.delivery_frequency || DELIVERY_FREQUENCY
  });
});

// DELETE /api/orders/:id — cancel an order
router.delete('/:id', requireAuth, async (req, res) => {
  const order = (await db.query(
    'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
    [req.params.id, req.session.userId]
  )).rows[0];

  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  await db.query(
    "UPDATE orders SET status = 'cancelled' WHERE id = $1",
    [order.id]
  );

  res.json({ ok: true });
});

module.exports = router;
