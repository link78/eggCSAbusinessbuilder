const express = require('express');
const db = require('../db');
const stripeService = require('../stripe');

const router = express.Router();

const PRICE_PER_12_BOX = 5;
const PRICE_PER_18_BOX = 7;
const DELIVERY_FEE_PER_WEEK = 2;
const MONTHLY_WEEKS = 2;
const DELIVERY_FREQUENCY = 'biweekly';
const WEEKS_PER_DELIVERY = 2;
const FIXED_PLANS = {
  'Small Family': { boxes: 1 },
  'Family': { boxes: 1 }
};
const PLAN_ID_TO_NAME = {
  small_family: 'Small Family',
  family: 'Family',
  solo_couple: 'Solo / Couple',
  custom: 'Custom'
};
const VALID_PICKUP_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'You must be logged in.' });
  next();
}

function requireCsrf(req, res, next) {
  const token = req.headers['x-csrf-token'];
  if (!token || token !== req.session.csrfToken) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token.' });
  }
  next();
}

function nextBillingDate() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return d.toISOString().slice(0, 10);
}

function normalizePlanName(body) {
  if (body.planName && body.plan_id) {
    const mappedName = PLAN_ID_TO_NAME[String(body.plan_id).trim()];
    if (mappedName && mappedName !== String(body.planName)) {
      throw Object.assign(new Error('plan_id does not match planName.'), { status: 400 });
    }
  }
  if (body.planName) return String(body.planName);
  return PLAN_ID_TO_NAME[String(body.plan_id || '').trim()] || '';
}

function calculateOrder(body) {
  const planName = normalizePlanName(body);
  if (!planName) throw Object.assign(new Error('plan_id or planName is required.'), { status: 400 });

  const method = String(body.fulfillmentMethod || body.fulfillment_method || '').toLowerCase();
  if (method !== 'pickup' && method !== 'delivery') {
    throw Object.assign(new Error('fulfillmentMethod must be "pickup" or "delivery".'), { status: 400 });
  }

  const deliveryAddress = body.deliveryAddress || body.delivery_address;
  const pickupDay = body.pickupDay || body.pickup_day;
  if (method === 'delivery' && (!deliveryAddress || !String(deliveryAddress).trim())) {
    throw Object.assign(new Error('deliveryAddress is required for delivery orders.'), { status: 400 });
  }
  if (method === 'pickup' && (!pickupDay || !VALID_PICKUP_DAYS.includes(pickupDay))) {
    throw Object.assign(new Error(`pickupDay must be one of: ${VALID_PICKUP_DAYS.join(', ')}.`), { status: 400 });
  }

  let price, eggsPerWeek, b12, b18, weeks, totalBoxes;
  if (planName === 'Solo / Couple') {
    b12 = Math.max(0, parseInt(body.boxes12, 10) || 0);
    b18 = Math.max(0, parseInt(body.boxes18, 10) || 0);
    totalBoxes = b12 + b18;
    if (totalBoxes < 1) throw Object.assign(new Error('Solo / Couple plan requires at least 1 box.'), { status: 400 });
    weeks = null;
    eggsPerWeek = b12 * 12 + b18 * 18;
    price = (b12 * PRICE_PER_12_BOX + b18 * PRICE_PER_18_BOX) * MONTHLY_WEEKS;
  } else if (planName === 'Custom') {
    b12 = Math.max(0, parseInt(body.boxes12, 10) || 0);
    b18 = Math.max(0, parseInt(body.boxes18, 10) || 0);
    totalBoxes = b12 + b18;
    weeks = parseInt(body.durationWeeks, 10);
    if (totalBoxes < 1) throw Object.assign(new Error('Custom plan requires at least 1 box.'), { status: 400 });
    if (!Number.isInteger(weeks) || weeks < 2) throw Object.assign(new Error('durationWeeks must be at least 2.'), { status: 400 });
    eggsPerWeek = b12 * 12 + b18 * 18;
    price = (b12 * PRICE_PER_12_BOX + b18 * PRICE_PER_18_BOX) * weeks;
  } else {
    const plan = FIXED_PLANS[planName];
    if (!plan) throw Object.assign(new Error('Invalid plan name.'), { status: 400 });
    const rawBoxType = String(body.boxType || '').toLowerCase();
    const boxType = (rawBoxType === 'dozen' || rawBoxType === '18')
      ? rawBoxType
      : (planName === 'Small Family' ? 'dozen' : '18');
    b12 = boxType === 'dozen' ? plan.boxes : 0;
    b18 = boxType === '18' ? plan.boxes : 0;
    totalBoxes = plan.boxes;
    weeks = null;
    eggsPerWeek = b12 * 12 + b18 * 18;
    price = (b12 * PRICE_PER_12_BOX + b18 * PRICE_PER_18_BOX) * MONTHLY_WEEKS;
  }

  if (method === 'delivery') {
    price += DELIVERY_FEE_PER_WEEK * (weeks || MONTHLY_WEEKS);
  }

  return {
    planName,
    price,
    eggsPerWeek,
    method,
    deliveryAddress: method === 'delivery' ? String(deliveryAddress).trim() : null,
    pickupDay: method === 'pickup' ? pickupDay : null,
    totalBoxes,
    weeks,
    b12,
    b18,
    eggsPerDelivery: eggsPerWeek * WEEKS_PER_DELIVERY
  };
}

async function createPendingOrder(userId, body, stripePriceId) {
  const order = calculateOrder(body);
  await db.query(
    "UPDATE orders SET status = 'cancelled' WHERE user_id = $1 AND status IN ('active', 'pending')",
    [userId]
  );
  const inserted = (await db.query(`
    INSERT INTO orders
      (user_id, plan_name, price, eggs_per_week, status,
       fulfillment_method, delivery_address, pickup_day, next_billing_date,
       boxes_per_delivery, duration_weeks, boxes12_per_delivery, boxes18_per_delivery,
       delivery_frequency, eggs_per_delivery, stripe_price_id)
    VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    RETURNING *
  `, [
    userId, order.planName, order.price, order.eggsPerWeek,
    order.method, order.deliveryAddress, order.pickupDay, nextBillingDate(),
    order.totalBoxes, order.weeks, order.b12, order.b18,
    DELIVERY_FREQUENCY, order.eggsPerDelivery, stripePriceId
  ])).rows[0];
  return inserted;
}

router.get('/stripe-config', (req, res) => {
  res.json({ publishableKey: stripeService.getPublishableKey() });
});

router.post('/create-checkout-session', requireAuth, requireCsrf, async (req, res) => {
  if (!stripeService.isConfigured()) {
    return res.status(503).json({ error: 'Stripe is not configured.' });
  }
  if (req.body.user_id && Number(req.body.user_id) !== Number(req.session.userId)) {
    return res.status(403).json({ error: 'Cannot create checkout for another user.' });
  }

  try {
    const client = stripeService.getClient();
    const planName = normalizePlanName(req.body);
    const planId = req.body.plan_id || stripeService.planKeyFromName(planName);
    const priceId = stripeService.getConfiguredPriceId(planId, planName);
    const user = await stripeService.getUserWithStripeCustomer(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const order = await createPendingOrder(user.id, req.body, priceId);
    const baseUrl = stripeService.getBaseUrl(req);
    const lineItem = priceId
      ? { price: priceId, quantity: 1 }
      : {
          price_data: {
            currency: 'usd',
            product_data: { name: order.plan_name },
            recurring: { interval: 'month' },
            unit_amount: Math.round(Number(order.price) * 100)
          },
          quantity: 1
        };

    const session = await client.checkout.sessions.create({
      mode: 'subscription',
      customer: user.stripe_customer_id,
      line_items: [lineItem],
      success_url: `${baseUrl}/dashboard?checkout=success`,
      cancel_url: `${baseUrl}/dashboard?checkout=cancelled`,
      metadata: {
        user_id: String(user.id),
        order_id: String(order.id),
        plan_id: String(planId || ''),
        plan_name: order.plan_name
      },
      subscription_data: {
        metadata: {
          user_id: String(user.id),
          order_id: String(order.id),
          plan_id: String(planId || '')
        }
      }
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not create checkout session.' });
  }
});

router.get('/billing-portal', requireAuth, async (req, res) => {
  if (!stripeService.isConfigured()) {
    return res.redirect('/dashboard?billing_error=stripe_not_configured');
  }
  try {
    const user = await stripeService.getUserWithStripeCustomer(req.session.userId);
    if (!user) return res.status(404).send('User not found.');
    const baseUrl = stripeService.getBaseUrl(req);
    const session = await stripeService.getClient().billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${baseUrl}/dashboard`
    });
    res.redirect(session.url);
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') console.error('Billing portal error:', err);
    res.status(500).send('Unable to access billing portal. Please try again or contact support.');
  }
});

function subscriptionInfoFromEvent(event) {
  const object = event.data.object;
  if (event.type === 'invoice.payment_succeeded' || event.type === 'invoice.payment_failed') {
    return {
      customerId: object.customer && typeof object.customer === 'object' ? object.customer.id : object.customer,
      subscriptionId: object.subscription && typeof object.subscription === 'object' ? object.subscription.id : object.subscription,
      priceId: object.lines?.data?.[0]?.price?.id,
      status: event.type === 'invoice.payment_succeeded' ? 'active' : 'past_due'
    };
  }
  const price = object.items?.data?.[0]?.price;
  return {
    customerId: object.customer && typeof object.customer === 'object' ? object.customer.id : object.customer,
    subscriptionId: object.id,
    priceId: price?.id,
    status: event.type === 'customer.subscription.deleted' ? 'cancelled' : object.status
  };
}

async function webhookHandler(req, res) {
  let event;
  const client = stripeService.getClient();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  try {
    if (client && webhookSecret) {
      event = client.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret);
    } else if (process.env.NODE_ENV === 'production') {
      return res.status(500).send('Webhook secret is not configured.');
    } else {
      event = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body));
    }
  } catch (err) {
    return res.status(400).send('Webhook Error');
  }

  if ([
    'invoice.payment_succeeded',
    'invoice.payment_failed',
    'customer.subscription.updated',
    'customer.subscription.deleted'
  ].includes(event.type)) {
    await stripeService.updateSubscriptionStatus(subscriptionInfoFromEvent(event));
  }

  res.json({ received: true });
}

module.exports = { router, webhookHandler };
