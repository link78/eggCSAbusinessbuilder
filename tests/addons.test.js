const { makeAgent, resetDb, closeDb } = require('./helpers');
const app = require('../app');
const db  = require('../db');

let customer, admin;
let orderId, addonA, addonB;

beforeAll(async () => {
  await resetDb();

  admin = makeAgent(app);
  await admin.post('/api/auth/register', {
    name: 'A', email: 'admin2@example.com', password: 'password123'
  });
  await db.query("UPDATE users SET role = 'admin' WHERE email = 'admin2@example.com'");

  customer = makeAgent(app);
  await customer.post('/api/auth/register', {
    name: 'Cust', email: 'cust@example.com', password: 'password123'
  });
  orderId = (await customer.post('/api/orders', {
    planName: 'Solo / Couple', fulfillmentMethod: 'pickup',
    pickupDay: 'Saturday', boxes12: 1, boxes18: 0
  })).body.order.id;
});

afterAll(async () => {
  await closeDb();
});

// ── Admin CRUD ──────────────────────────────────────────────────────────────

describe('admin add-on CRUD', () => {
  it('rejects non-admins from creating add-ons', async () => {
    const res = await customer.post('/api/admin/addons', {
      name: 'Honey', priceCents: 800
    });
    expect(res.status).toBe(403);
  });

  it('validates input', async () => {
    const r1 = await admin.post('/api/admin/addons', { name: '', priceCents: 100 });
    expect(r1.status).toBe(400);
    const r2 = await admin.post('/api/admin/addons', { name: 'Honey', priceCents: -1 });
    expect(r2.status).toBe(400);
    const r3 = await admin.post('/api/admin/addons', { name: 'Honey', priceCents: 999999 });
    expect(r3.status).toBe(400);
  });

  it('creates add-ons', async () => {
    const r1 = await admin.post('/api/admin/addons', {
      name: 'Wildflower Honey', description: 'From our farm', priceCents: 800, photoUrl: '/uploads/honey.jpg'
    });
    expect(r1.status).toBe(201);
    addonA = r1.body.addon;
    expect(addonA.price_cents).toBe(800);
    expect(addonA.active).toBe(true);

    const r2 = await admin.post('/api/admin/addons', {
      name: 'Strawberry Jam', priceCents: 600, active: false
    });
    expect(r2.status).toBe(201);
    addonB = r2.body.addon;
    expect(addonB.active).toBe(false);
  });

  it('updates add-ons (partial)', async () => {
    const res = await admin.put(`/api/admin/addons/${addonA.id}`, { priceCents: 900 });
    expect(res.status).toBe(200);
    expect(res.body.addon.price_cents).toBe(900);
    expect(res.body.addon.name).toBe('Wildflower Honey');
  });

  it('lists all add-ons including inactive (admin)', async () => {
    const res = await admin.get('/api/admin/addons');
    expect(res.status).toBe(200);
    expect(res.body.addons.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Public catalog ──────────────────────────────────────────────────────────

describe('GET /api/addons', () => {
  it('lists only active add-ons by default', async () => {
    const res = await customer.get('/api/addons');
    expect(res.status).toBe(200);
    const names = res.body.addons.map(a => a.name);
    expect(names).toContain('Wildflower Honey');
    expect(names).not.toContain('Strawberry Jam');  // inactive
  });

  it('includes inactive when ?includeInactive=true', async () => {
    const res = await customer.get('/api/addons?includeInactive=true');
    expect(res.body.addons.map(a => a.name)).toContain('Strawberry Jam');
  });
});

// ── Subscription add-on attachments ─────────────────────────────────────────

describe('POST /api/orders/:id/addons', () => {
  it('requires auth', async () => {
    const fresh = makeAgent(app);
    const res = await fresh.post(`/api/orders/${orderId}/addons`, {
      addonId: addonA.id, quantity: 1
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for another user's order", async () => {
    const stranger = makeAgent(app);
    await stranger.post('/api/auth/register', {
      name: 'S', email: 's@example.com', password: 'password123'
    });
    const res = await stranger.post(`/api/orders/${orderId}/addons`, {
      addonId: addonA.id, quantity: 1
    });
    expect(res.status).toBe(404);
  });

  it('attaches an active add-on to a subscription', async () => {
    const res = await customer.post(`/api/orders/${orderId}/addons`, {
      addonId: addonA.id, quantity: 2, recurring: true
    });
    expect(res.status).toBe(201);
    expect(res.body.orderAddon.quantity).toBe(2);
    expect(res.body.orderAddon.recurring).toBe(true);
  });

  it('refuses to attach an inactive add-on', async () => {
    const res = await customer.post(`/api/orders/${orderId}/addons`, {
      addonId: addonB.id, quantity: 1
    });
    expect(res.status).toBe(404);
  });

  it('refuses unknown add-on ids', async () => {
    const res = await customer.post(`/api/orders/${orderId}/addons`, {
      addonId: 99999, quantity: 1
    });
    expect(res.status).toBe(404);
  });

  it('rejects out-of-range quantities', async () => {
    const r1 = await customer.post(`/api/orders/${orderId}/addons`, {
      addonId: addonA.id, quantity: 0
    });
    expect(r1.status).toBe(400);
    const r2 = await customer.post(`/api/orders/${orderId}/addons`, {
      addonId: addonA.id, quantity: 9999
    });
    expect(r2.status).toBe(400);
  });
});

describe('GET /api/orders/:id/addons', () => {
  it('lists attached add-ons with running total', async () => {
    const res = await customer.get(`/api/orders/${orderId}/addons`);
    expect(res.status).toBe(200);
    expect(res.body.orderAddons.length).toBe(1);
    // 2 × $9.00 = $18.00 = 1800 cents
    expect(res.body.totalCents).toBe(1800);
  });
});

describe('DELETE /api/orders/:id/addons/:orderAddonId', () => {
  it('removes an add-on selection', async () => {
    const list = await customer.get(`/api/orders/${orderId}/addons`);
    const id = list.body.orderAddons[0].id;
    const res = await customer.del(`/api/orders/${orderId}/addons/${id}`);
    expect(res.status).toBe(200);

    const after = await customer.get(`/api/orders/${orderId}/addons`);
    expect(after.body.orderAddons).toEqual([]);
    expect(after.body.totalCents).toBe(0);
  });

  it('returns 404 for unknown order_addon ids', async () => {
    const res = await customer.del(`/api/orders/${orderId}/addons/99999`);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/admin/addons/:id', () => {
  it('removes an add-on (cascade)', async () => {
    const res = await admin.del(`/api/admin/addons/${addonB.id}`);
    expect(res.status).toBe(200);
  });
});
