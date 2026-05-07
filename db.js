const { Pool } = require('pg');

// Requires DATABASE_URL env var pointing at your Neon PostgreSQL host.
// Neon uses a CA-signed certificate, so standard TLS verification applies.
// The connection string should include sslmode=require (Neon provides this
// by default in its connection strings).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: true,
  family: 4,          // force IPv4; prevents ENETUNREACH on IPv6-only hosts
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

/**
 * Run a parameterised SQL query.
 * Uses $1, $2, … placeholders (PostgreSQL style).
 */
async function query(text, params) {
  return pool.query(text, params);
}

// ── Schema ──────────────────────────────────────────────────────────────────

async function init() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      name          TEXT    NOT NULL,
      email         TEXT    UNIQUE NOT NULL,
      password_hash TEXT    NOT NULL,
      role          TEXT    NOT NULL DEFAULT 'user',
      avatar_url    TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id                   SERIAL PRIMARY KEY,
      user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_name            TEXT    NOT NULL,
      price                INTEGER NOT NULL,
      eggs_per_week        INTEGER NOT NULL,
      status               TEXT    NOT NULL DEFAULT 'active',
      fulfillment_method   TEXT    NOT NULL DEFAULT 'pickup',
      delivery_address     TEXT,
      pickup_day           TEXT,
      next_billing_date    TEXT,
      boxes_per_delivery   INTEGER,
      duration_weeks       INTEGER,
      boxes12_per_delivery INTEGER,
      boxes18_per_delivery INTEGER,
      created_at           TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_name  TEXT    NOT NULL,
      rating     INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
      title      TEXT    NOT NULL,
      body       TEXT    NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS checklist_progress (
      user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      completed_steps TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS plan_config (
      id                   SERIAL PRIMARY KEY,
      plan_key             TEXT UNIQUE NOT NULL,
      display_name         TEXT NOT NULL,
      price_monthly        INTEGER NOT NULL,
      eggs_per_week        INTEGER NOT NULL,
      delivery_fee_enabled BOOLEAN NOT NULL DEFAULT true
    );
  `);

  // ── Seed plan configurations ─────────────────────────────────────────────────
  // Insert default plan config rows; skip if they already exist (idempotent).
  await seedPlanConfig();

  // ── Schema migrations ────────────────────────────────────────────────────────
  // Add notes column to users if it doesn't exist yet (idempotent)
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT ''`);

  // ── Seed admins ─────────────────────────────────────────────────────────────
  // Promote known admin accounts if they exist.
  const adminEmails = ['absalim78@yahoo.com', 'koandak@hotmail.com'];
  for (const email of adminEmails) {
    const target = (await query('SELECT id FROM users WHERE email = $1', [email])).rows[0];
    if (target) {
      await query("UPDATE users SET role = 'admin' WHERE id = $1", [target.id]);
    }
  }
}

/**
 * Seed the plan_config table with default plan configurations.
 * Uses INSERT ... ON CONFLICT DO NOTHING so it is safe to call multiple times.
 */
async function seedPlanConfig() {
  await query(`
    INSERT INTO plan_config (plan_key, display_name, price_monthly, eggs_per_week, delivery_fee_enabled)
    VALUES
      ('small_family', 'Small Family',  20, 12, true),
      ('family',       'Family',        28, 18, true),
      ('solo_couple',  'Solo / Couple', 10, 12, true),
      ('custom',       'Custom Plan',    0, 24, true)
    ON CONFLICT (plan_key) DO NOTHING
  `);
}
/**
 * Truncate all tables and reset sequences.
 * Only safe to call in test environments.
 */
async function reset() {
  await query(
    'TRUNCATE users, orders, reviews, checklist_progress, plan_config RESTART IDENTITY CASCADE'
  );
  // Re-seed plan configurations so tests always start with a known state.
  await seedPlanConfig();
}

/**
 * Close all pool connections.
 * Call this in test teardown (afterAll) to avoid open handle warnings.
 */
async function close() {
  await pool.end();
}

// Kick off schema initialisation immediately on require().
const ready = init();

module.exports = { query, pool, reset, close, ready };

