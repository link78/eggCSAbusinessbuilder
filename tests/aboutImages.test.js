const path = require('path');
const fs   = require('fs');
const request = require('supertest');
const { resetDb, closeDb } = require('./helpers');

let app;

// Smallest valid 1x1 PNG.
const PNG_1x1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0000000030001f6378eaf0000000049454e44ae426082',
  'hex'
);

async function newAgent(loginEmail) {
  const sa = request.agent(app);
  const tok1 = (await sa.get('/api/csrf-token')).body.csrfToken;
  if (loginEmail) {
    await sa.post('/api/auth/login').set('x-csrf-token', tok1)
      .send({ email: loginEmail, password: 'pass1234' });
  }
  return sa;
}

async function csrf(sa) {
  return (await sa.get('/api/csrf-token')).body.csrfToken;
}

beforeAll(async () => {
  await resetDb();
  app = require('../app');
  // Register admin + regular user.
  const reg = request.agent(app);
  let t = (await reg.get('/api/csrf-token')).body.csrfToken;
  await reg.post('/api/auth/register').set('x-csrf-token', t)
    .send({ name: 'Admin', email: 'admin@example.com', password: 'pass1234' });
  const reg2 = request.agent(app);
  t = (await reg2.get('/api/csrf-token')).body.csrfToken;
  await reg2.post('/api/auth/register').set('x-csrf-token', t)
    .send({ name: 'User', email: 'user@example.com', password: 'pass1234' });
  const db = require('../db');
  await db.query("UPDATE users SET role='admin' WHERE email='admin@example.com'");
});

afterAll(async () => { await closeDb(); });

describe('POST /api/admin/about-images/:kind', () => {
  test('admin can upload a flock image and the file is saved', async () => {
    const sa = await newAgent('admin@example.com');
    const t  = await csrf(sa);
    const res = await sa.post('/api/admin/about-images/flock')
      .set('x-csrf-token', t)
      .attach('images', PNG_1x1, 'hen.png');
    expect(res.status).toBe(201);
    expect(Array.isArray(res.body.urls)).toBe(true);
    expect(res.body.urls).toHaveLength(1);
    expect(res.body.urls[0]).toMatch(/^\/uploads\/flock\/[a-f0-9]{32}\.png$/);

    const full = path.join(__dirname, '..', res.body.urls[0]);
    expect(fs.existsSync(full)).toBe(true);
    fs.unlinkSync(full);
  });

  test('admin can upload multiple story images at once', async () => {
    const sa = await newAgent('admin@example.com');
    const t  = await csrf(sa);
    const res = await sa.post('/api/admin/about-images/story')
      .set('x-csrf-token', t)
      .attach('images', PNG_1x1, 'a.png')
      .attach('images', PNG_1x1, 'b.png');
    expect(res.status).toBe(201);
    expect(res.body.urls).toHaveLength(2);
    res.body.urls.forEach(u => {
      expect(u).toMatch(/^\/uploads\/story\/[a-f0-9]{32}\.png$/);
      fs.unlinkSync(path.join(__dirname, '..', u));
    });
  });

  test('rejects unknown kind with 400', async () => {
    const sa = await newAgent('admin@example.com');
    const t  = await csrf(sa);
    const res = await sa.post('/api/admin/about-images/bogus')
      .set('x-csrf-token', t)
      .attach('images', PNG_1x1, 'x.png');
    expect(res.status).toBe(400);
  });

  test('rejects non-image uploads', async () => {
    const sa = await newAgent('admin@example.com');
    const t  = await csrf(sa);
    const res = await sa.post('/api/admin/about-images/flock')
      .set('x-csrf-token', t)
      .attach('images', Buffer.from('not an image'), { filename: 'x.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
  });

  test('rejects requests with no files', async () => {
    const sa = await newAgent('admin@example.com');
    const t  = await csrf(sa);
    const res = await sa.post('/api/admin/about-images/flock')
      .set('x-csrf-token', t);
    expect(res.status).toBe(400);
  });

  test('non-admin gets 403', async () => {
    const sa = await newAgent('user@example.com');
    const t  = await csrf(sa);
    const res = await sa.post('/api/admin/about-images/flock')
      .set('x-csrf-token', t)
      .attach('images', PNG_1x1, 'x.png');
    expect(res.status).toBe(403);
  });

  test('unauthenticated gets 401', async () => {
    const sa = await newAgent();
    const t  = await csrf(sa);
    const res = await sa.post('/api/admin/about-images/flock')
      .set('x-csrf-token', t)
      .attach('images', PNG_1x1, 'x.png');
    expect(res.status).toBe(401);
  });
});
