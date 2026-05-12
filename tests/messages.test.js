const { makeAgent, resetDb, closeDb } = require('./helpers');
const app = require('../app');
const db  = require('../db');

let adminAgent, aliceAgent, bobAgent;
let aliceId, bobId;

beforeAll(async () => {
  await resetDb();

  adminAgent = makeAgent(app);
  await adminAgent.post('/api/auth/register', {
    name: 'Admin', email: 'admin@example.com', password: 'adminpass123'
  });
  await db.query("UPDATE users SET role = 'admin' WHERE email = $1", ['admin@example.com']);

  aliceAgent = makeAgent(app);
  await aliceAgent.post('/api/auth/register', {
    name: 'Alice', email: 'alice@example.com', password: 'password123'
  });
  aliceId = (await db.query('SELECT id FROM users WHERE email = $1', ['alice@example.com'])).rows[0].id;

  bobAgent = makeAgent(app);
  await bobAgent.post('/api/auth/register', {
    name: 'Bob', email: 'bob@example.com', password: 'password123'
  });
  bobId = (await db.query('SELECT id FROM users WHERE email = $1', ['bob@example.com'])).rows[0].id;
});

afterAll(async () => {
  await closeDb();
});

describe('Internal messenger', () => {
  describe('POST /api/admin/messages/:userId', () => {
    it('requires admin', async () => {
      const res = await aliceAgent.post(`/api/admin/messages/${bobId}`, { body: 'hi' });
      expect(res.status).toBe(403);
    });

    it('rejects empty body', async () => {
      const res = await adminAgent.post(`/api/admin/messages/${aliceId}`, { body: '   ' });
      expect(res.status).toBe(400);
    });

    it('404s for unknown user', async () => {
      const res = await adminAgent.post('/api/admin/messages/999999', { body: 'hi' });
      expect(res.status).toBe(404);
    });

    it('rejects sending to another admin', async () => {
      const adminId = (await db.query("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1")).rows[0].id;
      const res = await adminAgent.post(`/api/admin/messages/${adminId}`, { body: 'hi' });
      expect(res.status).toBe(400);
    });

    it('rejects too-long body', async () => {
      const big = 'x'.repeat(4001);
      const res = await adminAgent.post(`/api/admin/messages/${aliceId}`, { body: big });
      expect(res.status).toBe(400);
    });

    it('admin can send to a customer', async () => {
      const res = await adminAgent.post(`/api/admin/messages/${aliceId}`, { body: 'Hello Alice, your eggs are ready.' });
      expect(res.status).toBe(201);
      expect(res.body.message.body).toBe('Hello Alice, your eggs are ready.');
      expect(res.body.message.recipient_id).toBe(aliceId);
    });
  });

  describe('GET /api/messages (customer view)', () => {
    it('requires auth', async () => {
      const fresh = makeAgent(app);
      const res = await fresh.get('/api/messages');
      expect(res.status).toBe(401);
    });

    it('returns the thread with the farm and marks admin msgs as read', async () => {
      // Alice should see the message sent above (currently unread).
      let unread = await aliceAgent.get('/api/messages/unread-count');
      expect(unread.body.unread).toBe(1);

      const res = await aliceAgent.get('/api/messages');
      expect(res.status).toBe(200);
      expect(res.body.messages.length).toBe(1);
      expect(res.body.messages[0].body).toMatch(/Hello Alice/);
      expect(res.body.messages[0].sender_role).toBe('admin');

      // After GET, unread should be zero.
      unread = await aliceAgent.get('/api/messages/unread-count');
      expect(unread.body.unread).toBe(0);
    });

    it('keeps threads isolated per customer', async () => {
      const res = await bobAgent.get('/api/messages');
      expect(res.status).toBe(200);
      expect(res.body.messages.length).toBe(0);
    });

    it('returns empty array for an admin', async () => {
      const res = await adminAgent.get('/api/messages');
      expect(res.status).toBe(200);
      expect(res.body.messages).toEqual([]);
    });
  });

  describe('POST /api/messages (customer reply)', () => {
    it('requires auth', async () => {
      const fresh = makeAgent(app);
      const res = await fresh.post('/api/messages', { body: 'hi' });
      expect(res.status).toBe(401);
    });

    it('rejects empty body', async () => {
      const res = await aliceAgent.post('/api/messages', { body: '' });
      expect(res.status).toBe(400);
    });

    it('rejects admin sender', async () => {
      const res = await adminAgent.post('/api/messages', { body: 'hi' });
      expect(res.status).toBe(400);
    });

    it('lets a customer reply and routes to the admin', async () => {
      const res = await aliceAgent.post('/api/messages', { body: 'Thanks! Can I pick them up Saturday?' });
      expect(res.status).toBe(201);
      expect(res.body.message.body).toMatch(/Thanks/);
      expect(res.body.message.sender_id).toBe(aliceId);

      // Confirm the admin now sees Alice's reply in the thread.
      const thread = await adminAgent.get(`/api/admin/messages/${aliceId}`);
      expect(thread.status).toBe(200);
      expect(thread.body.messages.length).toBe(2);
      expect(thread.body.messages[1].body).toMatch(/Thanks/);
    });
  });

  describe('GET /api/admin/messages (conversation list)', () => {
    it('requires admin', async () => {
      const res = await aliceAgent.get('/api/admin/messages');
      expect(res.status).toBe(403);
    });

    it('summarises conversations newest-first with unread counts', async () => {
      // Alice sends another reply so there's an unread customer→admin message.
      await aliceAgent.post('/api/messages', { body: 'Quick follow-up question.' });
      // Send another message to Bob so two conversations exist.
      await adminAgent.post(`/api/admin/messages/${bobId}`, { body: 'Hi Bob!' });

      const res = await adminAgent.get('/api/admin/messages');
      expect(res.status).toBe(200);
      const convs = res.body.conversations;
      expect(convs.length).toBe(2);
      // Bob's is newest.
      expect(convs[0].user_id).toBe(bobId);
      expect(convs[0].last_sender_role).toBe('admin');
      expect(convs[0].unread_count).toBe(0);

      // Alice should still appear; her last message is unread on the admin side (customer→admin).
      const aliceConv = convs.find(c => c.user_id === aliceId);
      expect(aliceConv).toBeDefined();
      expect(aliceConv.unread_count).toBe(1);
      expect(aliceConv.last_sender_role).toBe('user');
    });
  });

  describe('GET /api/admin/messages/:userId', () => {
    it('returns the thread and marks customer msgs as read', async () => {
      const res = await adminAgent.get(`/api/admin/messages/${aliceId}`);
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe(aliceId);
      expect(res.body.messages.length).toBeGreaterThanOrEqual(2);

      // Re-fetch the list: Alice's unread_count should now be 0.
      const list = await adminAgent.get('/api/admin/messages');
      const aliceConv = list.body.conversations.find(c => c.user_id === aliceId);
      expect(aliceConv.unread_count).toBe(0);
    });

    it('400s for invalid id', async () => {
      const res = await adminAgent.get('/api/admin/messages/abc');
      expect(res.status).toBe(400);
    });

    it('404s for unknown user', async () => {
      const res = await adminAgent.get('/api/admin/messages/999999');
      expect(res.status).toBe(404);
    });
  });
});
