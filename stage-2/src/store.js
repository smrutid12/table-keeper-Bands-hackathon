'use strict';

const { hashPassword } = require('./passwords');
const { localToUtc } = require('./time');

// Single global, in-memory, synchronously-mutated state. All write
// endpoints run fully synchronously (no awaits between reading and
// committing state) so that Node's single-threaded event loop gives us
// atomicity for free across "concurrent" requests.

let state = freshState();

function freshState() {
  return {
    users: new Map(), // id -> {id, email, password_hash, display_name}
    emailIndex: new Map(), // lowercased email -> user id
    tokens: new Map(), // token -> user id
    restaurants: new Map(), // id -> restaurant
    reservations: new Map(), // id -> reservation
    referenceIndex: new Map(), // reference -> reservation id
    idempotency: new Map(), // composite key -> record
  };
}

function getState() { return state; }

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}

function canonicalJSON(value) {
  return JSON.stringify(canonicalize(value));
}

function buildRestaurantFromFixture(r) {
  const tables = (r.tables || []).map((t) => ({
    id: String(t.id), label: t.label != null ? String(t.label) : String(t.id), capacity: Number(t.capacity),
  }));
  const combinable = (r.combinable || []).map((pair) => [String(pair[0]), String(pair[1])]);
  return {
    id: String(r.id),
    name: r.name != null ? String(r.name) : '',
    timezone: r.timezone,
    slot_minutes: Number(r.slot_minutes),
    reservation_duration_minutes: Number(r.reservation_duration_minutes),
    cancellation_cutoff_minutes: Number(r.cancellation_cutoff_minutes),
    opening_hours: (r.opening_hours || []).map((h) => ({
      weekday: h.weekday, opens: h.opens, closes: h.closes,
    })),
    tables,
    combinable,
  };
}

// Reservation records may come from a fixture (table_id or table_ids), or
// from an import produced by a stage-1 service (table_id only, no
// table_ids). Normalize to the table_ids array this service uses internally.
function normalizeTableIds(res) {
  if (Array.isArray(res.table_ids)) return res.table_ids.map(String);
  if (res.table_id !== undefined && res.table_id !== null) return [String(res.table_id)];
  return [];
}

function resolveReservationTimes(restaurant, startsAtLocal, durationMinutes) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(startsAtLocal);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  const resolved = localToUtc(restaurant.timezone, y, mo, d, h, mi);
  if (!resolved) return null;
  const startsAtMs = resolved.utcMs;
  const endsAtMs = startsAtMs + durationMinutes * 60000;
  return { startsAtMs, endsAtMs };
}

function resetState(fixture) {
  const next = freshState();

  for (const u of (fixture.users || [])) {
    const id = String(u.id);
    const record = {
      id,
      email: String(u.email),
      password_hash: hashPassword(String(u.password)),
      display_name: u.display_name != null ? String(u.display_name) : '',
    };
    next.users.set(id, record);
    next.emailIndex.set(record.email.toLowerCase(), id);
  }

  for (const r of (fixture.restaurants || [])) {
    const restaurant = buildRestaurantFromFixture(r);
    next.restaurants.set(restaurant.id, restaurant);
  }

  for (const res of (fixture.reservations || [])) {
    const restaurant = next.restaurants.get(String(res.restaurant_id));
    const id = String(res.id);
    const durationMinutes = restaurant ? restaurant.reservation_duration_minutes : 0;
    const times = restaurant
      ? resolveReservationTimes(restaurant, res.starts_at_local, durationMinutes)
      : null;
    const reservation = {
      id,
      reference: String(res.reference),
      user_id: String(res.user_id),
      restaurant_id: String(res.restaurant_id),
      table_ids: normalizeTableIds(res),
      party_size: Number(res.party_size),
      status: res.status === 'cancelled' ? 'cancelled' : 'confirmed',
      starts_at_local: res.starts_at_local,
      starts_at_ms: times ? times.startsAtMs : null,
      ends_at_ms: times ? times.endsAtMs : null,
      created_at_ms: Date.now(),
    };
    next.reservations.set(id, reservation);
    next.referenceIndex.set(reservation.reference, id);
  }

  state = next;
}

function exportState() {
  return {
    track: 'tablekeeper',
    format_version: 1,
    state: {
      users: Array.from(state.users.values()),
      emailIndex: Array.from(state.emailIndex.entries()),
      tokens: Array.from(state.tokens.entries()),
      restaurants: Array.from(state.restaurants.values()),
      reservations: Array.from(state.reservations.values()),
      referenceIndex: Array.from(state.referenceIndex.entries()),
      idempotency: Array.from(state.idempotency.entries()),
    },
  };
}

function isValidExportShape(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (obj.track !== 'tablekeeper') return false;
  if (obj.format_version !== 1) return false;
  if (!obj.state || typeof obj.state !== 'object') return false;
  const s = obj.state;
  const arrays = ['users', 'emailIndex', 'tokens', 'restaurants', 'reservations', 'referenceIndex', 'idempotency'];
  for (const k of arrays) {
    if (!Array.isArray(s[k])) return false;
  }
  return true;
}

function importState(obj) {
  if (!isValidExportShape(obj)) return false;
  const s = obj.state;
  const next = freshState();
  for (const u of s.users) next.users.set(u.id, u);
  for (const [k, v] of s.emailIndex) next.emailIndex.set(k, v);
  for (const [k, v] of s.tokens) next.tokens.set(k, v);
  for (const r of s.restaurants) {
    next.restaurants.set(r.id, { ...r, combinable: Array.isArray(r.combinable) ? r.combinable : [] });
  }
  for (const r of s.reservations) {
    next.reservations.set(r.id, { ...r, table_ids: normalizeTableIds(r) });
  }
  for (const [k, v] of s.referenceIndex) next.referenceIndex.set(k, v);
  for (const [k, v] of s.idempotency) next.idempotency.set(k, v);
  state = next;
  return true;
}

module.exports = {
  getState, resetState, exportState, importState, canonicalJSON,
  resolveReservationTimes,
};
