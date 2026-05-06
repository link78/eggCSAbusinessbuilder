// Must be first so DB_PATH / NODE_ENV are set before any require()
const { makeAgent } = require('./helpers');
// Jest isolates module registries per test file, so each file gets a fresh DB
const app = require('../app');

let agent;

beforeAll(async () => {
  agent = makeAgent(app);
});

// ── Registration ──────────────────────────────────────────────────────────────

describe('POST /api/auth/register', () => {
  it('registers a new user and returns user data', async () => {
    const res = await agent.post('/api/auth/register', {
      name: 'Alice', email: 'alice@example.com', password: 'secret123'
    });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ name: 'Alice', email: 'alice@example.com' });
    expect(res.body.user).not.toHaveProperty('password_hash');
  });

  it('rejects duplicate email', async () => {
    const res = await agent.post('/api/auth/register', {
      name: 'Alice2', email: 'alice@example.com', password: 'secret123'
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it('requires name, email, and password', async () => {
    const res = await agent.post('/api/auth/register', { email: 'x@x.com' });
    expect(res.status).toBe(400);
  });

  it('rejects short password', async () => {
    const res = await agent.post('/api/auth/register', {
      name: 'Bob', email: 'bob@example.com', password: '123'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/6 characters/i);
  });
});

// ── Login ─────────────────────────────────────────────────────────────────────

describe('POST /api/auth/login', () => {
  it('logs in with correct credentials', async () => {
    const res = await agent.post('/api/auth/login', {
      email: 'alice@example.com', password: 'secret123'
    });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: 'alice@example.com' });
  });

  it('rejects wrong password', async () => {
    const res = await agent.post('/api/auth/login', {
      email: 'alice@example.com', password: 'wrongpassword'
    });
    expect(res.status).toBe(401);
  });

  it('rejects unknown email', async () => {
    const res = await agent.post('/api/auth/login', {
      email: 'nobody@example.com', password: 'secret123'
    });
    expect(res.status).toBe(401);
  });

  it('requires email and password', async () => {
    const res = await agent.post('/api/auth/login', { email: 'alice@example.com' });
    expect(res.status).toBe(400);
  });
});

// ── /me ───────────────────────────────────────────────────────────────────────

describe('GET /api/auth/me', () => {
  it('returns current user when logged in', async () => {
    // Ensure we are logged in (previous login test established session)
    const res = await agent.get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: 'alice@example.com' });
  });

  it('returns null when not logged in', async () => {
    const freshAgent = makeAgent(app);
    const res = await freshAgent.get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user).toBeNull();
  });
});

// ── Logout ────────────────────────────────────────────────────────────────────

describe('POST /api/auth/logout', () => {
  it('logs out and clears the session', async () => {
    const localAgent = makeAgent(app);
    await localAgent.post('/api/auth/register', {
      name: 'Charlie', email: 'charlie@example.com', password: 'secret123'
    });
    let me = await localAgent.get('/api/auth/me');
    expect(me.body.user).not.toBeNull();

    const res = await localAgent.post('/api/auth/logout', {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    localAgent.resetCsrf();
    me = await localAgent.get('/api/auth/me');
    expect(me.body.user).toBeNull();
  });
});

// ── CSRF protection ───────────────────────────────────────────────────────────

describe('CSRF protection', () => {
  it('rejects POST without CSRF token', async () => {
    const rawRequest = require('supertest');
    const res = await rawRequest(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'secret123' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/csrf/i);
  });
});

