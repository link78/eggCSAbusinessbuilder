/**
 * Public add-on catalog + admin-facing input validator.
 *
 * - GET /api/addons              → list active add-ons (customer browse)
 * - GET /api/addons?includeInactive=true → list all (admin previews)
 *
 * Per-subscription add-on selections (POST/DELETE on /api/orders/:id/addons)
 * live in routes/orders.js so they share the order-ownership middleware and
 * URL structure with the rest of the subscription API.
 *
 * Admin CRUD endpoints (POST/PUT/DELETE /api/admin/addons) live in
 * routes/admin.js and share the requireAdmin middleware.
 */

const express = require('express');
const db      = require('../db');

const router = express.Router();

function validateAddonInput(body, { partial = false } = {}) {
  const out = {};

  if (body.name !== undefined || !partial) {
    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
      return { error: 'name is required.' };
    }
    out.name = body.name.trim().slice(0, 120);
  }

  if (body.description !== undefined) {
    out.description = String(body.description || '').trim().slice(0, 2000);
  } else if (!partial) {
    out.description = '';
  }

  if (body.priceCents !== undefined || !partial) {
    const cents = parseInt(body.priceCents, 10);
    if (!Number.isInteger(cents) || cents < 0 || cents > 100000) {
      return { error: 'priceCents must be an integer between 0 and 100000.' };
    }
    out.priceCents = cents;
  }

  if (body.photoUrl !== undefined) {
    out.photoUrl = body.photoUrl ? String(body.photoUrl).trim().slice(0, 500) : null;
  }

  if (body.active !== undefined) {
    out.active = body.active === true || body.active === 'true';
  } else if (!partial) {
    out.active = true;
  }

  return { values: out };
}

// GET /api/addons — public catalog (active only unless ?includeInactive=true)
router.get('/', async (req, res) => {
  const includeInactive = req.query.includeInactive === 'true';
  const rows = (await db.query(
    `SELECT id, name, description, price_cents, photo_url, active, created_at
     FROM addons
     ${includeInactive ? '' : 'WHERE active = true'}
     ORDER BY name ASC`
  )).rows;
  res.json({ addons: rows });
});

module.exports = { router, validateAddonInput };
