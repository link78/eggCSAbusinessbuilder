const { makeAgent, resetDb, closeDb } = require('./helpers');
const app = require('../app');

let agent;

beforeAll(async () => {
  await resetDb();
  agent = makeAgent(app);
  // Register and login a test user
  await agent.post('/api/auth/register', {
    name: 'Frank', email: 'frank@example.com', password: 'password123'
  });
});

afterAll(async () => {
  await closeDb();
});

// ── GET /api/reviews ──────────────────────────────────────────────────────────

describe('GET /api/reviews', () => {
  it('returns an empty list initially', async () => {
    const res = await agent.get('/api/reviews');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.reviews)).toBe(true);
  });

  it('is publicly accessible (no auth required)', async () => {
    const freshAgent = makeAgent(app);
    const res = await freshAgent.get('/api/reviews');
    expect(res.status).toBe(200);
  });
});

// ── POST /api/reviews ─────────────────────────────────────────────────────────

describe('POST /api/reviews', () => {
  it('submits a valid review', async () => {
    const res = await agent.post('/api/reviews', {
      rating: 5,
      title: 'Great eggs!',
      body: 'Fresh and delicious every week.'
    });
    expect(res.status).toBe(200);
    expect(res.body.review).toMatchObject({
      user_name: 'Frank',
      rating: 5,
      title: 'Great eggs!',
      body: 'Fresh and delicious every week.'
    });
    expect(res.body.review).toHaveProperty('id');
    expect(res.body.review).toHaveProperty('created_at');
  });

  it('appears in the public review list', async () => {
    const res = await agent.get('/api/reviews');
    expect(res.body.reviews.some(r => r.title === 'Great eggs!')).toBe(true);
  });

  it('requires authentication', async () => {
    const freshAgent = makeAgent(app);
    const res = await freshAgent.post('/api/reviews', {
      rating: 4, title: 'Nice', body: 'Good eggs.'
    });
    expect(res.status).toBe(401);
  });

  it('requires rating, title, and body', async () => {
    const res = await agent.post('/api/reviews', { rating: 4, title: 'No body' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('rejects rating below 1', async () => {
    const res = await agent.post('/api/reviews', {
      rating: -1, title: 'Bad', body: 'Not good.'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/1 and 5/i);
  });

  it('rejects rating above 5', async () => {
    const res = await agent.post('/api/reviews', {
      rating: 6, title: 'Too high', body: 'Perfect.'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/1 and 5/i);
  });

  it('rejects non-numeric rating', async () => {
    const res = await agent.post('/api/reviews', {
      rating: 'five', title: 'Stars', body: 'Great.'
    });
    expect(res.status).toBe(400);
  });

  it('rejects title longer than 120 characters', async () => {
    const res = await agent.post('/api/reviews', {
      rating: 3,
      title: 'A'.repeat(121),
      body: 'Some body text.'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/120/);
  });

  it('rejects body longer than 1000 characters', async () => {
    const res = await agent.post('/api/reviews', {
      rating: 3,
      title: 'Long review',
      body: 'B'.repeat(1001)
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/1000/);
  });
});

