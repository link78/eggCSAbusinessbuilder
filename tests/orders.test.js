const { makeAgent, resetDb, closeDb } = require('./helpers');
const app = require('../app');

let agent;

beforeAll(async () => {
  await resetDb();
  agent = makeAgent(app);
  await agent.post('/api/auth/register', {
    name: 'Dana', email: 'dana@example.com', password: 'password123'
  });
});

afterAll(async () => {
  await closeDb();
});

// ── GET /api/orders/plans ─────────────────────────────────────────────────────

describe('GET /api/orders/plans', () => {
  it('returns the two fixed plans (Small Family, Family)', async () => {
    const res = await agent.get('/api/orders/plans');
    expect(res.status).toBe(200);
    expect(res.body.plans).toHaveLength(2);
    const names = res.body.plans.map(p => p.name);
    expect(names).toContain('Small Family');
    expect(names).toContain('Family');
  });

  it('each plan has name, boxes, price12, price18, eggsPerWeek12, eggsPerWeek18', async () => {
    const res = await agent.get('/api/orders/plans');
    for (const plan of res.body.plans) {
      expect(plan).toHaveProperty('name');
      expect(plan).toHaveProperty('boxes');
      expect(plan).toHaveProperty('price12');
      expect(plan).toHaveProperty('price18');
      expect(plan).toHaveProperty('eggsPerWeek12');
      expect(plan).toHaveProperty('eggsPerWeek18');
    }
  });

  it('returns delivery fee per week', async () => {
    const res = await agent.get('/api/orders/plans');
    expect(res.body.deliveryFeePerWeek).toBe(2);
  });

  it('returns solo couple constraints', async () => {
    const res = await agent.get('/api/orders/plans');
    expect(res.body.soloCoupleConstraints).toMatchObject({
      minBoxes:      1,
      pricePerBox12: 5,
      pricePerBox18: 7
    });
  });

  it('returns custom plan constraints', async () => {
    const res = await agent.get('/api/orders/plans');
    expect(res.body.customPlan).toMatchObject({
      pricePerBox12: 5,
      pricePerBox18: 7,
      minBoxes:      1,
      minWeeks:      2
    });
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

  // ── Solo / Couple (flexible monthly) ────────────────────────────────────────

  it('places a Solo/Couple pickup order with one 12-egg box', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Solo / Couple',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Wednesday',
      boxes12: 1,
      boxes18: 0
    });
    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({
      plan_name:            'Solo / Couple',
      price:                10,   // 1×$5 × 2 deliveries
      eggs_per_week:        12,
      boxes12_per_delivery: 1,
      boxes18_per_delivery: 0,
      fulfillment_method:   'pickup',
      pickup_day:           'Wednesday',
      status:               'active'
    });
    expect(res.body.order.next_billing_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('places a Solo/Couple pickup order with one 18-egg box', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Solo / Couple',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Monday',
      boxes12: 0,
      boxes18: 1
    });
    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({
      price:                14,  // 1×$7 × 2 deliveries
      eggs_per_week:        18,
      boxes12_per_delivery: 0,
      boxes18_per_delivery: 1
    });
  });

  it('adds $2/delivery delivery fee to Solo/Couple delivery order', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Solo / Couple',
      fulfillmentMethod: 'delivery',
      deliveryAddress: '100 Test St, Lincoln NE',
      boxes12: 1,
      boxes18: 0
    });
    expect(res.status).toBe(200);
    // base = 1×$5 × 2 = $10, delivery fee = $2×2 = $4, total = $14
    expect(res.body.order.price).toBe(14);
  });

  it('rejects Solo/Couple order with no boxes selected', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Solo / Couple',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Monday',
      boxes12: 0,
      boxes18: 0
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least/i);
  });

  // ── Fixed plans (Small Family / Family) ──────────────────────────────────────

  it('places a fixed plan pickup order with default box type (Small Family → dozen)', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Small Family',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Friday'
    });
    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({
      plan_name:            'Small Family',
      price:                10,   // 1×$5 × 2 deliveries (dozen default)
      eggs_per_week:        12,
      boxes12_per_delivery: 1,
      boxes18_per_delivery: 0,
      boxes_per_delivery:   1,
      status:               'active'
    });
  });

  it('places Small Family order with explicit dozen box type', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Small Family',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Tuesday',
      boxType: 'dozen'
    });
    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({
      price:                10,
      eggs_per_week:        12,
      boxes12_per_delivery: 1,
      boxes18_per_delivery: 0
    });
  });

  it('places Small Family order with 18-egg box type', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Small Family',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Wednesday',
      boxType: '18'
    });
    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({
      price:                14,   // 1×$7 × 2 deliveries
      eggs_per_week:        18,
      boxes12_per_delivery: 0,
      boxes18_per_delivery: 1
    });
  });

  it('places Family order with default box type (Family → 18-egg)', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Family',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Thursday'
    });
    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({
      plan_name:            'Family',
      price:                14,   // 1×$7 × 2 deliveries (18-egg default)
      eggs_per_week:        18,
      boxes12_per_delivery: 0,
      boxes18_per_delivery: 1
    });
  });

  it('places Family order with dozen box type', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Family',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Monday',
      boxType: 'dozen'
    });
    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({
      price:                10,   // 1×$5 × 2 deliveries
      eggs_per_week:        12,
      boxes12_per_delivery: 1,
      boxes18_per_delivery: 0
    });
  });

  it('applies $2/delivery fee to a fixed plan delivery order', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Family',
      fulfillmentMethod: 'delivery',
      deliveryAddress: '123 Main St, Lincoln, NE'
      // defaults to 18-egg → $14 base + $4 delivery = $18
    });
    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({
      plan_name:        'Family',
      price:            18,   // $14 base + $2×2 delivery fee
      fulfillment_method: 'delivery',
      delivery_address: '123 Main St, Lincoln, NE'
    });
  });

  it('applies $2/delivery fee to fixed plan delivery order with dozen box type', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Small Family',
      fulfillmentMethod: 'delivery',
      deliveryAddress: '99 Oak Ave, Lincoln NE',
      boxType: 'dozen'
    });
    expect(res.status).toBe(200);
    // base = 1×$5 × 2 = $10, delivery fee = $2×2 = $4, total = $14
    expect(res.body.order.price).toBe(14);
  });

  // ── Custom plan (fully flexible) ─────────────────────────────────────────────

  it('places a Custom plan pickup order with mixed box sizes', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Custom',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Friday',
      boxes12: 1,
      boxes18: 1,
      durationWeeks: 4
    });
    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({
      plan_name:            'Custom',
      price:                48,  // (1×$5 + 1×$7) × 4 = $48
      eggs_per_week:        30,  // 1×12 + 1×18 = 30
      boxes12_per_delivery: 1,
      boxes18_per_delivery: 1,
      boxes_per_delivery:   2,
      duration_weeks:       4,
      status:               'active'
    });
  });

  it('places a Custom plan with only 18-egg boxes', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Custom',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Monday',
      boxes12: 0,
      boxes18: 3,
      durationWeeks: 2
    });
    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({
      price:                42,   // 3×$7 × 2 = $42
      eggs_per_week:        54,   // 3×18
      boxes12_per_delivery: 0,
      boxes18_per_delivery: 3
    });
  });

  it('adds $2/delivery fee to Custom plan delivery order', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Custom',
      fulfillmentMethod: 'delivery',
      deliveryAddress: '200 Elm St, Lincoln NE',
      boxes12: 1,
      boxes18: 1,
      durationWeeks: 4
    });
    expect(res.status).toBe(200);
    // base = $12/wk × 4 = $48, delivery fee = $2×4 = $8, total = $56
    expect(res.body.order.price).toBe(56);
  });

  it('rejects Custom plan with 0 boxes total', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Custom',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Monday',
      boxes12: 0,
      boxes18: 0,   // total = 0, below minimum 1
      durationWeeks: 2
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least/i);
  });

  it('places a Custom plan pickup order with a single 12-egg box', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Custom',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Monday',
      boxes12: 1,
      boxes18: 0,
      durationWeeks: 2
    });
    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({
      plan_name:            'Custom',
      price:                10,   // 1×$5 × 2 weeks
      eggs_per_week:        12,
      boxes12_per_delivery: 1,
      boxes18_per_delivery: 0
    });
  });

  it('places a Custom plan pickup order with a single 18-egg box', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Custom',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Tuesday',
      boxes12: 0,
      boxes18: 1,
      durationWeeks: 2
    });
    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({
      plan_name:            'Custom',
      price:                14,   // 1×$7 × 2 weeks
      eggs_per_week:        18,
      boxes12_per_delivery: 0,
      boxes18_per_delivery: 1
    });
  });

  it('rejects Custom plan with fewer than 2 weeks', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Custom',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Monday',
      boxes12: 1,
      boxes18: 1,
      durationWeeks: 1
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/durationWeeks/i);
  });

  // ── General validation ───────────────────────────────────────────────────────

  it('cancels the previous active order when placing a new one', async () => {
    await agent.post('/api/orders', {
      planName: 'Solo / Couple',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Monday',
      boxes12: 1, boxes18: 0
    });
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
      pickupDay: 'Tuesday',
      boxes12: 1, boxes18: 0
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

  it("does not allow cancelling another user's order", async () => {
    const create = await agent.post('/api/orders', {
      planName: 'Solo / Couple',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Monday',
      boxes12: 1, boxes18: 0
    });
    const orderId = create.body.order.id;

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

// ── Bi-weekly delivery rules ──────────────────────────────────────────────────

describe('Bi-weekly delivery subscription rules', () => {
  it('GET /api/orders/plans exposes biweekly cadence and minimum eggs/week', async () => {
    const res = await agent.get('/api/orders/plans');
    expect(res.status).toBe(200);
    expect(res.body.deliveryFrequency).toBe('biweekly');
    expect(res.body.weeksPerDelivery).toBe(2);
    expect(res.body.minEggsPerWeek).toBe(12);
  });

  it('persists delivery_frequency and eggs_per_delivery on a Solo/Couple order', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Solo / Couple',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Wednesday',
      boxes12: 1,
      boxes18: 0
    });
    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({
      eggs_per_week:      12,
      eggs_per_delivery:  24,        // 12 × 2 weeks
      delivery_frequency: 'biweekly'
    });
  });

  it('persists eggs_per_delivery=36 for an 18-egg Solo/Couple order', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Solo / Couple',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Monday',
      boxes12: 0,
      boxes18: 1
    });
    expect(res.status).toBe(200);
    expect(res.body.order.eggs_per_delivery).toBe(36); // 18 × 2
    expect(res.body.order.delivery_frequency).toBe('biweekly');
  });

  it('persists eggs_per_delivery for Custom plans with mixed box sizes', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Custom',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Friday',
      boxes12: 1,
      boxes18: 1,
      durationWeeks: 4
    });
    expect(res.status).toBe(200);
    expect(res.body.order.eggs_per_week).toBe(30);
    expect(res.body.order.eggs_per_delivery).toBe(60); // 30 × 2
  });

  it('persists eggs_per_delivery for fixed plans', async () => {
    const res = await agent.post('/api/orders', {
      planName: 'Family',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Thursday'
    });
    expect(res.status).toBe(200);
    expect(res.body.order.eggs_per_delivery).toBe(36); // 18 × 2
    expect(res.body.order.delivery_frequency).toBe('biweekly');
  });
});

// ── Plan-config exposes biweekly metadata ─────────────────────────────────────

describe('GET /api/plan-config bi-weekly fields', () => {
  it('every default plan has delivery_frequency=biweekly and eggs_per_delivery = eggs_per_week × 2', async () => {
    const res = await agent.get('/api/plan-config');
    expect(res.status).toBe(200);
    expect(res.body.plans.length).toBeGreaterThan(0);
    for (const plan of res.body.plans) {
      expect(plan.delivery_frequency).toBe('biweekly');
      expect(plan.eggs_per_delivery).toBe(plan.eggs_per_week * 2);
    }
  });
});

