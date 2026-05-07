const { Pool } = require('pg');

// Requires DATABASE_URL env var in production (e.g. postgresql://user:pass@host/dbname).
// Falls back to a local development database if not set.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost/egg_csa',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
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
  `);

  // ── Seed admin ──────────────────────────────────────────────────────────────
  // Promote absalim78@yahoo.com to admin if the account already exists.
  const target = (await query("SELECT id FROM users WHERE email = 'absalim78@yahoo.com'")).rows[0];
  if (target) {
    await query("UPDATE users SET role = 'admin' WHERE id = $1", [target.id]);
  }
}

/**
 * Truncate all tables and reset sequences.
 * Only safe to call in test environments.
 */
async function reset() {
  await query(
    'TRUNCATE users, orders, reviews, checklist_progress RESTART IDENTITY CASCADE'
  );
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

