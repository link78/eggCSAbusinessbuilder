const { makeAgent, resetDb, closeDb } = require('./helpers');

jest.mock('../stripe', () => {
  const checkoutCreate = jest.fn(async () => ({ url: 'https://checkout.stripe.test/session' }));
  const portalCreate = jest.fn(async () => ({ url: 'https://billing.stripe.test/session' }));
  return {
    getClient: jest.fn(() => ({
      checkout: { sessions: { create: checkoutCreate } },
      billingPortal: { sessions: { create: portalCreate } }
    })),
    isConfigured: jest.fn(() => true),
    getBaseUrl: jest.fn(() => 'http://localhost:3000'),
    planKeyFromName: jest.fn(name => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')),
    getConfiguredPriceId: jest.fn(() => 'price_family_test'),
    ensureStripeCustomerForUser: jest.fn(async user => {
      const db = require('../db');
      await db.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', ['cus_test_123', user.id]);
      return 'cus_test_123';
    }),
    getUserWithStripeCustomer: jest.fn(async userId => ({
      id: userId,
      name: 'Billing User',
      email: 'billing@example.com',
      stripe_customer_id: 'cus_test_123'
    })),
    updateSubscriptionStatus: jest.fn(async () => {}),
    __checkoutCreate: checkoutCreate,
    __portalCreate: portalCreate
  };
});

const request = require('supertest');
const stripe = require('../stripe');
const app = require('../app');
const db = require('../db');

let agent;

beforeAll(async () => {
  await resetDb();
  agent = makeAgent(app);
});

afterAll(async () => {
  await closeDb();
});

describe('Stripe customer registration', () => {
  it('creates and stores a Stripe customer when registering', async () => {
    const res = await agent.post('/api/auth/register', {
      name: 'Billing User',
      email: 'billing@example.com',
      password: 'password123'
    });

    expect(res.status).toBe(200);
    expect(stripe.ensureStripeCustomerForUser).toHaveBeenCalled();

    const row = (await db.query('SELECT stripe_customer_id FROM users WHERE email = $1', ['billing@example.com'])).rows[0];
    expect(row.stripe_customer_id).toBe('cus_test_123');
  });
});

describe('POST /create-checkout-session', () => {
  it('creates a pending order and returns a Stripe Checkout URL (one-time payment)', async () => {
    const res = await agent.post('/create-checkout-session', {
      user_id: 1,
      plan_id: 'solo_couple',
      planName: 'Solo / Couple',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Thursday',
      boxes12: 1,
      boxes18: 0
    });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://checkout.stripe.test/session');
    expect(stripe.__checkoutCreate).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'payment',
      customer: 'cus_test_123',
      line_items: [{ price: 'price_family_test', quantity: 1 }]
    }));

    const order = (await db.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [1])).rows[0];
    expect(order).toMatchObject({
      plan_name: 'Solo / Couple',
      status: 'pending',
      stripe_price_id: 'price_family_test'
    });
  });

  it('rejects checkout for a different user_id', async () => {
    const res = await agent.post('/create-checkout-session', {
      user_id: 999,
      plan_id: 'solo_couple',
      planName: 'Solo / Couple',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Thursday',
      boxes12: 1,
      boxes18: 0
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /billing-portal', () => {
  it('redirects to a Stripe customer portal session', async () => {
    const res = await agent.get('/billing-portal');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://billing.stripe.test/session');
    expect(stripe.__portalCreate).toHaveBeenCalledWith(expect.objectContaining({
      customer: 'cus_test_123',
      return_url: 'http://localhost:3000/dashboard'
    }));
  });
});

describe('POST /webhook', () => {
  it('handles invoice payment success events', async () => {
    const event = {
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          customer: 'cus_test_123',
          subscription: 'sub_test_123',
          lines: { data: [{ price: { id: 'price_family_test' } }] }
        }
      }
    };

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event));

    expect(res.status).toBe(200);
    expect(stripe.updateSubscriptionStatus).toHaveBeenCalledWith({
      customerId: 'cus_test_123',
      subscriptionId: 'sub_test_123',
      priceId: 'price_family_test',
      status: 'active'
    });
  });
});
