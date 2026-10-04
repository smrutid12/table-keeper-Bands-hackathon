'use strict';

const { err, isIntegerLike } = require('./helpers');
const time = require('./time');
const policyModule = require('./policy');

const STARTS_AT_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function findTable(restaurant, tableId) {
  return restaurant.tables.find((t) => t.id === tableId) || null;
}

// Resolves a requested table set (1 table, or a declared combinable pair)
// against the restaurant's table/combinable config. Returns the tables in
// canonical order (matching `combinable`'s declared order for a pair) or
// throws ApiError.
function resolveTableSet(restaurant, tableIds) {
  if (!Array.isArray(tableIds) || tableIds.length === 0) {
    throw err(422, 'validation_failed', 'table_ids is required');
  }
  for (const id of tableIds) {
    if (typeof id !== 'string' || id.length === 0) {
      throw err(400, 'malformed_request', 'table_ids must be an array of strings');
    }
  }
  const unique = new Set(tableIds);
  if (unique.size !== tableIds.length) {
    throw err(422, 'validation_failed', 'Duplicate table id in the set');
  }
  if (tableIds.length > 2) {
    throw err(422, 'combination_not_allowed', 'At most two tables may be combined');
  }

  const tables = tableIds.map((id) => findTable(restaurant, id));
  if (tables.some((t) => !t)) {
    throw err(404, 'not_found', 'Unknown table, or it belongs to another restaurant');
  }

  if (tableIds.length === 1) {
    return { tableIds: [tables[0].id], tables };
  }

  const pair = restaurant.combinable.find((p) => (
    (p[0] === tableIds[0] && p[1] === tableIds[1]) || (p[0] === tableIds[1] && p[1] === tableIds[0])
  ));
  if (!pair) {
    throw err(422, 'combination_not_allowed', 'That pair is not combinable');
  }
  const orderedTables = pair.map((id) => tables.find((t) => t.id === id));
  return { tableIds: pair.slice(), tables: orderedTables };
}

// Validates a fully-merged set of booking fields against a restaurant's
// grid/hours/gap/capacity rules. Does not check table availability against
// other reservations; callers decide overlap-exclusion semantics.
function validateFieldsAndResolve(restaurant, { tableIds, startsAtLocal, partySize }) {
  const resolvedSet = resolveTableSet(restaurant, tableIds);

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

  const dateStr = `${yStr}-${moStr}-${dStr}`;
  const policy = policyModule.selectPolicy(restaurant, dateStr);
  const endsAtMs = startsAtMs + policy.reservation_duration_minutes * 60000;

  const weekday = time.weekdayOf(dateStr);
  const hours = policy.opening_hours.find((oh) => oh.weekday === weekday);
  if (!hours) {
    throw err(422, 'outside_opening_hours', 'Restaurant is closed that day');
  }
  const opensMin = time.hhmmToMinutes(hours.opens);
  const closesMin = time.hhmmToMinutes(hours.closes);
  const startMin = h * 60 + mi;

  if ((startMin - opensMin) % policy.slot_minutes !== 0) {
    throw err(422, 'not_on_slot_grid', 'starts_at_local is not on the slot grid');
  }
  if (startMin < opensMin || startMin + policy.reservation_duration_minutes > closesMin) {
    throw err(422, 'outside_opening_hours', 'Reservation falls outside opening hours');
  }

  const capacity = resolvedSet.tableIds.reduce((sum, id) => sum + (policy.capacities[id] || 0), 0);
  if (partySize > capacity) {
    throw err(422, 'party_exceeds_capacity', 'party_size exceeds the combination capacity');
  }

  return {
    tables: resolvedSet.tables,
    tableIds: resolvedSet.tableIds,
    startsAtMs,
    endsAtMs,
    partySize,
    startsAtLocal,
    policy,
  };
}

// Reads table_id/table_ids from a request body. `currentTableIds`, when
// given, is used as the default when neither field is present (amend/move
// semantics); when omitted, at least one of the fields is required (create
// semantics).
function extractTableIds(body, currentTableIds) {
  if (body.table_id !== undefined && body.table_ids !== undefined) {
    throw err(422, 'validation_failed', 'Send only one of table_id or table_ids');
  }
  if (body.table_ids !== undefined) {
    if (!Array.isArray(body.table_ids)) {
      throw err(400, 'malformed_request', 'table_ids must be an array');
    }
    return body.table_ids;
  }
  if (body.table_id !== undefined) {
    if (typeof body.table_id !== 'string') {
      throw err(400, 'malformed_request', 'table_id must be a string');
    }
    return [body.table_id];
  }
  if (currentTableIds !== undefined) return currentTableIds;
  throw err(422, 'validation_failed', 'table_id or table_ids is required');
}

// Checked before cutoff/validation per spec. No-op when `expected_revision`
// is absent (stage-1 semantics).
function checkExpectedRevision(body, currentRevision) {
  if (body.expected_revision === undefined) return;
  const v = body.expected_revision;
  if (!isIntegerLike(v) || v < 1) {
    throw err(422, 'validation_failed', 'expected_revision must be a positive integer');
  }
  if (v !== currentRevision) {
    throw err(409, 'stale_revision', 'The reservation has changed since expected_revision was read');
  }
}

function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function setsIntersect(a, b) {
  const bSet = new Set(b);
  return a.some((id) => bSet.has(id));
}

// True if some other confirmed reservation (not in excludeIds) shares a
// table with `tableIds` during an overlapping interval.
function hasOverlap(state, tableIds, startsAtMs, endsAtMs, excludeIds) {
  for (const res of state.reservations.values()) {
    if (res.status !== 'confirmed') continue;
    if (excludeIds.has(res.id)) continue;
    if (!setsIntersect(res.table_ids, tableIds)) continue;
    if (intervalsOverlap(startsAtMs, endsAtMs, res.starts_at_ms, res.ends_at_ms)) return true;
  }
  return false;
}

function serializeReservation(res, restaurant) {
  const out = {
    reservation_id: res.id,
    reference: res.reference,
    restaurant_id: res.restaurant_id,
    table_ids: res.table_ids,
    party_size: res.party_size,
    status: res.status,
    starts_at_local: res.starts_at_local,
    starts_at: time.formatRfc3339(restaurant.timezone, res.starts_at_ms),
    ends_at: time.formatRfc3339(restaurant.timezone, res.ends_at_ms),
    created_at: time.formatUtcRfc3339(res.created_at_ms),
    revision: res.revision,
    accepted_terms: res.accepted_terms,
  };
  if (res.table_ids.length === 1) out.table_id = res.table_ids[0];
  return out;
}

module.exports = {
  validateFieldsAndResolve, resolveTableSet, extractTableIds, hasOverlap, intervalsOverlap,
  setsIntersect, serializeReservation, findTable, checkExpectedRevision,
};
