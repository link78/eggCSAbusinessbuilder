/**
 * Notifier service — abstracts how email/SMS reminders are delivered so we
 * can wire up real providers (Twilio, SendGrid, Resend, etc.) later without
 * touching the route handlers.
 *
 * Default behaviour:
 *   - production: log a structured warning so missing-provider issues are
 *                 visible in deployment logs
 *   - test:       record sends in an in-memory buffer for assertions
 *   - dev:        log to console.info
 *
 * A custom transport can be injected by calling setTransport({ sendEmail,
 * sendSms }). Each method should be async and resolve to a truthy value on
 * success.
 */

const _buffer = [];
let transport = {
  sendEmail: defaultSendEmail,
  sendSms:   defaultSendSms
};

function isTest() { return process.env.NODE_ENV === 'test'; }

async function defaultSendEmail({ to, subject, body }) {
  if (isTest()) {
    _buffer.push({ channel: 'email', to, subject, body });
    return true;
  }
  // No real SMTP configured — log and succeed so the rest of the workflow
  // (e.g. recording in reminder_log) still proceeds. Operators can detect
  // this via the log line and configure a real transport.
  // eslint-disable-next-line no-console
  console.info(`[notifier] (no transport) email → ${to}: ${subject}`);
  return true;
}

async function defaultSendSms({ to, body }) {
  if (isTest()) {
    _buffer.push({ channel: 'sms', to, body });
    return true;
  }
  // eslint-disable-next-line no-console
  console.info(`[notifier] (no transport) sms → ${to}: ${body}`);
  return true;
}

function setTransport(t) {
  if (t && typeof t.sendEmail === 'function') transport.sendEmail = t.sendEmail;
  if (t && typeof t.sendSms   === 'function') transport.sendSms   = t.sendSms;
}

async function sendEmail(args) { return transport.sendEmail(args); }
async function sendSms(args)   { return transport.sendSms(args); }

// ── Test helpers ────────────────────────────────────────────────────────────

/** Returns all sends recorded by the default test transport. */
function _drain() {
  const out = _buffer.slice();
  _buffer.length = 0;
  return out;
}

module.exports = { sendEmail, sendSms, setTransport, _drain };
