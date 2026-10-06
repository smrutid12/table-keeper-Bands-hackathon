'use strict';

const { err } = require('../helpers');
const { getState } = require('../store');
const { randomId } = require('../ids');
const { requireIdempotencyKey, resolveIdempotency, commitIdempotency } = require('../idempotency');
const booking = require('../booking');
const historyModule = require('../history');
const time = require('../time');
const { bumpSeriesRevision } = require('./reservations');

const MAX_TABLES = 6;
const MAX_PAIRS = 4;
const MAX_BOOKINGS = 6;

function requireManager(restaurant, user) {
  if (!restaurant.manager_user_ids.includes(user.id)) {
    throw err(403, 'forbidden', 'Not a manager of this restaurant');
  }
}

const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// Parses a full RFC3339 instant (explicit offset or "Z") to a UTC ms value.
// Returns null if the string isn't a validly-shaped instant.
function parseInstant(value) {
  if (typeof value !== 'string') return null;
  const m = INSTANT_RE.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, offsetStr] = m;
  const base = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (offsetStr === 'Z') return base;
  const sign = offsetStr[0] === '-' ? -1 : 1;
  const oh = Number(offsetStr.slice(1, 3));
  const om = Number(offsetStr.slice(4, 6));
  if (oh > 23 || om > 59) return null;
  return base - sign * (oh * 60 + om) * 60000;
}

// Every single table and every declared combinable pair, ranked: singles
// first in fixture order, then pairs in declared order, starting at 0.
function buildOptionList(restaurant) {
  const options = restaurant.tables.map((t) => ({ tableIds: [t.id] }));
  for (const pair of restaurant.combinable) options.push({ tableIds: pair.slice() });
  return options.map((o, rank) => ({ ...o, rank }));
}

function capacityUnder(acceptedTerms, tableIds) {
  return tableIds.reduce((sum, id) => sum + (acceptedTerms.capacities[id] || 0), 0);
}

// True if `tableIds` conflicts with a confirmed booking at this restaurant
// that is *not* one of the considered bookings (i.e. it keeps its existing
// assignment and must not be displaced).
function conflictsWithFixed(state, restaurant, tableIds, startsAtMs, endsAtMs, consideredIds) {
  for (const res of state.reservations.values()) {
    if (res.restaurant_id !== restaurant.id) continue;
    if (res.status !== 'confirmed') continue;
    if (consideredIds.has(res.id)) continue;
    if (!booking.setsIntersect(res.table_ids, tableIds)) continue;
    if (booking.intervalsOverlap(startsAtMs, endsAtMs, res.starts_at_ms, res.ends_at_ms)) return true;
  }
  return false;
}

function conflictsWithAppliedClosures(restaurant, tableIds, startsAtMs, endsAtMs) {
  return booking.isClosed(restaurant, tableIds, startsAtMs, endsAtMs);
}

function getConsideredBookings(state, restaurant, fromMs, toMs) {
  const list = [];
  for (const res of state.reservations.values()) {
    if (res.restaurant_id !== restaurant.id) continue;
    if (res.status !== 'confirmed') continue;
    if (!booking.intervalsOverlap(res.starts_at_ms, res.ends_at_ms, fromMs, toMs)) continue;
    list.push(res);
  }
  list.sort((a, b) => (a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0));
  return list;
}

// Exhaustive backtracking search, bounded by the spec's planning limits
// (<=6 tables, <=4 pairs, <=6 considered bookings -- at most 10 options per
// booking). Minimizes, in order: (1) count of bookings whose table set
// changes, (2) total unused seats, (3) the vector of chosen option ranks in
// reference order (the considered-bookings order, since that list is
// already reference-sorted).
function solve(state, restaurant, considered, closedTableId, fromMs, toMs) {
  const options = buildOptionList(restaurant);
  const consideredIds = new Set(considered.map((r) => r.id));

  const candidatesPerBooking = considered.map((res) => options.filter((opt) => {
    if (opt.tableIds.includes(closedTableId)) return false;
    if (capacityUnder(res.accepted_terms, opt.tableIds) < res.party_size) return false;
    if (conflictsWithFixed(state, restaurant, opt.tableIds, res.starts_at_ms, res.ends_at_ms, consideredIds)) return false;
    if (conflictsWithAppliedClosures(restaurant, opt.tableIds, res.starts_at_ms, res.ends_at_ms)) return false;
    return true;
  }));

  if (candidatesPerBooking.some((c) => c.length === 0)) return null;

  let best = null;
  const chosen = new Array(considered.length);

  function isBetter(changedCount, unusedSeats, rankVector) {
    if (!best) return true;
    if (changedCount !== best.changedCount) return changedCount < best.changedCount;
    if (unusedSeats !== best.unusedSeats) return unusedSeats < best.unusedSeats;
    for (let i = 0; i < rankVector.length; i++) {
      if (rankVector[i] !== best.rankVector[i]) return rankVector[i] < best.rankVector[i];
    }
    return false;
  }

  function dfs(idx, changedCount, unusedSeats, rankVector) {
    if (idx === considered.length) {
      if (isBetter(changedCount, unusedSeats, rankVector)) {
        best = { assignment: chosen.slice(), changedCount, unusedSeats, rankVector: rankVector.slice() };
      }
      return;
    }
    const res = considered[idx];
    for (const opt of candidatesPerBooking[idx]) {
      let conflict = false;
      for (let j = 0; j < idx; j++) {
        if (!booking.setsIntersect(opt.tableIds, chosen[j].tableIds)) continue;
        if (booking.intervalsOverlap(res.starts_at_ms, res.ends_at_ms, considered[j].starts_at_ms, considered[j].ends_at_ms)) {
          conflict = true;
          break;
        }
      }
      if (conflict) continue;

      chosen[idx] = opt;
      const changed = !historyModule.sameTableIds(res.table_ids, opt.tableIds);
      const unused = capacityUnder(res.accepted_terms, opt.tableIds) - res.party_size;
      rankVector.push(opt.rank);
      dfs(idx + 1, changedCount + (changed ? 1 : 0), unusedSeats + unused, rankVector);
      rankVector.pop();
    }
  }

  dfs(0, 0, 0, []);
  return best;
}

function serializePlanPreview(plan, restaurant, state) {
  return {
    plan_id: plan.id,
    restaurant_revision: restaurant.revision,
    closure: {
      table_id: plan.table_id,
      from: time.formatRfc3339(restaurant.timezone, plan.from_ms),
      to: time.formatRfc3339(restaurant.timezone, plan.to_ms),
    },
    assignments: plan.assignments.map((a) => ({
      reference: state.reservations.get(a.reservation_id).reference,
      table_ids: a.table_ids.slice(),
      changed: a.changed,
    })),
    moved_count: plan.moved_count,
    unused_seats: plan.unused_seats,
  };
}

function createReplan(user, headers, restaurantId, parsedBody) {
  const key = requireIdempotencyKey(headers);
  const state = getState();
  const path = `/restaurants/${restaurantId}/replans`;

  const idem = resolveIdempotency(state, user.id, 'POST', path, key, parsedBody);
  if (idem.replay) return idem.replay;

  const restaurant = state.restaurants.get(restaurantId);
  if (!restaurant) throw err(404, 'not_found', 'Unknown restaurant');
  requireManager(restaurant, user);

  if (typeof parsedBody.table_id !== 'string' || parsedBody.table_id.length === 0) {
    throw err(422, 'validation_failed', 'table_id is required');
  }
  const fromMs = parseInstant(parsedBody.from);
  const toMs = parseInstant(parsedBody.to);
  if (fromMs === null || toMs === null || !(fromMs < toMs)) {
    throw err(422, 'validation_failed', 'from and to must be valid RFC3339 instants with from < to');
  }
  const table = booking.findTable(restaurant, parsedBody.table_id);
  if (!table) throw err(404, 'not_found', 'Unknown table');

  if (restaurant.tables.length > MAX_TABLES || restaurant.combinable.length > MAX_PAIRS) {
    throw err(422, 'planning_limit', 'This restaurant exceeds the seating-repair planning limits');
  }
  const considered = getConsideredBookings(state, restaurant, fromMs, toMs);
  if (considered.length > MAX_BOOKINGS) {
    throw err(422, 'planning_limit', 'Too many overlapping bookings to plan around');
  }

  const result = solve(state, restaurant, considered, table.id, fromMs, toMs);
  if (!result) throw err(409, 'no_feasible_plan', 'No feasible seating plan exists for this closure');

  const planId = randomId('plan');
  const plan = {
    id: planId,
    restaurant_id: restaurant.id,
    table_id: table.id,
    from_ms: fromMs,
    to_ms: toMs,
    assignments: considered.map((res, i) => ({
      reservation_id: res.id,
      table_ids: result.assignment[i].tableIds.slice(),
      changed: !historyModule.sameTableIds(res.table_ids, result.assignment[i].tableIds),
    })),
    moved_count: result.changedCount,
    unused_seats: result.unusedSeats,
    created_at_revision: restaurant.revision,
    status: 'proposed',
  };
  state.plans.set(planId, plan);

  const responseBody = serializePlanPreview(plan, restaurant, state);
  commitIdempotency(state, idem.ck, parsedBody, responseBody);
  return { status: 201, body: responseBody };
}

function applyReplan(user, headers, restaurantId, planId, parsedBody) {
  const key = requireIdempotencyKey(headers);
  const state = getState();
  const path = `/restaurants/${restaurantId}/replans/${planId}/apply`;

  const idem = resolveIdempotency(state, user.id, 'POST', path, key, parsedBody);
  if (idem.replay) return idem.replay;

  const restaurant = state.restaurants.get(restaurantId);
  if (!restaurant) throw err(404, 'not_found', 'Unknown restaurant');
  requireManager(restaurant, user);

  const plan = state.plans.get(planId);
  if (!plan || plan.restaurant_id !== restaurant.id) throw err(404, 'not_found', 'Unknown plan');

  if (plan.status === 'applied') {
    throw err(409, 'plan_already_applied', 'This plan has already been applied under a different idempotency key');
  }
  if (restaurant.revision !== plan.created_at_revision) {
    throw err(409, 'stale_plan', 'The restaurant has changed since this plan was created');
  }

  // Apply atomically: synchronous critical section, no awaits.
  restaurant.closures.push({ table_id: plan.table_id, from_ms: plan.from_ms, to_ms: plan.to_ms, plan_id: plan.id });

  const movedSeriesIds = new Set();
  const reservationsOut = [];
  for (const a of plan.assignments) {
    const res = state.reservations.get(a.reservation_id);
    if (a.changed) {
      const fromTableIds = res.table_ids.slice();
      res.table_ids = a.table_ids.slice();
      res.revision += 1;
      historyModule.appendHistory(
        res,
        'reassigned',
        [{ field: 'table_ids', from: fromTableIds, to: res.table_ids.slice() }],
        plan.id,
      );
      if (res.series_id) movedSeriesIds.add(res.series_id);
    }
    reservationsOut.push(booking.serializeReservation(res, restaurant));
  }
  for (const seriesId of movedSeriesIds) bumpSeriesRevision(state, seriesId);

  plan.status = 'applied';
  restaurant.revision += 1;

  const responseBody = { plan_id: plan.id, restaurant_revision: restaurant.revision, reservations: reservationsOut };
  commitIdempotency(state, idem.ck, parsedBody, responseBody);
  return { status: 201, body: responseBody };
}

module.exports = { createReplan, applyReplan };
