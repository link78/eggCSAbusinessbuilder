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
      stripe_customer_id TEXT,
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
      stripe_subscription_id TEXT,
      stripe_price_id      TEXT,
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
      delivery_fee_enabled BOOLEAN NOT NULL DEFAULT true,
      delivery_frequency   TEXT NOT NULL DEFAULT 'biweekly',
      eggs_per_delivery    INTEGER NOT NULL DEFAULT 0
    );
  `);

  // ── Schema migrations (run before seeding so seeds can reference new cols) ──
  // Existing databases that pre-date the bi-weekly columns get them added here.
  await query(`ALTER TABLE plan_config ADD COLUMN IF NOT EXISTS delivery_frequency TEXT NOT NULL DEFAULT 'biweekly'`);
  await query(`ALTER TABLE plan_config ADD COLUMN IF NOT EXISTS eggs_per_delivery INTEGER NOT NULL DEFAULT 0`);

  // ── Seed plan configurations ─────────────────────────────────────────────────
  // Insert default plan config rows; skip if they already exist (idempotent).
  await seedPlanConfig();

  // Keep eggs_per_delivery aligned with eggs_per_week on existing rows
  // (handles pre-migration data and any manual edits).
  await query(`UPDATE plan_config SET eggs_per_delivery = eggs_per_week * 2 WHERE eggs_per_delivery <> eggs_per_week * 2`);

  // ── Schema migrations ────────────────────────────────────────────────────────
  // Add notes column to users if it doesn't exist yet (idempotent)
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT ''`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`);

  // Farm updates posted by admin
  await query(`
    CREATE TABLE IF NOT EXISTS farm_updates (
      id            SERIAL PRIMARY KEY,
      author        TEXT    NOT NULL DEFAULT 'Sakinah Ridge Farm',
      date_label    TEXT    NOT NULL,
      body          TEXT    NOT NULL,
      photo_caption TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Add photo_url column to farm_updates if it doesn't exist yet (idempotent)
  await query(`ALTER TABLE farm_updates ADD COLUMN IF NOT EXISTS photo_url TEXT`);

  // Add image_urls (array) column to farm_updates for multi-image support (idempotent)
  await query(`ALTER TABLE farm_updates ADD COLUMN IF NOT EXISTS image_urls TEXT[] NOT NULL DEFAULT '{}'`);

  // ── Bi-weekly delivery support ──────────────────────────────────────────────
  // Subscription deliveries occur every 2 weeks. We persist:
  //   - delivery_frequency: e.g. 'biweekly' (string for forward-compatibility)
  //   - eggs_per_delivery:  total eggs handed off in a single delivery
  //                         (= eggs_per_week * 2 for biweekly plans)
  // Both are added idempotently so existing databases migrate cleanly.
  await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_frequency TEXT NOT NULL DEFAULT 'biweekly'`);
  await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS eggs_per_delivery INTEGER`);
  await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT`);
  await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_price_id TEXT`);
  // Backfill eggs_per_delivery for existing orders that predate the column.
  await query(`UPDATE orders SET eggs_per_delivery = eggs_per_week * 2 WHERE eggs_per_delivery IS NULL`);

  // Likes (thumbs-up) on farm updates. Composite PK enforces one like per
  // user per update; ON DELETE CASCADE cleans up automatically.
  await query(`
    CREATE TABLE IF NOT EXISTS farm_update_likes (
      update_id  INTEGER NOT NULL REFERENCES farm_updates(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (update_id, user_id)
    )
  `);

  // Editable about-page content sections
  await query(`
    CREATE TABLE IF NOT EXISTS about_content (
      id           SERIAL PRIMARY KEY,
      section_key  TEXT UNIQUE NOT NULL,
      content_json TEXT        NOT NULL DEFAULT '{}',
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Seed default about content rows (idempotent)
  await seedAboutContent();

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
  // Plans deliver every 2 weeks; eggs_per_delivery is auto-derived as
  // eggs_per_week * 2 to keep the schema and bookkeeping in sync.
  await query(`
    INSERT INTO plan_config (plan_key, display_name, price_monthly, eggs_per_week, delivery_fee_enabled, delivery_frequency, eggs_per_delivery)
    VALUES
      ('small_family', 'Small Family',  20, 12, true, 'biweekly', 24),
      ('family',       'Family',        28, 18, true, 'biweekly', 36),
      ('solo_couple',  'Solo / Couple', 10, 12, true, 'biweekly', 24),
      ('custom',       'Custom Plan',    0, 24, true, 'biweekly', 48)
    ON CONFLICT (plan_key) DO NOTHING
  `);
}
/**
 * Seed the about_content table with default section content.
 * Uses INSERT ... ON CONFLICT DO NOTHING so it is safe to call multiple times.
 */
async function seedAboutContent() {
  const defaults = [
    {
      key: 'our_story',
      value: JSON.stringify({
        heading: 'Our Story',
        text: 'Sakinah Ridge Farm began as a small family project rooted in faith, stewardship, and community. We started with a handful of hens and a simple goal: provide fresh, honest food to neighbors in and around Raymond. Today, we remain committed to careful farming, healthy animals, and relationships built on trust.'
      })
    },
    {
      key: 'hens_care',
      value: JSON.stringify({
        heading: 'How We Raise Our Hens',
        cards: [
          { icon: '🌿', title: 'Free-Range / Pasture Access', text: 'Our hens have daily access to pasture where they can roam, scratch, and forage naturally.' },
          { icon: '💧', title: 'Clean Feed & Fresh Water',    text: 'We provide quality feed and constant clean water to keep our flock healthy and productive.' },
          { icon: '🤍', title: 'Humane, Stress-Free Environment', text: 'Low-stress care and clean living space help support stronger birds and better eggs.' }
        ]
      })
    },
    {
      key: 'eggs_special',
      value: JSON.stringify({
        heading: 'What Makes Our Eggs Different',
        items: ['Collected fresh daily', 'Rich yolks & strong shells', 'No antibiotics or hormones', 'Raised with care and Sakinah']
      })
    },
    {
      key: 'flock',
      value: JSON.stringify({
        heading: 'Meet the Flock',
        members: [
          { icon: '🐔', name: 'Ruby' },
          { icon: '🐓', name: 'Atlas' },
          { icon: '🐔', name: 'Sunny' },
          { icon: '🐔', name: 'Pearl' },
          { icon: '🐔', name: 'Maple' },
          { icon: '🐔', name: 'Clover' }
        ]
      })
    }
  ];

  for (const { key, value } of defaults) {
    await query(
      `INSERT INTO about_content (section_key, content_json)
       VALUES ($1, $2)
       ON CONFLICT (section_key) DO NOTHING`,
      [key, value]
    );
  }
}

/**
 * Truncate all tables and reset sequences.
 * Only safe to call in test environments.
 */
async function reset() {
  await query(
    'TRUNCATE users, orders, reviews, checklist_progress, plan_config, farm_updates, farm_update_likes, about_content RESTART IDENTITY CASCADE'
  );
  // Re-seed plan configurations so tests always start with a known state.
  await seedPlanConfig();
  await seedAboutContent();
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
