'use strict';

const { err, isIntegerLike, authenticate } = require('../helpers');
const { getState } = require('../store');
const { randomId, randomReference } = require('../ids');
const { requireIdempotencyKey, resolveIdempotency, commitIdempotency } = require('../idempotency');
const booking = require('../booking');
const historyModule = require('../history');
const time = require('../time');
const policy = require('../policy');
const {
  findOwnReservation, cutoffPassed, policyModuleAcceptedTerms, bumpSeriesRevision,
} = require('./reservations');

function uniqueReference(state) {
  let ref;
  do {
    ref = randomReference(8);
  } while (state.referenceIndex.has(ref));
  return ref;
}

function validateCount(value) {
  if (!isIntegerLike(value) || value < 2 || value > 12) {
    throw err(422, 'validation_failed', 'count must be an integer from 2 to 12');
  }
  return value;
}

function validateIntervalWeeks(value) {
  if (!isIntegerLike(value) || value < 1 || value > 4) {
    throw err(422, 'validation_failed', 'interval_weeks must be an integer from 1 to 4');
  }
  return value;
}

function createSeries(user, headers, parsedBody) {
  const key = requireIdempotencyKey(headers);
  const state = getState();

  const idem = resolveIdempotency(state, user.id, 'POST', '/series', key, parsedBody);
  if (idem.replay) return idem.replay;

  if (typeof parsedBody.anchor_reference !== 'string' || parsedBody.anchor_reference.length === 0) {
    throw err(422, 'validation_failed', 'anchor_reference is required');
  }
  const anchor = findOwnReservation(state, user, parsedBody.anchor_reference);
  if (!anchor) throw err(404, 'not_found', 'Unknown reservation, or not owned by caller');
  if (anchor.status === 'cancelled') throw err(409, 'reservation_cancelled', 'Reservation is cancelled');
  if (anchor.series_id) throw err(409, 'already_in_series', 'Reservation is already part of a series');
  if (cutoffPassed(anchor, Date.now())) throw err(409, 'cutoff_passed', 'Too close to the reservation start to adopt it');

  const count = validateCount(parsedBody.count);
  const intervalWeeks = validateIntervalWeeks(parsedBody.interval_weeks);

  const restaurant = state.restaurants.get(anchor.restaurant_id);
  const anchorMatch = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(anchor.starts_at_local);
  const anchorDate = anchorMatch[1];
  const anchorClock = anchorMatch[2];

  // Plan every generated occurrence (index 1..count-1) before committing
  // anything: the first failing occurrence (in index order) aborts the
  // whole adoption with its ordinary booking error, per spec.
  const planned = [];
  for (let i = 1; i < count; i++) {
    const date = time.addDaysToDate(anchorDate, i * intervalWeeks * 7);
    const startsAtLocal = `${date}T${anchorClock}`;
    const resolved = booking.validateFieldsAndResolve(restaurant, {
      tableIds: anchor.table_ids, startsAtLocal, partySize: anchor.party_size,
    });
    if (booking.isUnavailable(state, restaurant, resolved.tableIds, resolved.startsAtMs, resolved.endsAtMs, new Set())) {
      throw err(409, 'table_unavailable', 'The table is taken for an overlapping interval');
    }
    planned.push({ index: i, resolved });
  }

  const seriesId = randomId('ser');
  const occurrences = [{ index: 0, reservation: anchor, exception: false }];

  for (const { index, resolved } of planned) {
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
      accepted_terms: policy.acceptedTermsFromPolicy(resolved.policy),
      history: [],
      series_id: seriesId,
      series_index: index,
    };
    historyModule.appendHistory(reservation, 'created', historyModule.changesForCreate({
      tableIds: resolved.tableIds, startsAtLocal: resolved.startsAtLocal, partySize: resolved.partySize,
    }));
    state.reservations.set(id, reservation);
    state.referenceIndex.set(reference, id);
    occurrences.push({ index, reservation, exception: false });
  }
  occurrences.sort((a, b) => a.index - b.index);

  anchor.series_id = seriesId;
  anchor.series_index = 0;

  const series = {
    id: seriesId,
    owner_user_id: user.id,
    revision: 1,
    interval_weeks: intervalWeeks,
    occurrences: occurrences.map((o) => ({ index: o.index, reservation_id: o.reservation.id, exception: o.exception })),
  };
  state.series.set(seriesId, series);
  restaurant.revision += 1;

  const responseBody = serializeSeries(series, state);
  commitIdempotency(state, idem.ck, parsedBody, responseBody);
  return { status: 201, body: responseBody };
}

function serializeSeries(series, state) {
  return {
    series_id: series.id,
    revision: series.revision,
    interval_weeks: series.interval_weeks,
    occurrences: series.occurrences.map((o) => {
      const reservation = state.reservations.get(o.reservation_id);
      const restaurant = state.restaurants.get(reservation.restaurant_id);
      return {
        index: o.index,
        reference: reservation.reference,
        exception: o.exception,
        reservation: booking.serializeReservation(reservation, restaurant),
      };
    }),
  };
}

// Series reads are owner-only and return 404 (not 401) for anyone else,
// including an absent token -- same information-hiding shape as history/decision.
function getSeries(headers, seriesId) {
  const state = getState();
  const user = authenticate(headers);
  const series = state.series.get(seriesId);
  if (!user || !series || series.owner_user_id !== user.id) {
    throw err(404, 'not_found', 'No such series');
  }
  return { status: 200, body: serializeSeries(series, state) };
}

function validateAmendBody(body) {
  if (!isIntegerLike(body.expected_revision) || body.expected_revision < 1) {
    throw err(422, 'validation_failed', 'expected_revision must be a positive integer');
  }
  if (!isIntegerLike(body.from_index) || body.from_index < 0) {
    throw err(422, 'validation_failed', 'from_index must be a non-negative integer');
  }
  if (typeof body.local_time !== 'string' || time.hhmmToMinutes(body.local_time) === null) {
    throw err(422, 'validation_failed', 'local_time must be exactly HH:MM in 00:00..23:59');
  }
  return {
    expectedRevision: body.expected_revision,
    fromIndex: body.from_index,
    localTime: body.local_time,
  };
}

// Owner-only idempotent write: shifts the clock time of every eligible
// occurrence (index >= from_index, not cancelled, not already an
// exception) onto its own original scheduled local date. Plans every
// change before committing any of them, per the individual-PATCH pattern
// used elsewhere (old cutoff -> resulting date's policy -> occupancy).
function amendSeries(user, headers, seriesId, parsedBody) {
  const key = requireIdempotencyKey(headers);
  const state = getState();
  const path = `/series/${seriesId}/amend`;

  const idem = resolveIdempotency(state, user.id, 'POST', path, key, parsedBody);
  if (idem.replay) return idem.replay;

  const series = state.series.get(seriesId);
  if (!series || series.owner_user_id !== user.id) {
    throw err(404, 'not_found', 'No such series');
  }

  const { expectedRevision, fromIndex, localTime } = validateAmendBody(parsedBody);
  if (fromIndex > series.occurrences.length - 1) {
    throw err(422, 'validation_failed', 'from_index must be within 0..count-1');
  }
  if (expectedRevision !== series.revision) {
    throw err(409, 'stale_revision', 'The series has changed since expected_revision was read');
  }

  const eligible = series.occurrences
    .filter((o) => o.index >= fromIndex && !o.exception)
    .map((o) => ({ occ: o, reservation: state.reservations.get(o.reservation_id) }))
    .filter(({ reservation }) => reservation.status !== 'cancelled');

  const anyOccurrence = state.reservations.get(series.occurrences[0].reservation_id);
  const restaurant = state.restaurants.get(anyOccurrence.restaurant_id);

  // Plan phase, in index order: non-occupancy errors (cutoff, field
  // validation) take precedence over occupancy conflicts, per spec.
  const planned = [];
  for (const { occ, reservation } of eligible) {
    const dateMatch = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}$/.exec(reservation.starts_at_local);
    const newStartsAtLocal = `${dateMatch[1]}T${localTime}`;
    if (newStartsAtLocal === reservation.starts_at_local) {
      planned.push({
        occ, reservation, isNoOp: true,
        tableIds: reservation.table_ids, startsAtMs: reservation.starts_at_ms, endsAtMs: reservation.ends_at_ms,
      });
      continue;
    }
    if (cutoffPassed(reservation, Date.now())) {
      throw err(409, 'cutoff_passed', 'Too close to an occurrence\'s start to amend');
    }
    const merged = { tableIds: reservation.table_ids, startsAtLocal: newStartsAtLocal, partySize: reservation.party_size };
    const resolved = booking.validateFieldsAndResolve(restaurant, merged);
    planned.push({
      occ, reservation, isNoOp: false, resolved,
      tableIds: resolved.tableIds, startsAtMs: resolved.startsAtMs, endsAtMs: resolved.endsAtMs,
    });
  }

  // Occupancy phase: resulting (changed) occurrences must not conflict with
  // each other, with unchanged occurrences, with other bookings, or with
  // applied closures.
  const changingIds = new Set(planned.filter((p) => !p.isNoOp).map((p) => p.reservation.id));
  for (let i = 0; i < planned.length; i++) {
    for (let j = i + 1; j < planned.length; j++) {
      const a = planned[i];
      const b = planned[j];
      if (a.isNoOp && b.isNoOp) continue;
      if (booking.setsIntersect(a.tableIds, b.tableIds) && booking.intervalsOverlap(a.startsAtMs, a.endsAtMs, b.startsAtMs, b.endsAtMs)) {
        throw err(409, 'table_unavailable', 'Resulting occurrences overlap each other');
      }
    }
  }
  for (const p of planned) {
    if (p.isNoOp) continue;
    if (booking.isUnavailable(state, restaurant, p.tableIds, p.startsAtMs, p.endsAtMs, changingIds)) {
      throw err(409, 'table_unavailable', 'Resulting occurrence overlaps another booking or a closure');
    }
  }

  // Commit phase: series amendments never mark exceptions.
  let anyRealChange = false;
  for (const p of planned) {
    if (p.isNoOp) continue;
    anyRealChange = true;
    const { reservation, resolved } = p;
    const oldState = { tableIds: reservation.table_ids, startsAtLocal: reservation.starts_at_local, partySize: reservation.party_size };
    const newState = { tableIds: resolved.tableIds, startsAtLocal: resolved.startsAtLocal, partySize: resolved.partySize };
    const changes = historyModule.changesForUpdate(oldState, newState);

    reservation.starts_at_local = resolved.startsAtLocal;
    reservation.starts_at_ms = resolved.startsAtMs;
    reservation.ends_at_ms = resolved.endsAtMs;
    reservation.accepted_terms = policyModuleAcceptedTerms(resolved.policy);
    reservation.revision += 1;
    if (changes.length > 0) historyModule.appendHistory(reservation, 'changed', changes);
  }
  if (anyRealChange) {
    bumpSeriesRevision(state, series.id);
    restaurant.revision += 1;
  }

  const responseBody = serializeSeries(series, state);
  commitIdempotency(state, idem.ck, parsedBody, responseBody);
  return { status: 201, body: responseBody };
}

module.exports = { createSeries, getSeries, amendSeries };
