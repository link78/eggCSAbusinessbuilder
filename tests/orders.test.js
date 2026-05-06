const { makeAgent } = require('./helpers');
const app = require('../app');

let agent;

beforeAll(async () => {
  agent = makeAgent(app);
  // Register and login a test user
  await agent.post('/api/auth/register', {
    name: 'Dana', email: 'dana@example.com', password: 'password123'
  });
});

// ── GET /api/orders/plans ─────────────────────────────────────────────────────

describe('GET /api/orders/plans', () => {
  it('returns all three plans', async () => {
    const res = await agent.get('/api/orders/plans');
    expect(res.status).toBe(200);
    expect(res.body.plans).toHaveLength(3);
    const names = res.body.plans.map(p => p.name);
    expect(names).toContain('Solo / Couple');
    expect(names).toContain('Small Family');
    expect(names).toContain('Family');
  });

  it('each plan has name, price, and eggsPerWeek', async () => {
    const res = await agent.get('/api/orders/plans');
    for (const plan of res.body.plans) {
      expect(plan).toHaveProperty('name');
      expect(plan).toHaveProperty('price');
      expect(plan).toHaveProperty('eggsPerWeek');
    }
  });
});

// ── GET /api/orders ───────────────────────────────────────────────────────────

describe('GET /api/orders', () => {
  it('requires authentication', async () => {
    const freshAgent = makeAgent(app);
    const res = await freshAgent.get('/api/orders');
    expect(res.status).toBe(401);
  });

  it('returns empty array for new user', async () => {
    const res = await agent.get('/api/orders');
    expect(res.status).toBe(200);
    expect(res.body.orders).toEqual([]);
  });
});

// ── POST /api/orders ──────────────────────────────────────────────────────────

describe('POST /api/orders', () => {
  it('places a pickup order', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Solo / Couple',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Wednesday'
    });
    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({
      plan_name: 'Solo / Couple',
      price: 26,
      eggs_per_week: 6,
      fulfillment_method: 'pickup',
      pickup_day: 'Wednesday',
      status: 'active'
    });
    expect(res.body.order.next_billing_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('places a delivery order', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Family',
      fulfillmentMethod: 'delivery',
      deliveryAddress: '123 Main St, Lincoln, NE'
    });
    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({
      plan_name: 'Family',
      price: 52,
      fulfillment_method: 'delivery',
      delivery_address: '123 Main St, Lincoln, NE'
    });
  });

  it('cancels the previous active order when placing a new one', async () => {
    // Place first order
    await agent.post('/api/orders', {
      planName: 'Solo / Couple',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Monday'
    });
    // Place second order — should cancel the first
    await agent.post('/api/orders', {
      planName: 'Small Family',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Friday'
    });

    const res = await agent.get('/api/orders');
    const active = res.body.orders.filter(o => o.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0].plan_name).toBe('Small Family');
  });

  it('rejects missing planName', async () => {
    const res = await agent.post('/api/orders', {
      fulfillmentMethod: 'pickup', pickupDay: 'Monday'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/planName/i);
  });

  it('rejects invalid plan name', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Platinum', fulfillmentMethod: 'pickup', pickupDay: 'Monday'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid plan/i);
  });

  it('rejects invalid fulfillmentMethod', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Family', fulfillmentMethod: 'drone'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/fulfillmentMethod/i);
  });

  it('rejects delivery order without deliveryAddress', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Family', fulfillmentMethod: 'delivery'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/deliveryAddress/i);
  });

  it('rejects pickup order with invalid pickupDay', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Family', fulfillmentMethod: 'pickup', pickupDay: 'Sunday'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pickupDay/i);
  });

  it('requires authentication', async () => {
    const freshAgent = makeAgent(app);
    const res = await freshAgent.post('/api/orders', {
      planName: 'Family', fulfillmentMethod: 'pickup', pickupDay: 'Monday'
    });
    expect(res.status).toBe(401);
  });
});

// ── DELETE /api/orders/:id ────────────────────────────────────────────────────

describe('DELETE /api/orders/:id', () => {
  it('cancels an order', async () => {
    const create = await agent.post('/api/orders', {
      planName: 'Solo / Couple',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Tuesday'
    });
    const orderId = create.body.order.id;

    const del = await agent.del(`/api/orders/${orderId}`);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    const list = await agent.get('/api/orders');
    const cancelled = list.body.orders.find(o => o.id === orderId);
    expect(cancelled.status).toBe('cancelled');
  });

  it('returns 404 for non-existent order', async () => {
    const res = await agent.del('/api/orders/99999');
    expect(res.status).toBe(404);
  });

  it('does not allow cancelling another user\'s order', async () => {
    // Create an order for the primary user
    const create = await agent.post('/api/orders', {
      planName: 'Solo / Couple',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Monday'
    });
    const orderId = create.body.order.id;

    // Try to cancel from a different user's session
    const otherAgent = makeAgent(app);
    await otherAgent.post('/api/auth/register', {
      name: 'Eve', email: 'eve@example.com', password: 'password123'
    });
    const res = await otherAgent.del(`/api/orders/${orderId}`);
    expect(res.status).toBe(404);
  });

  it('requires authentication', async () => {
    const freshAgent = makeAgent(app);
    const res = await freshAgent.del('/api/orders/1');
    expect(res.status).toBe(401);
  });
});

