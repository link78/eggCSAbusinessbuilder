const Stripe = require('stripe');
const db = require('./db');

// Keys read from environment variables at startup (highest priority).
// DB-stored keys are used as fallback when the env var is not set.
let _secretKey      = process.env.STRIPE_SECRET_KEY      || '';
let _publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';
let _stripe = _secretKey ? Stripe(_secretKey) : null;

function _rebuild() {
  _stripe = _secretKey ? Stripe(_secretKey) : null;
}

/**
 * Load Stripe keys from the `settings` table, using them as a fallback when
 * the corresponding environment variable is not set.  Call once after the DB
 * is ready (e.g. after `db.ready` resolves) and again whenever an admin saves
 * new keys via the admin API.
 */
async function loadFromDb() {
  try {
    const rows = (await db.query(
      "SELECT key, value FROM settings WHERE key IN ('stripe_secret_key', 'stripe_publishable_key')"
    )).rows;
    for (const row of rows) {
      if (row.key === 'stripe_secret_key' && !process.env.STRIPE_SECRET_KEY) {
        _secretKey = row.value;
      }
      if (row.key === 'stripe_publishable_key' && !process.env.STRIPE_PUBLISHABLE_KEY) {
        _publishableKey = row.value;
      }
    }
    _rebuild();
  } catch (_) {
    // DB may not be available during early startup — caller can retry.
  }
}

/**
 * Update in-memory keys directly (used by the admin API after persisting to DB).
 * Each parameter is optional; pass `undefined` to leave the existing value unchanged.
 */
function setKeys({ secretKey, publishableKey } = {}) {
  if (secretKey      !== undefined && secretKey      !== null) _secretKey      = secretKey;
  if (publishableKey !== undefined && publishableKey !== null) _publishableKey = publishableKey;
  _rebuild();
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
  if (!_stripe || !user) return null;
  if (user.stripe_customer_id) return user.stripe_customer_id;

  const customer = await _stripe.customers.create({
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

function isConfigured() {
  return Boolean(_stripe);
}

function getClient() {
  return _stripe;
}

function getPublishableKey() {
  return _publishableKey || null;
}

module.exports = {
  getClient,
  isConfigured,
  getPublishableKey,
  loadFromDb,
  setKeys,
  getBaseUrl,
  planKeyFromName,
  getConfiguredPriceId,
  ensureStripeCustomerForUser,
  getUserWithStripeCustomer,
  updateSubscriptionStatus
};
