'use strict';

const { err, isPlainObject } = require('../helpers');
const { getState } = require('../store');
const { requireIdempotencyKey, resolveIdempotency, commitIdempotency } = require('../idempotency');
const booking = require('../booking');
const historyModule = require('../history');
const {
  findOwnReservation, cutoffPassed, policyModuleAcceptedTerms, markSeriesException, bumpSeriesRevision,
} = require('./reservations');

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

  // Plan phase: validate every move (revision -> cancelled -> cutoff ->
  // fields), in input order, without mutating anything yet.
  const planned = resolvedRefs.map(({ move, reservation }) => {
    booking.checkExpectedRevision(move, reservation.revision);
    if (reservation.status === 'cancelled') {
      throw err(409, 'reservation_cancelled', 'Reservation is cancelled');
    }
    if (cutoffPassed(reservation, Date.now())) {
      throw err(409, 'cutoff_passed', 'Too close to the reservation start to amend');
    }

    const merged = {
      tableIds: booking.extractTableIds(move, reservation.table_ids),
      startsAtLocal: move.starts_at_local !== undefined ? move.starts_at_local : reservation.starts_at_local,
      partySize: move.party_size !== undefined ? move.party_size : reservation.party_size,
    };
    // Canonicalize before comparing: a reversed-but-same declared pair must
    // not register as a change.
    const canonicalTableIds = booking.resolveTableSet(restaurant, merged.tableIds).tableIds;
    const isNoOp = historyModule.sameTableIds(reservation.table_ids, canonicalTableIds)
      && merged.startsAtLocal === reservation.starts_at_local
      && merged.partySize === reservation.party_size;

    if (isNoOp) {
      return {
        reservation, isNoOp: true,
        tableIds: reservation.table_ids, startsAtMs: reservation.starts_at_ms, endsAtMs: reservation.ends_at_ms,
      };
    }

    const resolved = booking.validateFieldsAndResolve(restaurant, merged);
    return {
      reservation, isNoOp: false, resolved,
      tableIds: resolved.tableIds, startsAtMs: resolved.startsAtMs, endsAtMs: resolved.endsAtMs,
    };
  });

  // Occupancy phase: every resulting booking (changed or not) must be
  // mutually non-overlapping, and must not overlap any unlisted booking.
  const excludeSet = new Set(planned.map((p) => p.reservation.id));
  for (let i = 0; i < planned.length; i++) {
    for (let j = i + 1; j < planned.length; j++) {
      const a = planned[i];
      const b = planned[j];
      if (booking.setsIntersect(a.tableIds, b.tableIds) && booking.intervalsOverlap(a.startsAtMs, a.endsAtMs, b.startsAtMs, b.endsAtMs)) {
        throw err(409, 'table_unavailable', 'Resulting bookings overlap each other');
      }
    }
  }
  for (const p of planned) {
    if (booking.hasOverlap(state, p.tableIds, p.startsAtMs, p.endsAtMs, excludeSet)) {
      throw err(409, 'table_unavailable', 'Resulting booking overlaps an unlisted reservation');
    }
  }

  // Commit phase: apply every real change, record history, bump revisions.
  const affectedSeriesIds = new Set();
  let anyRealChange = false;
  for (const p of planned) {
    if (p.isNoOp) continue;
    anyRealChange = true;
    const { reservation, resolved } = p;
    const oldState = { tableIds: reservation.table_ids, startsAtLocal: reservation.starts_at_local, partySize: reservation.party_size };
    const newState = { tableIds: resolved.tableIds, startsAtLocal: resolved.startsAtLocal, partySize: resolved.partySize };
    const changes = historyModule.changesForUpdate(oldState, newState);

    reservation.table_ids = resolved.tableIds;
    reservation.starts_at_local = resolved.startsAtLocal;
    reservation.starts_at_ms = resolved.startsAtMs;
    reservation.ends_at_ms = resolved.endsAtMs;
    reservation.party_size = resolved.partySize;
    reservation.accepted_terms = policyModuleAcceptedTerms(resolved.policy);
    reservation.revision += 1;
    if (changes.length > 0) historyModule.appendHistory(reservation, 'changed', changes);

    markSeriesException(state, reservation);
    if (reservation.series_id) affectedSeriesIds.add(reservation.series_id);
  }
  // Each affected series' revision bumps once for the whole batch, not
  // once per occurrence touched -- dedupe via the set before bumping.
  for (const seriesId of affectedSeriesIds) {
    bumpSeriesRevision(state, seriesId);
  }
  if (anyRealChange) restaurant.revision += 1;

  const responseBody = {
    reservations: planned.map(({ reservation }) => booking.serializeReservation(reservation, restaurant)),
  };
  commitIdempotency(state, idem.ck, parsedBody, responseBody);
  return { status: 201, body: responseBody };
}

module.exports = { reservationMoves };
