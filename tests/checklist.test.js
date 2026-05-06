const { makeAgent } = require('./helpers');
const app = require('../app');

let agent;

beforeAll(async () => {
  agent = makeAgent(app);
  // Register and login a test user
  await agent.post('/api/auth/register', {
    name: 'Grace', email: 'grace@example.com', password: 'password123'
  });
});

// ── GET /api/checklist ────────────────────────────────────────────────────────

describe('GET /api/checklist', () => {
  it('requires authentication', async () => {
    const freshAgent = makeAgent(app);
    const res = await freshAgent.get('/api/checklist');
    expect(res.status).toBe(401);
  });

  it('returns empty completedSteps for a new user', async () => {
    const res = await agent.get('/api/checklist');
    expect(res.status).toBe(200);
    expect(res.body.completedSteps).toEqual([]);
  });
});

// ── PUT /api/checklist ────────────────────────────────────────────────────────

describe('PUT /api/checklist', () => {
  it('saves and returns completedSteps', async () => {
    const save = await agent.put('/api/checklist', { completedSteps: [1, 3, 5] });
    expect(save.status).toBe(200);
    expect(save.body.ok).toBe(true);

    const get = await agent.get('/api/checklist');
    expect(get.body.completedSteps).toEqual([1, 3, 5]);
  });

  it('overwrites previously saved steps', async () => {
    await agent.put('/api/checklist', { completedSteps: [1, 2] });
    await agent.put('/api/checklist', { completedSteps: [2, 4, 6, 8] });

    const res = await agent.get('/api/checklist');
    expect(res.body.completedSteps).toEqual([2, 4, 6, 8]);
  });

  it('accepts an empty array (clearing all steps)', async () => {
    await agent.put('/api/checklist', { completedSteps: [1, 2, 3] });
    await agent.put('/api/checklist', { completedSteps: [] });

    const res = await agent.get('/api/checklist');
    expect(res.body.completedSteps).toEqual([]);
  });

  it('ignores non-numeric values in the array', async () => {
    const save = await agent.put('/api/checklist', { completedSteps: [1, 'two', 3, null] });
    expect(save.status).toBe(200);

    const res = await agent.get('/api/checklist');
    // 'two' → NaN (filtered out); only valid numbers are stored
    expect(res.body.completedSteps).not.toContain('two');
  });

  it('rejects completedSteps that is not an array', async () => {
    const res = await agent.put('/api/checklist', { completedSteps: 'all' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/array/i);
  });

  it('requires authentication', async () => {
    const freshAgent = makeAgent(app);
    const res = await freshAgent.put('/api/checklist', { completedSteps: [1] });
    expect(res.status).toBe(401);
  });

  it('keeps each user\'s progress isolated', async () => {
    // Set steps for primary user
    await agent.put('/api/checklist', { completedSteps: [7, 8] });

    // Another user has no steps
    const otherAgent = makeAgent(app);
    await otherAgent.post('/api/auth/register', {
      name: 'Hank', email: 'hank@example.com', password: 'password123'
    });
    const res = await otherAgent.get('/api/checklist');
    expect(res.body.completedSteps).toEqual([]);
  });
});

