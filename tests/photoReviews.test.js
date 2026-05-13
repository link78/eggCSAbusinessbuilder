/**
 * Tests for the photo-review feature.
 *
 * The existing reviews suite covers the JSON path; this file specifically
 * exercises multipart submissions with an attached image so we know the
 * route, multer config, and DB persistence all line up.
 */
const path = require('path');
const fs   = require('fs');
const request = require('supertest');
const { resetDb, closeDb } = require('./helpers');
const app = require('../app');

let agent;       // raw supertest agent — supports .attach() and .field()
let csrfToken;

// Smallest valid PNG (1x1 red pixel). Built once and reused.
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000d49444154789c63f8cf0000030001000d0a2db40000000049454e44ae426082',
  'hex'
);

beforeAll(async () => {
  await resetDb();
  agent = request.agent(app);

  // Register & log in the test user.
  const tokenRes = await agent.get('/api/csrf-token');
  csrfToken = tokenRes.body.csrfToken;
  await agent.post('/api/auth/register')
    .set('x-csrf-token', csrfToken)
    .send({ name: 'Photo Frank', email: 'photo-frank@example.com', password: 'password123' });
});

afterAll(async () => {
  await closeDb();
});

describe('POST /api/reviews with a photo', () => {
  it('accepts a multipart upload and stores photo_url', async () => {
    const me = await agent.get('/api/auth/me');
    expect(me.body.user).toBeTruthy();

    const res = await agent.post('/api/reviews')
      .set('x-csrf-token', csrfToken)
      .field('rating', '5')
      .field('title', 'Beautiful eggs')
      .field('body', 'Look at these colors!')
      .attach('photo', PNG_BYTES, { filename: 'breakfast.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.review).toMatchObject({
      rating: 5,
      title: 'Beautiful eggs',
      body: 'Look at these colors!',
      user_name: 'Photo Frank'
    });
    expect(res.body.review.photo_url).toMatch(/^\/uploads\/reviews\/[a-f0-9]{32}\.png$/);

    // The uploaded file must actually exist on disk.
    const onDisk = path.join(__dirname, '..', res.body.review.photo_url);
    expect(fs.existsSync(onDisk)).toBe(true);
  });

  it('exposes photo_url in the public review list', async () => {
    const res = await request(app).get('/api/reviews');
    expect(res.status).toBe(200);
    const withPhoto = res.body.reviews.find(r => r.title === 'Beautiful eggs');
    expect(withPhoto).toBeTruthy();
    expect(withPhoto.photo_url).toMatch(/^\/uploads\/reviews\//);
  });

  it('rejects non-image uploads and does not create a review', async () => {
    const before = (await request(app).get('/api/reviews')).body.reviews.length;

    const res = await agent.post('/api/reviews')
      .set('x-csrf-token', csrfToken)
      .field('rating', '4')
      .field('title', 'Not an image')
      .field('body', 'Trying to upload a text file.')
      .attach('photo', Buffer.from('hello world'), { filename: 'notes.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/image/i);

    const after = (await request(app).get('/api/reviews')).body.reviews.length;
    expect(after).toBe(before);
  });

  it('still accepts a JSON-only review with no photo (backward compatible)', async () => {
    const res = await agent.post('/api/reviews')
      .set('x-csrf-token', csrfToken)
      .set('Content-Type', 'application/json')
      .send({ rating: 4, title: 'No-photo review', body: 'Just text, no image.' });
    expect(res.status).toBe(200);
    expect(res.body.review).toMatchObject({
      rating: 4,
      title: 'No-photo review',
      photo_url: null
    });
  });

  it('serves the uploaded photo via /uploads/reviews/*', async () => {
    const list = await request(app).get('/api/reviews');
    const withPhoto = list.body.reviews.find(r => r.photo_url);
    expect(withPhoto).toBeTruthy();
    const res = await request(app).get(withPhoto.photo_url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
  });
});


describe('POST /api/reviews with a photo', () => {
  it('accepts a multipart upload and stores photo_url', async () => {
    const me = await agent.get('/api/auth/me');
    expect(me.body.user).toBeTruthy();

    // Re-use the authenticated agent's cookie jar by hitting the same agent
    // with a multipart POST.
    const res = await agent.post('/api/reviews')
      .set('x-csrf-token', csrfToken)
      .field('rating', '5')
      .field('title', 'Beautiful eggs')
      .field('body', 'Look at these colors!')
      .attach('photo', PNG_BYTES, { filename: 'breakfast.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.review).toMatchObject({
      rating: 5,
      title: 'Beautiful eggs',
      body: 'Look at these colors!',
      user_name: 'Photo Frank'
    });
    expect(res.body.review.photo_url).toMatch(/^\/uploads\/reviews\/[a-f0-9]{32}\.png$/);

    // The uploaded file must actually exist on disk.
    const onDisk = path.join(__dirname, '..', res.body.review.photo_url);
    expect(fs.existsSync(onDisk)).toBe(true);
  });

  it('exposes photo_url in the public review list', async () => {
    const res = await request(app).get('/api/reviews');
    expect(res.status).toBe(200);
    const withPhoto = res.body.reviews.find(r => r.title === 'Beautiful eggs');
    expect(withPhoto).toBeTruthy();
    expect(withPhoto.photo_url).toMatch(/^\/uploads\/reviews\//);
  });

  it('rejects non-image uploads and does not create a review', async () => {
    const before = (await request(app).get('/api/reviews')).body.reviews.length;

    const res = await agent.post('/api/reviews')
      .set('x-csrf-token', csrfToken)
      .field('rating', '4')
      .field('title', 'Not an image')
      .field('body', 'Trying to upload a text file.')
      .attach('photo', Buffer.from('hello world'), { filename: 'notes.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/image/i);

    const after = (await request(app).get('/api/reviews')).body.reviews.length;
    expect(after).toBe(before);
  });

  it('still accepts a JSON-only review with no photo (backward compatible)', async () => {
    const res = await agent.post('/api/reviews')
      .set('x-csrf-token', csrfToken)
      .set('Content-Type', 'application/json')
      .send({ rating: 4, title: 'No-photo review', body: 'Just text, no image.' });
    expect(res.status).toBe(200);
    expect(res.body.review).toMatchObject({
      rating: 4,
      title: 'No-photo review',
      photo_url: null
    });
  });

  it('serves the uploaded photo via /uploads/reviews/*', async () => {
    const list = await request(app).get('/api/reviews');
    const withPhoto = list.body.reviews.find(r => r.photo_url);
    expect(withPhoto).toBeTruthy();
    const res = await request(app).get(withPhoto.photo_url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
  });
});
