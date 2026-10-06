'use strict';

const { err, isIntegerLike } = require('./helpers');
const time = require('./time');

const STARTS_AT_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function findTable(restaurant, tableId) {
  return restaurant.tables.find((t) => t.id === tableId) || null;
}

// Validates a fully-merged set of booking fields against a restaurant's
// grid/hours/gap/capacity rules. Does not check table availability against
// other reservations; callers decide overlap-exclusion semantics.
function validateFieldsAndResolve(restaurant, { tableId, startsAtLocal, partySize }) {
  if (typeof tableId !== 'string' || tableId.length === 0) {
    throw err(422, 'validation_failed', 'table_id is required');
  }
  if (typeof startsAtLocal !== 'string') {
    throw err(400, 'malformed_request', 'starts_at_local must be a string');
  }
  const m = STARTS_AT_LOCAL_RE.exec(startsAtLocal);
  if (!m) {
    throw err(422, 'validation_failed', 'starts_at_local must be a bare local YYYY-MM-DDTHH:MM');
  }
  if (!isIntegerLike(partySize) || partySize < 1) {
    throw err(422, 'validation_failed', 'party_size must be a positive integer');
  }

  const table = findTable(restaurant, tableId);
  if (!table) throw err(404, 'not_found', 'Unknown table, or it belongs to another restaurant');

  const [, yStr, moStr, dStr, hStr, miStr] = m;
  const y = Number(yStr), mo = Number(moStr), d = Number(dStr), h = Number(hStr), mi = Number(miStr);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) {
    throw err(422, 'validation_failed', 'starts_at_local is not a valid date/time');
  }

  const resolved = time.localToUtc(restaurant.timezone, y, mo, d, h, mi);
  if (!resolved) {
    throw err(422, 'invalid_local_time', 'That local time does not exist (DST transition)');
  }
  const startsAtMs = resolved.utcMs;
  const endsAtMs = startsAtMs + restaurant.reservation_duration_minutes * 60000;

  const dateStr = `${yStr}-${moStr}-${dStr}`;
  const weekday = time.weekdayOf(dateStr);
  const hours = restaurant.opening_hours.find((oh) => oh.weekday === weekday);
  if (!hours) {
    throw err(422, 'outside_opening_hours', 'Restaurant is closed that day');
  }
  const opensMin = time.hhmmToMinutes(hours.opens);
  const closesMin = time.hhmmToMinutes(hours.closes);
  const startMin = h * 60 + mi;

  if ((startMin - opensMin) % restaurant.slot_minutes !== 0) {
    throw err(422, 'not_on_slot_grid', 'starts_at_local is not on the slot grid');
  }
  if (startMin < opensMin || startMin + restaurant.reservation_duration_minutes > closesMin) {
    throw err(422, 'outside_opening_hours', 'Reservation falls outside opening hours');
  }
  if (partySize > table.capacity) {
    throw err(422, 'party_exceeds_capacity', 'party_size exceeds the table capacity');
  }

  return {
    table, startsAtMs, endsAtMs, partySize, startsAtLocal,
  };
}

function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// True if some other confirmed reservation (not in excludeIds) occupies the
// same table during an overlapping interval.
function hasOverlap(state, tableId, startsAtMs, endsAtMs, excludeIds) {
  for (const res of state.reservations.values()) {
    if (res.status !== 'confirmed') continue;
    if (res.table_id !== tableId) continue;
    if (excludeIds.has(res.id)) continue;
    if (intervalsOverlap(startsAtMs, endsAtMs, res.starts_at_ms, res.ends_at_ms)) return true;
  }
  return false;
}

function serializeReservation(res, restaurant) {
  return {
    reservation_id: res.id,
    reference: res.reference,
    restaurant_id: res.restaurant_id,
    table_id: res.table_id,
    party_size: res.party_size,
    status: res.status,
    starts_at_local: res.starts_at_local,
    starts_at: time.formatRfc3339(restaurant.timezone, res.starts_at_ms),
    ends_at: time.formatRfc3339(restaurant.timezone, res.ends_at_ms),
    created_at: time.formatUtcRfc3339(res.created_at_ms),
  };
}

module.exports = { validateFieldsAndResolve, hasOverlap, intervalsOverlap, serializeReservation, findTable };
