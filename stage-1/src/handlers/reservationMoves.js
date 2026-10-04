'use strict';

const { err, isPlainObject } = require('../helpers');
const { getState } = require('../store');
const { requireIdempotencyKey, resolveIdempotency, commitIdempotency } = require('../idempotency');
const booking = require('../booking');
const { findOwnReservation, cutoffPassed } = require('./reservations');

function validateShape(parsedBody) {
  const moves = parsedBody.moves;
  if (!Array.isArray(moves) || moves.length < 1 || moves.length > 8) {
    throw err(422, 'validation_failed', 'moves must be an array of 1 to 8 items');
  }
  const seen = new Set();
  for (const m of moves) {
    if (!isPlainObject(m) || typeof m.reference !== 'string' || m.reference.length === 0) {
      throw err(422, 'validation_failed', 'each move needs a string reference');
    }
    if (seen.has(m.reference)) {
      throw err(422, 'validation_failed', 'duplicate reference in moves');
    }
    seen.add(m.reference);
  }
  return moves;
}

function reservationMoves(user, headers, parsedBody) {
  const key = requireIdempotencyKey(headers);
  const state = getState();

  const idem = resolveIdempotency(state, user.id, 'POST', '/reservation-moves', key, parsedBody);
  if (idem.replay) return idem.replay;

  const moves = validateShape(parsedBody);

  const resolvedRefs = moves.map((m) => {
    const res = findOwnReservation(state, user, m.reference);
    if (!res) throw err(404, 'not_found', 'Unknown reservation, or not owned by caller');
    return { move: m, reservation: res };
  });

  const restaurantId = resolvedRefs[0].reservation.restaurant_id;
  for (const { reservation } of resolvedRefs) {
    if (reservation.restaurant_id !== restaurantId) {
      throw err(422, 'validation_failed', 'All moves must reference bookings of the same restaurant');
    }
  }
  const restaurant = state.restaurants.get(restaurantId);

  const planned = resolvedRefs.map(({ move, reservation }) => {
    if (reservation.status === 'cancelled') {
      throw err(409, 'reservation_cancelled', 'Reservation is cancelled');
    }
    if (cutoffPassed(restaurant, reservation, Date.now())) {
      throw err(409, 'cutoff_passed', 'Too close to the reservation start to amend');
    }
    const merged = {
      tableId: move.table_id !== undefined ? move.table_id : reservation.table_id,
      startsAtLocal: move.starts_at_local !== undefined ? move.starts_at_local : reservation.starts_at_local,
      partySize: move.party_size !== undefined ? move.party_size : reservation.party_size,
    };
    const resolved = booking.validateFieldsAndResolve(restaurant, merged);
    return { reservation, resolved };
  });

  const excludeSet = new Set(planned.map((p) => p.reservation.id));
  for (let i = 0; i < planned.length; i++) {
    for (let j = i + 1; j < planned.length; j++) {
      const a = planned[i].resolved;
      const b = planned[j].resolved;
      if (a.table.id === b.table.id && booking.intervalsOverlap(a.startsAtMs, a.endsAtMs, b.startsAtMs, b.endsAtMs)) {
        throw err(409, 'table_unavailable', 'Resulting bookings overlap each other');
      }
    }
  }
  for (const { resolved } of planned) {
    if (booking.hasOverlap(state, resolved.table.id, resolved.startsAtMs, resolved.endsAtMs, excludeSet)) {
      throw err(409, 'table_unavailable', 'Resulting booking overlaps an unlisted reservation');
    }
  }

  for (const { reservation, resolved } of planned) {
    reservation.table_id = resolved.table.id;
    reservation.starts_at_local = resolved.startsAtLocal;
    reservation.starts_at_ms = resolved.startsAtMs;
    reservation.ends_at_ms = resolved.endsAtMs;
    reservation.party_size = resolved.partySize;
  }

  const responseBody = {
    reservations: planned.map(({ reservation }) => booking.serializeReservation(reservation, restaurant)),
  };
  commitIdempotency(state, idem.ck, parsedBody, responseBody);
  return { status: 201, body: responseBody };
}

module.exports = { reservationMoves };
