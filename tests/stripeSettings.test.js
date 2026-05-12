const { makeAgent, resetDb, closeDb } = require('./helpers');
const app = require('../app');
const db  = require('../db');

let agent;

beforeAll(async () => {
  await resetDb();
  agent = makeAgent(app);
});

afterAll(async () => {
  await closeDb();
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function registerAdmin() {
  await agent.post('/api/auth/register', {
    name: 'Admin User',
    email: 'admin@example.com',
    password: 'password123'
  });
  await db.query("UPDATE users SET role = 'admin' WHERE email = 'admin@example.com'");
  await agent.post('/api/auth/login', {
    email: 'admin@example.com',
    password: 'password123'
  });
}

async function registerUser() {
  const u = makeAgent(app);
  await u.post('/api/auth/register', {
    name: 'Plain User',
    email: 'user@example.com',
    password: 'password123'
  });
  return u;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('GET /api/admin/stripe-settings', () => {
  beforeAll(async () => {
    await resetDb();
    agent = makeAgent(app);
    await registerAdmin();
  });

  it('returns 401 when not logged in', async () => {
    const anon = makeAgent(app);
    const res = await anon.get('/api/admin/stripe-settings');
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin user', async () => {
    const u = await registerUser();
    const res = await u.get('/api/admin/stripe-settings');
    expect(res.status).toBe(403);
  });

  it('returns stripe settings with nulls when nothing is configured', async () => {
    const res = await agent.get('/api/admin/stripe-settings');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      publishableKey:    null,
      secretKeySet:      false,
      publishableSource: null,
      secretSource:      null
    });
  });
});

describe('PUT /api/admin/stripe-settings', () => {
  beforeAll(async () => {
    await resetDb();
    agent = makeAgent(app);
    await registerAdmin();
  });

  it('returns 401 when not logged in', async () => {
    const anon = makeAgent(app);
    const res = await anon.put('/api/admin/stripe-settings', { publishableKey: 'pk_test_x' });
    expect(res.status).toBe(401);
  });

  it('saves a publishable key and reflects it in GET', async () => {
    const putRes = await agent.put('/api/admin/stripe-settings', {
      publishableKey: 'pk_test_abc123'
    });
    expect(putRes.status).toBe(200);
    expect(putRes.body.ok).toBe(true);

    const getRes = await agent.get('/api/admin/stripe-settings');
    expect(getRes.status).toBe(200);
    expect(getRes.body.publishableKey).toBe('pk_test_abc123');
    expect(getRes.body.publishableSource).toBe('db');
    expect(getRes.body.secretKeySet).toBe(false);
  });

  it('saves a secret key and reports secretKeySet: true without revealing the key', async () => {
    const putRes = await agent.put('/api/admin/stripe-settings', {
      secretKey: 'sk_test_secret999'
    });
    expect(putRes.status).toBe(200);

    const getRes = await agent.get('/api/admin/stripe-settings');
    expect(getRes.status).toBe(200);
    expect(getRes.body.secretKeySet).toBe(true);
    expect(getRes.body.secretSource).toBe('db');
    // The secret key value must never be returned
    expect(JSON.stringify(getRes.body)).not.toContain('sk_test_secret999');
  });

  it('overwrites an existing key on subsequent PUT', async () => {
    await agent.put('/api/admin/stripe-settings', { publishableKey: 'pk_test_first' });
    await agent.put('/api/admin/stripe-settings', { publishableKey: 'pk_test_second' });

    const getRes = await agent.get('/api/admin/stripe-settings');
    expect(getRes.body.publishableKey).toBe('pk_test_second');
  });

  it('persists settings in the database', async () => {
    await agent.put('/api/admin/stripe-settings', { publishableKey: 'pk_test_persisted' });
    const row = (await db.query(
      "SELECT value FROM settings WHERE key = 'stripe_publishable_key'"
    )).rows[0];
    expect(row).toBeDefined();
    expect(row.value).toBe('pk_test_persisted');
  });
});
