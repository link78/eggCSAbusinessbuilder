const { makeAgent, resetDb, closeDb } = require('./helpers');
const app = require('../app');
const db  = require('../db');
const notifier = require('../lib/notifier');

let userAgent, adminAgent;
let activeOrder;

beforeAll(async () => {
  await resetDb();

  // Customer
  userAgent = makeAgent(app);
  await userAgent.post('/api/auth/register', {
    name: 'Carol', email: 'carol@example.com', password: 'password123'
  });
  activeOrder = (await userAgent.post('/api/orders', {
    planName: 'Solo / Couple', fulfillmentMethod: 'pickup',
    pickupDay: 'Wednesday', boxes12: 1, boxes18: 0
  })).body.order;

  // Admin
  adminAgent = makeAgent(app);
  await adminAgent.post('/api/auth/register', {
    name: 'Admin', email: 'admin@example.com', password: 'password123'
  });
  await db.query("UPDATE users SET role = 'admin' WHERE email = 'admin@example.com'");
});

afterAll(async () => {
  await closeDb();
});

// ── Preferences ─────────────────────────────────────────────────────────────

describe('GET/PUT /api/auth/notifications', () => {
  it('returns defaults: email on, sms off, no phone', async () => {
    const res = await userAgent.get('/api/auth/notifications');
    expect(res.status).toBe(200);
    expect(res.body.reminderEmailEnabled).toBe(true);
    expect(res.body.reminderSmsEnabled).toBe(false);
    expect(res.body.phoneNumber).toBe('');
  });

  it('requires auth', async () => {
    const fresh = makeAgent(app);
    const res = await fresh.get('/api/auth/notifications');
    expect(res.status).toBe(401);
  });

  it('updates email preference', async () => {
    const res = await userAgent.put('/api/auth/notifications', {
      reminderEmailEnabled: false
    });
    expect(res.status).toBe(200);
    expect(res.body.reminderEmailEnabled).toBe(false);
    // Restore for later tests.
    await userAgent.put('/api/auth/notifications', { reminderEmailEnabled: true });
  });

  it('rejects malformed phone numbers', async () => {
    const res = await userAgent.put('/api/auth/notifications', { phoneNumber: '123' });
    expect(res.status).toBe(400);
  });

  it('refuses to enable SMS without a phone on file', async () => {
    const res = await userAgent.put('/api/auth/notifications', {
      reminderSmsEnabled: true
    });
    expect(res.status).toBe(400);
  });

  it('stores a valid phone number and lets SMS be enabled', async () => {
    const r1 = await userAgent.put('/api/auth/notifications', {
      phoneNumber: '+1 (555) 123-4567'
    });
    expect(r1.status).toBe(200);
    expect(r1.body.phoneNumber).toBe('+1 (555) 123-4567');

    const r2 = await userAgent.put('/api/auth/notifications', { reminderSmsEnabled: true });
    expect(r2.status).toBe(200);
    expect(r2.body.reminderSmsEnabled).toBe(true);
  });

  it('clears a phone number when an empty string is sent', async () => {
    const r = await userAgent.put('/api/auth/notifications', { phoneNumber: '' });
    expect(r.body.phoneNumber).toBe('');
    // Re-add for downstream tests.
    await userAgent.put('/api/auth/notifications', { phoneNumber: '+1 (555) 123-4567' });
  });
});

// ── Admin send-reminders ────────────────────────────────────────────────────

describe('POST /api/admin/send-reminders', () => {
  it('requires admin', async () => {
    const res = await userAgent.post('/api/admin/send-reminders', {
      deliveryDate: '2099-12-31'
    });
    expect(res.status).toBe(403);
  });

  it('rejects malformed dates', async () => {
    const res = await adminAgent.post('/api/admin/send-reminders', { deliveryDate: 'foo' });
    expect(res.status).toBe(400);
  });

  it('sends email and SMS for matching deliveries', async () => {
    notifier._drain();  // clear any prior buffered sends

    // The order's first delivery is 7 days from today, so we target that date.
    const sched = await userAgent.get(`/api/orders/${activeOrder.id}/schedule`);
    const targetDate = sched.body.nextActive;

    const res = await adminAgent.post('/api/admin/send-reminders', { deliveryDate: targetDate });
    expect(res.status).toBe(200);
    expect(res.body.emailsSent).toBe(1);
    expect(res.body.smsSent).toBe(1);

    const sends = notifier._drain();
    expect(sends).toHaveLength(2);
    const email = sends.find(s => s.channel === 'email');
    const sms   = sends.find(s => s.channel === 'sms');
    expect(email.to).toBe('carol@example.com');
    expect(email.subject).toContain(targetDate);
    expect(sms.to).toBe('+1 (555) 123-4567');
  });

  it('is idempotent — re-running for the same date sends nothing', async () => {
    notifier._drain();
    const sched = await userAgent.get(`/api/orders/${activeOrder.id}/schedule`);
    const targetDate = sched.body.nextActive;

    const res = await adminAgent.post('/api/admin/send-reminders', { deliveryDate: targetDate });
    expect(res.status).toBe(200);
    expect(res.body.emailsSent).toBe(0);
    expect(res.body.smsSent).toBe(0);
    expect(notifier._drain()).toHaveLength(0);
  });

  it('skips users whose next delivery does not match the target date', async () => {
    const res = await adminAgent.post('/api/admin/send-reminders', { deliveryDate: '2099-01-01' });
    expect(res.status).toBe(200);
    expect(res.body.emailsSent).toBe(0);
    expect(res.body.smsSent).toBe(0);
    expect(res.body.skipped).toBeGreaterThanOrEqual(1);
  });
});
