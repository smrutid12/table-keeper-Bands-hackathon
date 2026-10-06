'use strict';

const { err, isIntegerLike, authenticate } = require('../helpers');
const { getState } = require('../store');
const { randomId, randomReference } = require('../ids');
const { requireIdempotencyKey, resolveIdempotency, commitIdempotency } = require('../idempotency');
const booking = require('../booking');
const historyModule = require('../history');
const time = require('../time');
const policy = require('../policy');
const { findOwnReservation, cutoffPassed } = require('./reservations');

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
    if (booking.hasOverlap(state, resolved.tableIds, resolved.startsAtMs, resolved.endsAtMs, new Set())) {
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

module.exports = { createSeries, getSeries };
