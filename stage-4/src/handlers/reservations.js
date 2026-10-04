'use strict';

const { err, isIntegerLike, authenticate } = require('../helpers');
const { getState } = require('../store');
const { randomId, randomReference } = require('../ids');
const { requireIdempotencyKey, resolveIdempotency, commitIdempotency } = require('../idempotency');
const booking = require('../booking');
const history = require('../history');
const policy = require('../policy');

function policyModuleAcceptedTerms(p) { return policy.acceptedTermsFromPolicy(p); }

function requireField(body, field, expectType) {
  const v = body[field];
  if (v === undefined || v === null) throw err(422, 'validation_failed', `${field} is required`);
  if (expectType === 'string' && typeof v !== 'string') {
    throw err(400, 'malformed_request', `${field} must be a string`);
  }
  return v;
}

function uniqueReference(state) {
  let ref;
  do {
    ref = randomReference(8);
  } while (state.referenceIndex.has(ref));
  return ref;
}

function createReservation(user, headers, rawBody, parsedBody) {
  const key = requireIdempotencyKey(headers);
  const state = getState();

  const idem = resolveIdempotency(state, user.id, 'POST', '/reservations', key, parsedBody);
  if (idem.replay) return idem.replay;

  const restaurantId = requireField(parsedBody, 'restaurant_id', 'string');
  const startsAtLocal = requireField(parsedBody, 'starts_at_local', 'string');
  const partySize = parsedBody.party_size;
  if (partySize === undefined || partySize === null) {
    throw err(422, 'validation_failed', 'party_size is required');
  }
  if (!isIntegerLike(partySize) || partySize < 1) {
    throw err(422, 'validation_failed', 'party_size must be a positive integer');
  }
  const tableIds = booking.extractTableIds(parsedBody);

  const restaurant = state.restaurants.get(restaurantId);
  if (!restaurant) throw err(404, 'not_found', 'Unknown restaurant');

  const resolved = booking.validateFieldsAndResolve(restaurant, { tableIds, startsAtLocal, partySize });

  if (booking.isUnavailable(state, restaurant, resolved.tableIds, resolved.startsAtMs, resolved.endsAtMs, new Set())) {
    throw err(409, 'table_unavailable', 'The table is taken for an overlapping interval');
  }

  const id = randomId('res');
  const reference = uniqueReference(state);
  const reservation = {
    id,
    reference,
    user_id: user.id,
    restaurant_id: restaurant.id,
    table_ids: resolved.tableIds,
    party_size: resolved.partySize,
    status: 'confirmed',
    starts_at_local: resolved.startsAtLocal,
    starts_at_ms: resolved.startsAtMs,
    ends_at_ms: resolved.endsAtMs,
    created_at_ms: Date.now(),
    revision: 1,
    accepted_terms: policyModuleAcceptedTerms(resolved.policy),
    history: [],
    series_id: null,
    series_index: null,
  };
  history.appendHistory(reservation, 'created', history.changesForCreate({
    tableIds: resolved.tableIds, startsAtLocal: resolved.startsAtLocal, partySize: resolved.partySize,
  }));
  state.reservations.set(id, reservation);
  state.referenceIndex.set(reference, id);
  restaurant.revision += 1;

  const responseBody = booking.serializeReservation(reservation, restaurant);
  commitIdempotency(state, idem.ck, parsedBody, responseBody);
  return { status: 201, body: responseBody };
}

function listReservations(user) {
  const state = getState();
  const mine = Array.from(state.reservations.values()).filter((r) => r.user_id === user.id);
  mine.sort((a, b) => b.starts_at_ms - a.starts_at_ms);
  const out = mine.map((r) => booking.serializeReservation(r, state.restaurants.get(r.restaurant_id)));
  return { status: 200, body: { reservations: out } };
}

function findOwnReservation(state, user, reference) {
  const id = state.referenceIndex.get(reference);
  const res = id ? state.reservations.get(id) : null;
  if (!res || res.user_id !== user.id) return null;
  return res;
}

function getReservation(user, reference) {
  const state = getState();
  const res = findOwnReservation(state, user, reference);
  if (!res) throw err(404, 'not_found', 'No such reservation');
  const restaurant = state.restaurants.get(res.restaurant_id);
  return { status: 200, body: booking.serializeReservation(res, restaurant) };
}

// History and decision deliberately return 404 (not 401) when there is no
// caller, or the caller isn't the owner -- same information-hiding shape
// either way, per spec.
function findOwnReservationOptionalAuth(headers, reference) {
  const state = getState();
  const user = authenticate(headers);
  if (!user) throw err(404, 'not_found', 'No such reservation');
  const res = findOwnReservation(state, user, reference);
  if (!res) throw err(404, 'not_found', 'No such reservation');
  return res;
}

function getReservationHistory(headers, reference) {
  const res = findOwnReservationOptionalAuth(headers, reference);
  return {
    status: 200,
    body: { reference: res.reference, entries: res.history.map(history.serializeHistoryEntry) },
  };
}

function getReservationDecision(headers, reference) {
  const res = findOwnReservationOptionalAuth(headers, reference);
  return {
    status: 200,
    body: { reference: res.reference, revision: res.revision, accepted_terms: res.accepted_terms },
  };
}

function cutoffPassed(reservation, nowMs) {
  const boundary = reservation.starts_at_ms - reservation.accepted_terms.cancellation_cutoff_minutes * 60000;
  return nowMs >= boundary;
}

// A real individual PATCH permanently marks that occurrence as an
// exception. Cancellation does not. Both bump the series revision once
// per request; callers of batch operations (reservation-moves) dedupe
// that bump themselves across a whole batch instead of calling this.
function markSeriesException(state, reservation) {
  if (!reservation.series_id) return;
  const series = state.series.get(reservation.series_id);
  if (!series) return;
  const occurrence = series.occurrences.find((o) => o.index === reservation.series_index);
  if (occurrence) occurrence.exception = true;
}

function bumpSeriesRevision(state, seriesId) {
  if (!seriesId) return;
  const series = state.series.get(seriesId);
  if (series) series.revision += 1;
}

function cancelReservation(user, reference) {
  const state = getState();
  const res = findOwnReservation(state, user, reference);
  if (!res) throw err(404, 'not_found', 'No such reservation');
  const restaurant = state.restaurants.get(res.restaurant_id);

  if (res.status === 'cancelled') {
    return { status: 200, body: booking.serializeReservation(res, restaurant) };
  }
  if (cutoffPassed(res, Date.now())) {
    throw err(409, 'cutoff_passed', 'Too close to the reservation start to cancel');
  }
  res.status = 'cancelled';
  res.revision += 1;
  history.appendHistory(res, 'cancelled', []);
  bumpSeriesRevision(state, res.series_id);
  restaurant.revision += 1;
  return { status: 200, body: booking.serializeReservation(res, restaurant) };
}

// Applies a real (non-no-op) amendment: validates, checks overlap, mutates
// the reservation, and records history. Throws without mutating on failure.
// Returns true if a real change was applied, false if it detected a no-op.
function applyAmendment(state, restaurant, res, merged) {
  // Canonicalize table_ids (resolves a declared pair to combinable's
  // declared order) before comparing: a reversed-but-same pair must not
  // register as a change, per the combined-table-history rule.
  const canonicalTableIds = booking.resolveTableSet(restaurant, merged.tableIds).tableIds;
  const isNoOp = history.sameTableIds(res.table_ids, canonicalTableIds)
    && merged.startsAtLocal === res.starts_at_local
    && merged.partySize === res.party_size;
  if (isNoOp) return false;

  const resolved = booking.validateFieldsAndResolve(restaurant, merged);
  if (booking.isUnavailable(state, restaurant, resolved.tableIds, resolved.startsAtMs, resolved.endsAtMs, new Set([res.id]))) {
    throw err(409, 'table_unavailable', 'The table is taken for an overlapping interval');
  }

  const oldState = { tableIds: res.table_ids, startsAtLocal: res.starts_at_local, partySize: res.party_size };
  const newState = { tableIds: resolved.tableIds, startsAtLocal: resolved.startsAtLocal, partySize: resolved.partySize };
  const changes = history.changesForUpdate(oldState, newState);

  res.table_ids = resolved.tableIds;
  res.starts_at_local = resolved.startsAtLocal;
  res.starts_at_ms = resolved.startsAtMs;
  res.ends_at_ms = resolved.endsAtMs;
  res.party_size = resolved.partySize;
  res.accepted_terms = policyModuleAcceptedTerms(resolved.policy);
  res.revision += 1;
  if (changes.length > 0) history.appendHistory(res, 'changed', changes);
  markSeriesException(state, res);
  bumpSeriesRevision(state, res.series_id);
  restaurant.revision += 1;
  return true;
}

function amendReservation(user, reference, parsedBody) {
  const state = getState();
  const res = findOwnReservation(state, user, reference);
  if (!res) throw err(404, 'not_found', 'No such reservation');
  const restaurant = state.restaurants.get(res.restaurant_id);

  booking.checkExpectedRevision(parsedBody, res.revision);

  if (res.status === 'cancelled') {
    throw err(409, 'reservation_cancelled', 'Reservation is cancelled');
  }
  if (cutoffPassed(res, Date.now())) {
    throw err(409, 'cutoff_passed', 'Too close to the reservation start to amend');
  }

  const merged = {
    tableIds: booking.extractTableIds(parsedBody, res.table_ids),
    startsAtLocal: parsedBody.starts_at_local !== undefined ? parsedBody.starts_at_local : res.starts_at_local,
    partySize: parsedBody.party_size !== undefined ? parsedBody.party_size : res.party_size,
  };

  applyAmendment(state, restaurant, res, merged);

  return { status: 200, body: booking.serializeReservation(res, restaurant) };
}

module.exports = {
  createReservation, listReservations, getReservation, cancelReservation, amendReservation,
  getReservationHistory, getReservationDecision, findOwnReservation, findOwnReservationOptionalAuth,
  cutoffPassed, applyAmendment, policyModuleAcceptedTerms, markSeriesException, bumpSeriesRevision,
};
