/**
 * Shared test helpers.
 *
 * Sets DB_PATH to :memory: and NODE_ENV to test BEFORE any app/db modules are
 * loaded so every test file gets a fresh in-memory SQLite database.
 */

process.env.DB_PATH   = ':memory:';
process.env.NODE_ENV  = 'test';

const request = require('supertest');

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

module.exports = { makeAgent };
