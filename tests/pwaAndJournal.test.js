/**
 * Tests for the PWA, dark-mode bootstrap, Farm Journal page, and RSS feed.
 */
const request = require('supertest');
const { resetDb, closeDb } = require('./helpers');
const app = require('../app');

beforeAll(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeDb();
});

describe('PWA assets', () => {
  it('serves /manifest.json with the expected fields', async () => {
    const res = await request(app).get('/manifest.json');
    expect(res.status).toBe(200);
    // Some static-file middlewares set application/manifest+json, others
    // fall back to application/json. Accept either.
    expect(res.headers['content-type']).toMatch(/json/);
    const manifest = JSON.parse(res.text);
    expect(manifest.name).toMatch(/Sakinah Ridge/);
    expect(manifest.start_url).toBe('/dashboard');
    expect(manifest.display).toBe('standalone');
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons.length).toBeGreaterThan(0);
  });

  it('serves the service worker /sw.js as JavaScript', async () => {
    const res = await request(app).get('/sw.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.text).toMatch(/serviceWorker|CACHE_NAME|fetch/);
  });

  it('serves the shared bootstrap /static/srf-app.js', async () => {
    const res = await request(app).get('/static/srf-app.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.text).toMatch(/toggleTheme/);
  });

  it('serves the SVG app icon', async () => {
    const res = await request(app).get('/icons/icon.svg');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/svg/);
  });
});

describe('Farm Journal page', () => {
  it('serves /journal (Express route) and /journal.html (static)', async () => {
    const a = await request(app).get('/journal');
    expect(a.status).toBe(200);
    expect(a.text).toMatch(/Farm Journal/);

    const b = await request(app).get('/journal.html');
    expect(b.status).toBe(200);
    expect(b.text).toMatch(/Farm Journal/);
    // Open Graph + RSS link should both be present.
    expect(b.text).toMatch(/property="og:title"/);
    expect(b.text).toMatch(/application\/rss\+xml/);
  });
});

describe('RSS feed /feed.xml', () => {
  it('returns a valid RSS document even when there are no posts', async () => {
    const res = await request(app).get('/feed.xml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/rss\+xml/);
    expect(res.text).toMatch(/<rss version="2.0"/);
    expect(res.text).toMatch(/<channel>/);
    expect(res.text).toMatch(/Sakinah Ridge Farm/);
  });
});

describe('GET /api/farm-updates/:id', () => {
  it('rejects an invalid id', async () => {
    const res = await request(app).get('/api/farm-updates/abc');
    expect(res.status).toBe(400);
  });

  it('returns 404 when no such update exists', async () => {
    const res = await request(app).get('/api/farm-updates/999999');
    expect(res.status).toBe(404);
  });
});
