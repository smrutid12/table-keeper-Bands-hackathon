'use strict';

const { err, isIntegerLike } = require('../helpers');
const { getState } = require('../store');
const { randomId, randomReference } = require('../ids');
const { requireIdempotencyKey, resolveIdempotency, commitIdempotency } = require('../idempotency');
const booking = require('../booking');

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

  if (booking.hasOverlap(state, resolved.tableIds, resolved.startsAtMs, resolved.endsAtMs, new Set())) {
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
  };
  state.reservations.set(id, reservation);
  state.referenceIndex.set(reference, id);

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

function cutoffPassed(restaurant, reservation, nowMs) {
  const boundary = reservation.starts_at_ms - restaurant.cancellation_cutoff_minutes * 60000;
  return nowMs >= boundary;
}

function cancelReservation(user, reference) {
  const state = getState();
  const res = findOwnReservation(state, user, reference);
  if (!res) throw err(404, 'not_found', 'No such reservation');
  const restaurant = state.restaurants.get(res.restaurant_id);

  if (res.status === 'cancelled') {
    return { status: 200, body: booking.serializeReservation(res, restaurant) };
  }
  if (cutoffPassed(restaurant, res, Date.now())) {
    throw err(409, 'cutoff_passed', 'Too close to the reservation start to cancel');
  }
  res.status = 'cancelled';
  return { status: 200, body: booking.serializeReservation(res, restaurant) };
}

function amendReservation(user, reference, parsedBody) {
  const state = getState();
  const res = findOwnReservation(state, user, reference);
  if (!res) throw err(404, 'not_found', 'No such reservation');
  const restaurant = state.restaurants.get(res.restaurant_id);

  if (res.status === 'cancelled') {
    throw err(409, 'reservation_cancelled', 'Reservation is cancelled');
  }
  if (cutoffPassed(restaurant, res, Date.now())) {
    throw err(409, 'cutoff_passed', 'Too close to the reservation start to amend');
  }

  const merged = {
    tableIds: booking.extractTableIds(parsedBody, res.table_ids),
    startsAtLocal: parsedBody.starts_at_local !== undefined ? parsedBody.starts_at_local : res.starts_at_local,
    partySize: parsedBody.party_size !== undefined ? parsedBody.party_size : res.party_size,
  };

  const resolved = booking.validateFieldsAndResolve(restaurant, merged);

  if (booking.hasOverlap(state, resolved.tableIds, resolved.startsAtMs, resolved.endsAtMs, new Set([res.id]))) {
    throw err(409, 'table_unavailable', 'The table is taken for an overlapping interval');
  }

  res.table_ids = resolved.tableIds;
  res.starts_at_local = resolved.startsAtLocal;
  res.starts_at_ms = resolved.startsAtMs;
  res.ends_at_ms = resolved.endsAtMs;
  res.party_size = resolved.partySize;

  return { status: 200, body: booking.serializeReservation(res, restaurant) };
}

module.exports = {
  createReservation, listReservations, getReservation, cancelReservation, amendReservation,
  findOwnReservation, cutoffPassed,
};
