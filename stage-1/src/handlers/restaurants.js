'use strict';

const { err } = require('../helpers');
const { getState } = require('../store');
const time = require('../time');

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

function getAvailability(query) {
  const state = getState();
  const restaurantId = query.get('restaurant_id');
  const date = query.get('date');
  const partySizeRaw = query.get('party_size');

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

  const restaurant = state.restaurants.get(restaurantId);
  if (!restaurant) throw err(404, 'not_found', 'Unknown restaurant');

  const weekday = time.weekdayOf(date);
  const hours = restaurant.opening_hours.find((h) => h.weekday === weekday);
  const slots = [];

  if (hours) {
    const opensMin = time.hhmmToMinutes(hours.opens);
    const closesMin = time.hhmmToMinutes(hours.closes);
    const duration = restaurant.reservation_duration_minutes;
    const [y, mo, d] = date.split('-').map(Number);

    for (let s = opensMin; s + duration <= closesMin; s += restaurant.slot_minutes) {
      const h = Math.floor(s / 60);
      const mi = s % 60;
      const resolved = time.localToUtc(restaurant.timezone, y, mo, d, h, mi);
      if (!resolved) continue; // DST gap: never appears in availability

      const startsAtMs = resolved.utcMs;
      const endsAtMs = startsAtMs + duration * 60000;
      const startsAtLocal = `${date}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;

      const availableTableIds = restaurant.tables
        .filter((t) => t.capacity >= partySize)
        .filter((t) => {
          for (const res of state.reservations.values()) {
            if (res.status !== 'confirmed') continue;
            if (res.table_id !== t.id) continue;
            if (res.starts_at_ms < endsAtMs && startsAtMs < res.ends_at_ms) return false;
          }
          return true;
        })
        .map((t) => t.id);

      slots.push({
        starts_at_local: startsAtLocal,
        starts_at: time.formatRfc3339(restaurant.timezone, startsAtMs),
        available_table_ids: availableTableIds,
      });
    }
  }

  return {
    status: 200,
    body: { restaurant_id: restaurant.id, date, timezone: restaurant.timezone, slots },
  };
}

module.exports = { listRestaurants, getRestaurant, getAvailability, serializeRestaurantSummary, serializeRestaurantFull };
