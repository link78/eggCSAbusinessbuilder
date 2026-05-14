const { makeAgent, resetDb, closeDb } = require('./helpers');
const app = require('../app');
const db  = require('../db');

let agent;
let orderId;

async function createActiveOrder() {
  // Solo / Couple plan with 2 dozen-egg boxes — 24 eggs/week, satisfies the
  // 12-eggs/week minimum.
  const res = await agent.post('/api/orders', {
    planName: 'Solo / Couple',
    fulfillmentMethod: 'pickup',
    pickupDay: 'Tuesday',
    boxes12: 2,
    boxes18: 0
  });
  return res.body.order.id;
}

beforeAll(async () => {
  await resetDb();
  agent = makeAgent(app);
  await agent.post('/api/auth/register', {
    name: 'Pam', email: 'pam@example.com', password: 'password123'
  });
  orderId = await createActiveOrder();
});

afterAll(async () => {
  await closeDb();
});

// ── GET /api/orders/:id/schedule ─────────────────────────────────────────────

describe('GET /api/orders/:id/schedule', () => {
  it('requires authentication', async () => {
    const fresh = makeAgent(app);
    const res = await fresh.get(`/api/orders/${orderId}/schedule`);
    expect(res.status).toBe(401);
  });

  it('returns upcoming biweekly delivery dates', async () => {
    const res = await agent.get(`/api/orders/${orderId}/schedule`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.deliveries)).toBe(true);
    expect(res.body.deliveries.length).toBe(6);
    expect(res.body.nextActive).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Each subsequent delivery is exactly 14 days after the previous one.
    const dates = res.body.deliveries.map(d => new Date(d.date + 'T00:00:00Z'));
    for (let i = 1; i < dates.length; i++) {
      const diffDays = (dates[i] - dates[i - 1]) / (24 * 60 * 60 * 1000);
      expect(diffDays).toBe(14);
    }
  });

  it('honors the `count` query parameter (capped at 24)', async () => {
    const res = await agent.get(`/api/orders/${orderId}/schedule?count=3`);
    expect(res.body.deliveries.length).toBe(3);

    const res2 = await agent.get(`/api/orders/${orderId}/schedule?count=999`);
    expect(res2.body.deliveries.length).toBe(24);
  });

  it('returns 404 for orders not owned by the user', async () => {
    const stranger = makeAgent(app);
    await stranger.post('/api/auth/register', {
      name: 'Stranger', email: 'stranger@example.com', password: 'password123'
    });
    const res = await stranger.get(`/api/orders/${orderId}/schedule`);
    expect(res.status).toBe(404);
  });
});

// ── POST /api/orders/:id/pause ────────────────────────────────────────────────

describe('POST /api/orders/:id/pause', () => {
  it('rejects malformed dates', async () => {
    const res = await agent.post(`/api/orders/${orderId}/pause`, { pausedUntil: 'not-a-date' });
    expect(res.status).toBe(400);
  });

  it('rejects past dates', async () => {
    const res = await agent.post(`/api/orders/${orderId}/pause`, { pausedUntil: '2000-01-01' });
    expect(res.status).toBe(400);
  });

  it('rejects pause dates more than 1 year out', async () => {
    const future = new Date();
    future.setUTCFullYear(future.getUTCFullYear() + 2);
    const res = await agent.post(`/api/orders/${orderId}/pause`, {
      pausedUntil: future.toISOString().slice(0, 10)
    });
    expect(res.status).toBe(400);
  });

  it('pauses an active subscription and the schedule reflects it', async () => {
    const future = new Date();
    future.setUTCMonth(future.getUTCMonth() + 1);
    const isoFuture = future.toISOString().slice(0, 10);

    const pauseRes = await agent.post(`/api/orders/${orderId}/pause`, { pausedUntil: isoFuture });
    expect(pauseRes.status).toBe(200);
    expect(pauseRes.body.order.paused_until).toBe(isoFuture);

    const schedRes = await agent.get(`/api/orders/${orderId}/schedule`);
    // At least the first delivery within the pause window should be skipped.
    const inPauseWindow = schedRes.body.deliveries.filter(d => d.date <= isoFuture);
    expect(inPauseWindow.length).toBeGreaterThan(0);
    expect(inPauseWindow.every(d => d.skipped === true)).toBe(true);
  });

  it('resume clears the pause', async () => {
    const res = await agent.post(`/api/orders/${orderId}/resume`, {});
    expect(res.status).toBe(200);
    expect(res.body.order.paused_until).toBeNull();
  });
});

// ── POST /api/orders/:id/skip ────────────────────────────────────────────────

describe('POST /api/orders/:id/skip', () => {
  it('skips a single upcoming delivery', async () => {
    const sched = await agent.get(`/api/orders/${orderId}/schedule`);
    const target = sched.body.deliveries[1].date;  // second upcoming date
    const res = await agent.post(`/api/orders/${orderId}/skip`, { deliveryDate: target });
    expect(res.status).toBe(200);
    expect(res.body.order.skip_next_delivery_date).toBe(target);

    const sched2 = await agent.get(`/api/orders/${orderId}/schedule`);
    const slot = sched2.body.deliveries.find(d => d.date === target);
    expect(slot.skipped).toBe(true);
  });

  it('rejects dates not in the upcoming schedule', async () => {
    const res = await agent.post(`/api/orders/${orderId}/skip`, { deliveryDate: '2099-12-31' });
    expect(res.status).toBe(400);
  });

  it('unskip clears the single-delivery skip', async () => {
    const res = await agent.post(`/api/orders/${orderId}/unskip`, {});
    expect(res.status).toBe(200);
    expect(res.body.order.skip_next_delivery_date).toBeNull();
  });
});

// ── New orders set first_delivery_date ───────────────────────────────────────

describe('POST /api/orders sets first_delivery_date', () => {
  it('records a first_delivery_date 7 days out', async () => {
    // Create a fresh user to avoid cancelling the existing order
    const a = makeAgent(app);
    await a.post('/api/auth/register', {
      name: 'Q', email: 'q@example.com', password: 'password123'
    });
    const res = await a.post('/api/orders', {
      planName: 'Solo / Couple', fulfillmentMethod: 'pickup',
      pickupDay: 'Friday', boxes12: 1, boxes18: 0
    });
    expect(res.status).toBe(200);
    expect(res.body.order.first_delivery_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Approximately 7 days from today (allow 1-day fuzz for test execution
    // around midnight UTC).
    const today = new Date();
    const target = new Date(res.body.order.first_delivery_date + 'T00:00:00Z');
    const diffDays = (target - new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))) / (24*60*60*1000);
    expect(diffDays).toBeGreaterThanOrEqual(6);
    expect(diffDays).toBeLessThanOrEqual(8);
  });
});

// ── Cancelled orders return empty schedule ───────────────────────────────────

describe('cancelled order schedule', () => {
  it('returns an empty deliveries list once cancelled', async () => {
    const a = makeAgent(app);
    await a.post('/api/auth/register', {
      name: 'Z', email: 'z@example.com', password: 'password123'
    });
    const ord = (await a.post('/api/orders', {
      planName: 'Solo / Couple', fulfillmentMethod: 'pickup',
      pickupDay: 'Friday', boxes12: 1, boxes18: 0
    })).body.order;
    await a.del(`/api/orders/${ord.id}`);
    const res = await a.get(`/api/orders/${ord.id}/schedule`);
    expect(res.body.deliveries).toEqual([]);
    expect(res.body.nextActive).toBeNull();
  });
});
