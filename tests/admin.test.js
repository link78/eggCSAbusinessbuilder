const { makeAgent, resetDb, closeDb } = require('./helpers');
const app = require('../app');

let adminAgent;
let userAgent;
let sharedOrderId;

beforeAll(async () => {
  await resetDb();

  // Create an admin user
  adminAgent = makeAgent(app);
  await adminAgent.post('/api/auth/register', {
    name: 'Admin', email: 'admin@example.com', password: 'adminpass123'
  });
  // Manually promote to admin via the DB directly
  const db = require('../db');
  await db.query("UPDATE users SET role = 'admin' WHERE email = $1", ['admin@example.com']);

  // Create a regular user with an order
  userAgent = makeAgent(app);
  await userAgent.post('/api/auth/register', {
    name: 'Bob', email: 'bob@example.com', password: 'password123'
  });
  const orderRes = await userAgent.post('/api/orders', {
    planName: 'Solo / Couple',
    fulfillmentMethod: 'pickup',
    pickupDay: 'Monday',
    boxes12: 1,
    boxes18: 0
  });
  sharedOrderId = orderRes.body.order.id;
});

afterAll(async () => {
  await closeDb();
});

// ── GET /api/admin/orders ─────────────────────────────────────────────────────

describe('GET /api/admin/orders', () => {
  it('requires authentication', async () => {
    const fresh = makeAgent(app);
    const res = await fresh.get('/api/admin/orders');
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users', async () => {
    const res = await userAgent.get('/api/admin/orders');
    expect(res.status).toBe(403);
  });

  it('returns all orders with user_name and user_email', async () => {
    const res = await adminAgent.get('/api/admin/orders');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.orders)).toBe(true);
    expect(res.body.orders.length).toBeGreaterThan(0);
    const o = res.body.orders.find(x => x.id === sharedOrderId);
    expect(o).toBeDefined();
    expect(o.user_name).toBe('Bob');
    expect(o.user_email).toBe('bob@example.com');
    expect(o.plan_name).toBe('Solo / Couple');
  });
});

// ── PUT /api/admin/orders/:id ─────────────────────────────────────────────────

describe('PUT /api/admin/orders/:id', () => {
  it('requires authentication', async () => {
    const fresh = makeAgent(app);
    const res = await fresh.put(`/api/admin/orders/${sharedOrderId}`, { status: 'cancelled' });
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users', async () => {
    const res = await userAgent.put(`/api/admin/orders/${sharedOrderId}`, { status: 'cancelled' });
    expect(res.status).toBe(403);
  });

  it('returns 404 for non-existent order', async () => {
    const res = await adminAgent.put('/api/admin/orders/99999', { status: 'active' });
    expect(res.status).toBe(404);
  });

  it('rejects invalid status value', async () => {
    const res = await adminAgent.put(`/api/admin/orders/${sharedOrderId}`, { status: 'pending' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/status/i);
  });

  it('updates plan_name', async () => {
    const res = await adminAgent.put(`/api/admin/orders/${sharedOrderId}`, { plan_name: 'Custom' });
    expect(res.status).toBe(200);
    expect(res.body.order.plan_name).toBe('Custom');
  });

  it('updates status to cancelled', async () => {
    const res = await adminAgent.put(`/api/admin/orders/${sharedOrderId}`, { status: 'cancelled' });
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('cancelled');
  });

  it('can set status back to active', async () => {
    const res = await adminAgent.put(`/api/admin/orders/${sharedOrderId}`, { status: 'active' });
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('active');
  });
});

// ── DELETE /api/admin/orders/:id ──────────────────────────────────────────────

describe('DELETE /api/admin/orders/:id', () => {
  let cancelOrderId;

  beforeAll(async () => {
    // Create a fresh order to cancel
    const r = await userAgent.post('/api/orders', {
      planName: 'Solo / Couple',
      fulfillmentMethod: 'pickup',
      pickupDay: 'Friday',
      boxes12: 1,
      boxes18: 0
    });
    cancelOrderId = r.body.order.id;
  });

  it('requires authentication', async () => {
    const fresh = makeAgent(app);
    const res = await fresh.del(`/api/admin/orders/${cancelOrderId}`);
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users', async () => {
    const res = await userAgent.del(`/api/admin/orders/${cancelOrderId}`);
    expect(res.status).toBe(403);
  });

  it('returns 404 for non-existent order', async () => {
    const res = await adminAgent.del('/api/admin/orders/99999');
    expect(res.status).toBe(404);
  });

  it('cancels the order', async () => {
    const res = await adminAgent.del(`/api/admin/orders/${cancelOrderId}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify it is now cancelled
    const list = await adminAgent.get('/api/admin/orders');
    const o = list.body.orders.find(x => x.id === cancelOrderId);
    expect(o.status).toBe('cancelled');
  });
});

// ── PUT /api/admin/users/:id/notes ────────────────────────────────────────────

describe('PUT /api/admin/users/:id/notes', () => {
  let bobId;

  beforeAll(async () => {
    const res = await adminAgent.get('/api/admin/users');
    const bob = res.body.users.find(u => u.email === 'bob@example.com');
    bobId = bob.id;
  });

  it('requires authentication', async () => {
    const fresh = makeAgent(app);
    const res = await fresh.put(`/api/admin/users/${bobId}/notes`, { notes: 'test' });
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users', async () => {
    const res = await userAgent.put(`/api/admin/users/${bobId}/notes`, { notes: 'test' });
    expect(res.status).toBe(403);
  });

  it('returns 404 for non-existent user', async () => {
    const res = await adminAgent.put('/api/admin/users/99999/notes', { notes: 'test' });
    expect(res.status).toBe(404);
  });

  it('saves notes and they appear in the user profile', async () => {
    const notes = 'Prefers Saturday pickup. Allergic to feathers.';
    const putRes = await adminAgent.put(`/api/admin/users/${bobId}/notes`, { notes });
    expect(putRes.status).toBe(200);
    expect(putRes.body.ok).toBe(true);

    const getRes = await adminAgent.get(`/api/admin/users/${bobId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.user.notes).toBe(notes);
  });

  it('can clear notes by sending an empty string', async () => {
    await adminAgent.put(`/api/admin/users/${bobId}/notes`, { notes: 'some notes' });
    const putRes = await adminAgent.put(`/api/admin/users/${bobId}/notes`, { notes: '' });
    expect(putRes.status).toBe(200);

    const getRes = await adminAgent.get(`/api/admin/users/${bobId}`);
    expect(getRes.body.user.notes).toBe('');
  });

  it('treats missing notes body as empty string', async () => {
    await adminAgent.put(`/api/admin/users/${bobId}/notes`, { notes: 'existing' });
    const putRes = await adminAgent.put(`/api/admin/users/${bobId}/notes`, {});
    expect(putRes.status).toBe(200);

    const getRes = await adminAgent.get(`/api/admin/users/${bobId}`);
    expect(getRes.body.user.notes).toBe('');
  });
});
