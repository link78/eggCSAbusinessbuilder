const Stripe = require('stripe');
const db = require('./db');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;

function isConfigured() {
  return Boolean(stripe);
}

function getClient() {
  return stripe;
}

function getBaseUrl(req) {
  const configured = process.env.APP_URL || process.env.BASE_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function planKeyFromName(planName) {
  let key = '';
  let previousWasSeparator = true;
  for (const char of String(planName || '').trim().toLowerCase()) {
    if ((char >= 'a' && char <= 'z') || (char >= '0' && char <= '9')) {
      key += char;
      previousWasSeparator = false;
    } else if (!previousWasSeparator) {
      key += '_';
      previousWasSeparator = true;
    }
  }
  return key.endsWith('_') ? key.slice(0, -1) : key;
}

function priceEnvName(planKey) {
  return `STRIPE_PRICE_${String(planKey || '').toUpperCase()}`;
}

function getConfiguredPriceId(planId, planName) {
  const key = planId || planKeyFromName(planName);
  return process.env[priceEnvName(key)] || null;
}

async function ensureStripeCustomerForUser(user) {
  if (!stripe || !user) return null;
  if (user.stripe_customer_id) return user.stripe_customer_id;

  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name,
    metadata: { user_id: String(user.id) }
  });

  await db.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customer.id, user.id]);
  return customer.id;
}

async function getUserWithStripeCustomer(userId) {
  const user = (await db.query(
    'SELECT id, name, email, stripe_customer_id FROM users WHERE id = $1',
    [userId]
  )).rows[0];
  if (!user) return null;
  user.stripe_customer_id = await ensureStripeCustomerForUser(user);
  return user;
}

async function updateSubscriptionStatus({ customerId, subscriptionId, priceId, status }) {
  if (!customerId && !subscriptionId) return;

  if (subscriptionId) {
    const result = await db.query(
      `UPDATE orders
       SET status = $1,
           stripe_subscription_id = COALESCE($2, stripe_subscription_id),
           stripe_price_id = COALESCE($3, stripe_price_id)
       WHERE stripe_subscription_id = $2`,
      [status, subscriptionId, priceId || null]
    );
    if (result.rowCount > 0) return;
  }

  if (customerId) {
    await db.query(
      `UPDATE orders
       SET status = $1,
           stripe_subscription_id = COALESCE($2, stripe_subscription_id),
           stripe_price_id = COALESCE($3, stripe_price_id)
       WHERE id = (
         SELECT o.id
         FROM orders o
         JOIN users u ON u.id = o.user_id
         WHERE u.stripe_customer_id = $4
           AND ($2::text IS NULL OR o.stripe_subscription_id IS NULL OR o.stripe_subscription_id = $2)
         ORDER BY
           CASE WHEN o.status = 'pending' THEN 0 WHEN o.status = 'active' THEN 1 ELSE 2 END,
           o.created_at DESC
         LIMIT 1
       )`,
      [status, subscriptionId || null, priceId || null, customerId]
    );
  }
}

function getPublishableKey() {
  return STRIPE_PUBLISHABLE_KEY || null;
}

module.exports = {
  getClient,
  isConfigured,
  getPublishableKey,
  getBaseUrl,
  planKeyFromName,
  getConfiguredPriceId,
  ensureStripeCustomerForUser,
  getUserWithStripeCustomer,
  updateSubscriptionStatus
};
