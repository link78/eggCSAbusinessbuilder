/**
 * Shared test helpers.
 *
 * Sets DATABASE_URL and NODE_ENV BEFORE any app/db modules are loaded so every
 * test file connects to the dedicated test database.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://runner:testpass@localhost/egg_csa_test';
process.env.NODE_ENV     = 'test';

const request = require('supertest');

/**
 * Truncate all tables and reset sequences.
 * Call this in beforeAll() to give each test file a clean slate.
 */
async function resetDb() {
  const db = require('../db');
  await db.ready;
  await db.reset();
}

/**
 * Close the connection pool.
 * Call this in afterAll() to avoid open-handle warnings.
 */
async function closeDb() {
  const db = require('../db');
  await db.close();
}

/**
 * Create a supertest agent that keeps cookies (session) between requests and
 * automatically fetches a CSRF token before each mutating call.
 *
 * Usage:
 *   const agent = makeAgent(app);
 *   await agent.post('/api/auth/register', { name, email, password });
 */
function makeAgent(app) {
  const agent = request.agent(app);
  let csrfToken = null;

  async function csrf() {
    if (!csrfToken) {
      const res = await agent.get('/api/csrf-token');
      csrfToken = res.body.csrfToken;
    }
    return csrfToken;
  }

  // Reset CSRF token when session changes (e.g. after logout)
  function resetCsrf() {
    csrfToken = null;
  }

  async function post(path, body) {
    const token = await csrf();
    return agent
      .post(path)
      .set('x-csrf-token', token)
      .send(body);
  }

  async function put(path, body) {
    const token = await csrf();
    return agent
      .put(path)
      .set('x-csrf-token', token)
      .send(body);
  }

  async function del(path) {
    const token = await csrf();
    return agent
      .delete(path)
      .set('x-csrf-token', token);
  }

  async function get(path) {
    return agent.get(path);
  }

  return { post, put, del, get, resetCsrf };
}

module.exports = { makeAgent, resetDb, closeDb };
