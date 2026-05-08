const { makeAgent, resetDb, closeDb } = require('./helpers');
const app = require('../app');

let agent;
let adminAgent;

beforeAll(async () => {
  await resetDb();

  // Create a regular user
  agent = makeAgent(app);
  await agent.post('/api/auth/register', {
    name: 'Regular User', email: 'user@example.com', password: 'password123'
  });

  // Create an admin user (promote via DB)
  adminAgent = makeAgent(app);
  await adminAgent.post('/api/auth/register', {
    name: 'Admin User', email: 'admin@example.com', password: 'password123'
  });
  const db = require('../db');
  await db.query("UPDATE users SET role = 'admin' WHERE email = 'admin@example.com'");
  // Re-login to pick up updated role
  adminAgent.resetCsrf();
  await adminAgent.post('/api/auth/logout', {}).catch(() => {});
  adminAgent.resetCsrf();
  await adminAgent.post('/api/auth/login', {
    email: 'admin@example.com', password: 'password123'
  });
});

afterAll(async () => {
  await closeDb();
});

// ── GET /api/plan-config (public) ─────────────────────────────────────────────

describe('GET /api/plan-config', () => {
  it('returns plan configurations without auth', async () => {
    const res = await agent.get('/api/plan-config');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.plans)).toBe(true);
  });

  it('includes the 4 default plan keys', async () => {
    const res = await agent.get('/api/plan-config');
    const keys = res.body.plans.map(p => p.plan_key);
    expect(keys).toContain('small_family');
    expect(keys).toContain('family');
    expect(keys).toContain('solo_couple');
    expect(keys).toContain('custom');
  });

  it('each plan has required fields', async () => {
    const res = await agent.get('/api/plan-config');
    for (const plan of res.body.plans) {
      expect(plan).toHaveProperty('id');
      expect(plan).toHaveProperty('plan_key');
      expect(plan).toHaveProperty('display_name');
      expect(plan).toHaveProperty('price_monthly');
      expect(plan).toHaveProperty('eggs_per_week');
      expect(plan).toHaveProperty('delivery_fee_enabled');
    }
  });
});

// ── GET /api/admin/plan-config (admin only) ───────────────────────────────────

describe('GET /api/admin/plan-config', () => {
  it('returns 401 when not logged in', async () => {
    const anonAgent = makeAgent(app);
    const res = await anonAgent.get('/api/admin/plan-config');
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin users', async () => {
    const res = await agent.get('/api/admin/plan-config');
    expect(res.status).toBe(403);
  });

  it('returns plan configurations for admins', async () => {
    const res = await adminAgent.get('/api/admin/plan-config');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.plans)).toBe(true);
    expect(res.body.plans.length).toBeGreaterThanOrEqual(4);
  });
});

// ── PUT /api/admin/plan-config/:id ────────────────────────────────────────────

describe('PUT /api/admin/plan-config/:id', () => {
  let planId;

  beforeAll(async () => {
    const res = await adminAgent.get('/api/admin/plan-config');
    const plan = res.body.plans.find(p => p.plan_key === 'small_family');
    planId = plan.id;
  });

  it('returns 401 when not logged in', async () => {
    const anonAgent = makeAgent(app);
    const res = await anonAgent.put(`/api/admin/plan-config/${planId}`, {
      display_name: 'New Name'
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin users', async () => {
    const res = await agent.put(`/api/admin/plan-config/${planId}`, {
      display_name: 'New Name'
    });
    expect(res.status).toBe(403);
  });

  it('returns 404 for unknown plan id', async () => {
    const res = await adminAgent.put('/api/admin/plan-config/999999', {
      display_name: 'Ghost Plan'
    });
    expect(res.status).toBe(404);
  });

  it('updates display_name', async () => {
    const res = await adminAgent.put(`/api/admin/plan-config/${planId}`, {
      display_name: 'Updated Family'
    });
    expect(res.status).toBe(200);
    expect(res.body.plan.display_name).toBe('Updated Family');
  });

  it('updates price_monthly', async () => {
    const res = await adminAgent.put(`/api/admin/plan-config/${planId}`, {
      price_monthly: 25
    });
    expect(res.status).toBe(200);
    expect(res.body.plan.price_monthly).toBe(25);
  });

  it('updates eggs_per_week', async () => {
    const res = await adminAgent.put(`/api/admin/plan-config/${planId}`, {
      eggs_per_week: 24
    });
    expect(res.status).toBe(200);
    expect(res.body.plan.eggs_per_week).toBe(24);
  });

  it('updates delivery_fee_enabled', async () => {
    const res = await adminAgent.put(`/api/admin/plan-config/${planId}`, {
      delivery_fee_enabled: false
    });
    expect(res.status).toBe(200);
    expect(res.body.plan.delivery_fee_enabled).toBe(false);
  });

  it('rejects empty display_name', async () => {
    const res = await adminAgent.put(`/api/admin/plan-config/${planId}`, {
      display_name: ''
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/display_name/);
  });

  it('rejects negative price_monthly', async () => {
    const res = await adminAgent.put(`/api/admin/plan-config/${planId}`, {
      price_monthly: -5
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/price_monthly/);
  });

  it('rejects negative eggs_per_week', async () => {
    const res = await adminAgent.put(`/api/admin/plan-config/${planId}`, {
      eggs_per_week: -1
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/eggs_per_week/);
  });

  it('returned plan appears in GET /api/plan-config', async () => {
    await adminAgent.put(`/api/admin/plan-config/${planId}`, {
      display_name: 'Small Family'
    });
    const res = await agent.get('/api/plan-config');
    const plan = res.body.plans.find(p => p.id === planId);
    expect(plan).toBeTruthy();
    expect(plan.display_name).toBe('Small Family');
  });

  it('updates delivery_frequency and recomputes eggs_per_delivery', async () => {
    // Set eggs_per_week to 14 with biweekly frequency → eggs_per_delivery = 28
    let res = await adminAgent.put(`/api/admin/plan-config/${planId}`, {
      eggs_per_week: 14,
      delivery_frequency: 'biweekly'
    });
    expect(res.status).toBe(200);
    expect(res.body.plan.delivery_frequency).toBe('biweekly');
    expect(res.body.plan.eggs_per_delivery).toBe(28);

    // Switch to weekly → eggs_per_delivery should now equal eggs_per_week
    res = await adminAgent.put(`/api/admin/plan-config/${planId}`, {
      delivery_frequency: 'weekly'
    });
    expect(res.status).toBe(200);
    expect(res.body.plan.delivery_frequency).toBe('weekly');
    expect(res.body.plan.eggs_per_delivery).toBe(14);
  });

  it('rejects an invalid delivery_frequency value', async () => {
    const res = await adminAgent.put(`/api/admin/plan-config/${planId}`, {
      delivery_frequency: 'monthly'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/delivery_frequency/);
  });
});
