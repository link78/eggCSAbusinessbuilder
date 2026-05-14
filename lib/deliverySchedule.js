/**
 * Delivery-schedule helpers.
 *
 * Subscriptions are biweekly (every 14 days). Given an order's first delivery
 * date, we can deterministically compute every future delivery date and apply
 * the customer's pause / single-skip preferences.
 *
 * Dates are handled as YYYY-MM-DD strings to avoid timezone surprises (a
 * delivery is a calendar date, not an instant in time).
 */

const DAY_MS               = 24 * 60 * 60 * 1000;
const DELIVERY_INTERVAL_DAYS = 14;  // biweekly

/** Parse YYYY-MM-DD into a UTC Date at 00:00. Returns null on bad input. */
function parseISODate(s) {
  if (!s || typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Format a Date as YYYY-MM-DD (UTC). */
function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

/** Today as a UTC YYYY-MM-DD-anchored Date. */
function todayUTC() {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

/** Add `days` to a Date and return a new Date. */
function addDays(d, days) {
  return new Date(d.getTime() + days * DAY_MS);
}

/**
 * Determine the canonical first delivery date for an order.
 * Preference order:
 *   1. The persisted `first_delivery_date` (set when the customer subscribes).
 *   2. Fall back to the order's created_at date (legacy orders).
 *
 * Always returns a Date or null if the order has no usable date.
 */
function orderFirstDeliveryDate(order) {
  if (!order) return null;
  if (order.first_delivery_date) {
    const d = parseISODate(order.first_delivery_date);
    if (d) return d;
  }
  if (order.created_at) {
    const ca = new Date(order.created_at);
    if (!Number.isNaN(ca.getTime())) {
      return new Date(Date.UTC(ca.getUTCFullYear(), ca.getUTCMonth(), ca.getUTCDate()));
    }
  }
  return null;
}

/**
 * Compute the next `count` delivery dates for an order, honoring:
 *   - paused_until                (no deliveries until that date inclusive)
 *   - skip_next_delivery_date     (skip that single date)
 *   - status                      (cancelled → empty list)
 *
 * Returns an array of objects: { date: 'YYYY-MM-DD', skipped: boolean }.
 * Skipped entries are still returned (with skipped: true) so the UI can show
 * "this delivery is skipped".
 */
function upcomingDeliveries(order, count = 6, fromDate = todayUTC()) {
  if (!order || order.status === 'cancelled') return [];
  if (count <= 0) return [];

  const first = orderFirstDeliveryDate(order);
  if (!first) return [];

  // Find the first delivery on/after `fromDate`.
  let candidate = first;
  if (candidate < fromDate) {
    const daysBetween = Math.floor((fromDate - candidate) / DAY_MS);
    const intervals   = Math.ceil(daysBetween / DELIVERY_INTERVAL_DAYS);
    candidate = addDays(first, intervals * DELIVERY_INTERVAL_DAYS);
  }

  const pausedUntil = parseISODate(order.paused_until);
  const skipDate    = order.skip_next_delivery_date || null;

  const out = [];
  // `count * 4` upper bound exists purely as a runaway-loop guard. We push
  // exactly one entry per iteration, so the loop normally exits after
  // `count` iterations; the multiplier just leaves headroom for any future
  // change that skips entries inside the loop without breaking us.
  const MAX_ITERATIONS = count * 4;
  let safety = 0;
  while (out.length < count && safety++ < MAX_ITERATIONS) {
    const iso = toISODate(candidate);
    const beforePause = pausedUntil && candidate <= pausedUntil;
    const isSkipped   = beforePause || iso === skipDate;
    out.push({ date: iso, skipped: !!isSkipped });
    candidate = addDays(candidate, DELIVERY_INTERVAL_DAYS);
  }
  return out;
}

/**
 * The next delivery date that will actually happen (i.e. not skipped).
 * Returns YYYY-MM-DD string or null if no upcoming non-skipped delivery
 * exists in the next ~year.
 */
function nextActiveDelivery(order, fromDate = todayUTC()) {
  const slots = upcomingDeliveries(order, 26, fromDate);
  const active = slots.find(s => !s.skipped);
  return active ? active.date : null;
}

module.exports = {
  DELIVERY_INTERVAL_DAYS,
  parseISODate,
  toISODate,
  todayUTC,
  addDays,
  orderFirstDeliveryDate,
  upcomingDeliveries,
  nextActiveDelivery,
};
