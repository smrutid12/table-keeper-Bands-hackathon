'use strict';

const { err } = require('../helpers');
const { getState } = require('../store');
const time = require('../time');
const policyModule = require('../policy');
const { requireIdempotencyKey, resolveIdempotency, commitIdempotency } = require('../idempotency');

function serializeRestaurantSummary(r) {
  return { id: r.id, name: r.name, timezone: r.timezone };
}

function serializeRestaurantFull(r) {
  return {
    id: r.id,
    name: r.name,
    timezone: r.timezone,
    slot_minutes: r.slot_minutes,
    reservation_duration_minutes: r.reservation_duration_minutes,
    cancellation_cutoff_minutes: r.cancellation_cutoff_minutes,
    opening_hours: r.opening_hours.map((h) => ({ weekday: h.weekday, opens: h.opens, closes: h.closes })),
    tables: r.tables.map((t) => ({ id: t.id, label: t.label, capacity: t.capacity })),
    combinable: r.combinable.map((pair) => pair.slice()),
  };
}

function listRestaurants() {
  const state = getState();
  return { status: 200, body: { restaurants: Array.from(state.restaurants.values()).map(serializeRestaurantSummary) } };
}

function getRestaurant(params) {
  const state = getState();
  const r = state.restaurants.get(params.id);
  if (!r) throw err(404, 'not_found', 'Unknown restaurant');
  return { status: 200, body: serializeRestaurantFull(r) };
}

const INT_QUERY = /^[0-9]+$/;

function tableSetIsFree(state, restaurant, tableIds, startsAtMs, endsAtMs) {
  const wanted = new Set(tableIds);
  for (const res of state.reservations.values()) {
    if (res.status !== 'confirmed') continue;
    if (res.starts_at_ms >= endsAtMs || startsAtMs >= res.ends_at_ms) continue; // no time overlap
    if (res.table_ids.some((id) => wanted.has(id))) return false;
  }
  for (const c of restaurant.closures) {
    if (!wanted.has(c.table_id)) continue;
    if (startsAtMs < c.to_ms && c.from_ms < endsAtMs) return false; // closed for part of the interval
  }
  return true;
}

function getAvailability(query) {
  const state = getState();
  const restaurantId = query.get('restaurant_id');
  const date = query.get('date');
  const partySizeRaw = query.get('party_size');
  const explainRaw = query.get('explain');

  if (!restaurantId || !date || !partySizeRaw) {
    throw err(422, 'validation_failed', 'restaurant_id, date and party_size are required');
  }
  if (!INT_QUERY.test(partySizeRaw)) {
    throw err(422, 'validation_failed', 'party_size must be a plain decimal integer');
  }
  const partySize = Number(partySizeRaw);
  if (!time.isValidCalendarDate(date)) {
    throw err(422, 'validation_failed', 'date must be a valid calendar date');
  }
  let explain = false;
  if (explainRaw !== null) {
    if (explainRaw !== 'true') throw err(422, 'validation_failed', 'explain must be "true" if given');
    explain = true;
  }

  const restaurant = state.restaurants.get(restaurantId);
  if (!restaurant) throw err(404, 'not_found', 'Unknown restaurant');

  const policy = policyModule.selectPolicy(restaurant, date);
  const weekday = time.weekdayOf(date);
  const hours = policy.opening_hours.find((h) => h.weekday === weekday);
  const slots = [];

  if (hours) {
    const opensMin = time.hhmmToMinutes(hours.opens);
    const closesMin = time.hhmmToMinutes(hours.closes);
    const duration = policy.reservation_duration_minutes;
    const [y, mo, d] = date.split('-').map(Number);

    for (let s = opensMin; s + duration <= closesMin; s += policy.slot_minutes) {
      const h = Math.floor(s / 60);
      const mi = s % 60;
      const resolved = time.localToUtc(restaurant.timezone, y, mo, d, h, mi);
      if (!resolved) continue; // DST gap: never appears in availability

      const startsAtMs = resolved.utcMs;
      const endsAtMs = startsAtMs + duration * 60000;
      const startsAtLocal = `${date}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;

      const availableTableIds = restaurant.tables
        .filter((t) => policy.capacities[t.id] >= partySize)
        .filter((t) => tableSetIsFree(state, restaurant, [t.id], startsAtMs, endsAtMs))
        .map((t) => t.id);

      const singleOptions = restaurant.tables
        .filter((t) => policy.capacities[t.id] >= partySize && tableSetIsFree(state, restaurant, [t.id], startsAtMs, endsAtMs))
        .map((t) => ({ table_ids: [t.id], capacity: policy.capacities[t.id] }));

      const pairOptions = restaurant.combinable
        .map((pair) => {
          const tables = pair.map((id) => restaurant.tables.find((t) => t.id === id));
          if (tables.some((t) => !t)) return null;
          const capacity = policy.capacities[pair[0]] + policy.capacities[pair[1]];
          if (capacity < partySize) return null;
          if (!tableSetIsFree(state, restaurant, pair, startsAtMs, endsAtMs)) return null;
          return { table_ids: pair.slice(), capacity };
        })
        .filter(Boolean);

      const slot = {
        starts_at_local: startsAtLocal,
        starts_at: time.formatRfc3339(restaurant.timezone, startsAtMs),
        available_table_ids: availableTableIds,
        available_options: singleOptions.concat(pairOptions),
      };

      if (explain) {
        const availableSet = new Set(availableTableIds);
        slot.explain = restaurant.tables.map((t) => {
          const capacityHolds = policy.capacities[t.id] >= partySize;
          const noOverlapHolds = tableSetIsFree(state, restaurant, [t.id], startsAtMs, endsAtMs);
          return {
            table_id: t.id,
            policy_version: policy.policy_version,
            available: availableSet.has(t.id),
            rules: [
              { rule: 'capacity', holds: capacityHolds },
              { rule: 'no_overlap', holds: noOverlapHolds },
            ],
          };
        });
      }

      slots.push(slot);
    }
  }

  return {
    status: 200,
    body: { restaurant_id: restaurant.id, date, timezone: restaurant.timezone, slots },
  };
}

function requireManager(state, user, restaurant) {
  if (!restaurant.manager_user_ids.includes(user.id)) {
    throw err(403, 'forbidden', 'Not a manager of this restaurant');
  }
}

function publishPolicy(user, headers, restaurantId, parsedBody) {
  const key = requireIdempotencyKey(headers);
  const state = getState();

  const idem = resolveIdempotency(state, user.id, 'POST', `/restaurants/${restaurantId}/policies`, key, parsedBody);
  if (idem.replay) return idem.replay;

  const restaurant = state.restaurants.get(restaurantId);
  if (!restaurant) throw err(404, 'not_found', 'Unknown restaurant');
  requireManager(state, user, restaurant);

  const fields = policyModule.validatePolicySubmission(parsedBody, restaurant);
  const policyVersion = restaurant.policies.length + 1;
  const policy = { policy_version: policyVersion, ...fields };
  restaurant.policies.push(policy);
  restaurant.revision += 1;

  const responseBody = policyModule.serializePolicy(policy);
  commitIdempotency(state, idem.ck, parsedBody, responseBody);
  return { status: 201, body: responseBody };
}

function listPolicies(restaurantId) {
  const state = getState();
  const restaurant = state.restaurants.get(restaurantId);
  if (!restaurant) throw err(404, 'not_found', 'Unknown restaurant');
  return { status: 200, body: { policies: restaurant.policies.map(policyModule.serializePolicy) } };
}

module.exports = {
  listRestaurants, getRestaurant, getAvailability, serializeRestaurantSummary, serializeRestaurantFull,
  publishPolicy, listPolicies, requireManager, tableSetIsFree,
};
