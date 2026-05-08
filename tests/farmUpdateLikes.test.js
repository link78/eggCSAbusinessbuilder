const { makeAgent, resetDb, closeDb } = require('./helpers');
const app = require('../app');

let adminAgent;
let userAgent;
let updateId;

beforeAll(async () => {
  await resetDb();

  // Create an admin who will post the farm update
  adminAgent = makeAgent(app);
  await adminAgent.post('/api/auth/register', {
    name: 'Admin', email: 'fuadmin@example.com', password: 'adminpass123'
  });
  const db = require('../db');
  await db.query("UPDATE users SET role = 'admin' WHERE email = $1", ['fuadmin@example.com']);

  // Create a regular user who will like the update
  userAgent = makeAgent(app);
  await userAgent.post('/api/auth/register', {
    name: 'Liker', email: 'liker@example.com', password: 'password123'
  });

  // Post a farm update as admin (no images/files, just a body)
  const res = await adminAgent.post('/api/admin/farm-updates', {
    body: 'Hello from the farm!'
  });
  updateId = res.body.update.id;
});

afterAll(async () => {
  await closeDb();
});

describe('POST /api/farm-updates/:id/like', () => {
  it('rejects unauthenticated users', async () => {
    const fresh = makeAgent(app);
    const res = await fresh.post(`/api/farm-updates/${updateId}/like`, {});
    expect(res.status).toBe(401);
  });

  it('returns 404 for a non-existent update', async () => {
    const res = await userAgent.post('/api/farm-updates/999999/like', {});
    expect(res.status).toBe(404);
  });

  it('returns 400 for an invalid id', async () => {
    const res = await userAgent.post('/api/farm-updates/abc/like', {});
    expect(res.status).toBe(400);
  });

  it('toggles a like on and off and updates the count', async () => {
    // First like
    let res = await userAgent.post(`/api/farm-updates/${updateId}/like`, {});
    expect(res.status).toBe(200);
    expect(res.body.liked).toBe(true);
    expect(res.body.likes_count).toBe(1);

    // Re-fetch to verify viewer state
    let list = await userAgent.get('/api/farm-updates');
    let row = list.body.updates.find(u => u.id === updateId);
    expect(row.likes_count).toBe(1);
    expect(row.liked).toBe(true);

    // Unlike
    res = await userAgent.post(`/api/farm-updates/${updateId}/like`, {});
    expect(res.status).toBe(200);
    expect(res.body.liked).toBe(false);
    expect(res.body.likes_count).toBe(0);

    list = await userAgent.get('/api/farm-updates');
    row = list.body.updates.find(u => u.id === updateId);
    expect(row.likes_count).toBe(0);
    expect(row.liked).toBe(false);
  });

  it('reports liked=false for anonymous viewers even when others have liked', async () => {
    // User likes the update
    await userAgent.post(`/api/farm-updates/${updateId}/like`, {});

    const fresh = makeAgent(app);
    const list = await fresh.get('/api/farm-updates');
    const row = list.body.updates.find(u => u.id === updateId);
    expect(row.likes_count).toBe(1);
    expect(row.liked).toBe(false);

    // Cleanup: unlike so subsequent tests start fresh
    await userAgent.post(`/api/farm-updates/${updateId}/like`, {});
  });
});
