const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'egg_csa.db');

const db = new Database(DB_PATH);

// Enable WAL for better concurrency
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    email        TEXT    UNIQUE NOT NULL,
    password_hash TEXT   NOT NULL,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS orders (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_name     TEXT    NOT NULL,
    price         INTEGER NOT NULL,
    eggs_per_week INTEGER NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'active',
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_name  TEXT    NOT NULL,
    rating     INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
    title      TEXT    NOT NULL,
    body       TEXT    NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS checklist_progress (
    user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    completed_steps TEXT NOT NULL DEFAULT '[]'
  );
`);

// ── Migrations ───────────────────────────────────────────────────────────────
// Add subscription fulfillment columns to orders if they don't exist yet.
{
  const existing = db.prepare('PRAGMA table_info(orders)').all().map(c => c.name);

  if (!existing.includes('fulfillment_method')) {
    db.exec("ALTER TABLE orders ADD COLUMN fulfillment_method TEXT NOT NULL DEFAULT 'pickup'");
  }
  if (!existing.includes('delivery_address')) {
    db.exec('ALTER TABLE orders ADD COLUMN delivery_address TEXT');
  }
  if (!existing.includes('pickup_day')) {
    db.exec('ALTER TABLE orders ADD COLUMN pickup_day TEXT');
  }
  if (!existing.includes('next_billing_date')) {
    db.exec('ALTER TABLE orders ADD COLUMN next_billing_date TEXT');
  }
}

module.exports = db;
