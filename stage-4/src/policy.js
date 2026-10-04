'use strict';

const { err, isIntegerLike, isPlainObject } = require('./helpers');
const time = require('./time');

const WEEKDAYS = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

function policyZeroFor(restaurant) {
  const capacities = {};
  for (const t of restaurant.tables) capacities[t.id] = t.capacity;
  return {
    policy_version: 0,
    effective_from: null,
    slot_minutes: restaurant.slot_minutes,
    reservation_duration_minutes: restaurant.reservation_duration_minutes,
    cancellation_cutoff_minutes: restaurant.cancellation_cutoff_minutes,
    opening_hours: restaurant.opening_hours.map((h) => ({ ...h })),
    capacities,
  };
}

// Selects the policy in effect for a given local calendar date: the
// greatest effective_from not later than `dateStr`, ties broken by the
// greatest policy_version. Falls back to policy 0 when no published policy
// qualifies.
function selectPolicy(restaurant, dateStr) {
  let best = null;
  for (const p of restaurant.policies) {
    if (p.effective_from > dateStr) continue;
    if (!best) { best = p; continue; }
    if (p.effective_from > best.effective_from) { best = p; continue; }
    if (p.effective_from === best.effective_from && p.policy_version > best.policy_version) best = p;
  }
  return best || policyZeroFor(restaurant);
}

function acceptedTermsFromPolicy(policy) {
  return {
    policy_version: policy.policy_version,
    slot_minutes: policy.slot_minutes,
    reservation_duration_minutes: policy.reservation_duration_minutes,
    cancellation_cutoff_minutes: policy.cancellation_cutoff_minutes,
    opening_hours: policy.opening_hours.map((h) => ({ ...h })),
    capacities: { ...policy.capacities },
  };
}

function validateOpeningHours(value) {
  if (!Array.isArray(value)) throw err(400, 'malformed_request', 'opening_hours must be an array');
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    if (!isPlainObject(entry) || typeof entry.weekday !== 'string' || !WEEKDAYS.has(entry.weekday)) {
      throw err(422, 'validation_failed', 'Each opening_hours entry needs a valid weekday');
    }
    if (seen.has(entry.weekday)) {
      throw err(422, 'validation_failed', 'Duplicate weekday in opening_hours');
    }
    seen.add(entry.weekday);
    const opens = time.hhmmToMinutes(entry.opens);
    const closes = time.hhmmToMinutes(entry.closes);
    if (opens === null || closes === null || closes <= opens) {
      throw err(422, 'validation_failed', 'opening_hours entries need valid opens < closes times');
    }
    out.push({ weekday: entry.weekday, opens: entry.opens, closes: entry.closes });
  }
  return out;
}

function validateIntegerRange(value, min, max, label) {
  if (!isIntegerLike(value) || value < min || value > max) {
    throw err(422, 'validation_failed', `${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function validateCapacities(value, restaurant) {
  if (!isPlainObject(value)) throw err(400, 'malformed_request', 'capacities must be an object');
  const expected = new Set(restaurant.tables.map((t) => t.id));
  const given = Object.keys(value);
  if (given.length !== expected.size || !given.every((id) => expected.has(id))) {
    throw err(422, 'validation_failed', 'capacities must name exactly the restaurant\'s table ids');
  }
  const out = {};
  for (const id of given) {
    out[id] = validateIntegerRange(value[id], 1, 100, `capacities.${id}`);
  }
  return out;
}

// Validates a complete policy submission and returns the normalized fields
// (without policy_version, which the caller allocates).
function validatePolicySubmission(body, restaurant) {
  if (typeof body.effective_from !== 'string' || !time.isValidCalendarDate(body.effective_from)) {
    throw err(422, 'validation_failed', 'effective_from must be a valid YYYY-MM-DD date');
  }
  const slotMinutes = validateIntegerRange(body.slot_minutes, 1, 1440, 'slot_minutes');
  const durationMinutes = validateIntegerRange(body.reservation_duration_minutes, 1, 1440, 'reservation_duration_minutes');
  const cutoffMinutes = validateIntegerRange(body.cancellation_cutoff_minutes, 0, 10080, 'cancellation_cutoff_minutes');
  const openingHours = validateOpeningHours(body.opening_hours);
  const capacities = validateCapacities(body.capacities, restaurant);

  return {
    effective_from: body.effective_from,
    slot_minutes: slotMinutes,
    reservation_duration_minutes: durationMinutes,
    cancellation_cutoff_minutes: cutoffMinutes,
    opening_hours: openingHours,
    capacities,
  };
}

function serializePolicy(p) {
  return {
    policy_version: p.policy_version,
    effective_from: p.effective_from,
    slot_minutes: p.slot_minutes,
    reservation_duration_minutes: p.reservation_duration_minutes,
    cancellation_cutoff_minutes: p.cancellation_cutoff_minutes,
    opening_hours: p.opening_hours.map((h) => ({ ...h })),
    capacities: { ...p.capacities },
  };
}

module.exports = {
  policyZeroFor, selectPolicy, acceptedTermsFromPolicy, validatePolicySubmission, serializePolicy,
};
