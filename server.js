// TableKeeper prototype: Express + Postgres.
// Three ideas worth copying into whatever the real spec asks for:
//   1. The DB enforces "no double booking" (exclusion constraint), so races can't win.
//   2. Idempotency key is claimed INSIDE the same transaction as the booking.
//   3. Every bad input maps to a documented 4xx; nothing user-caused becomes a 500.
import express from 'express';
import pg from 'pg';
import crypto from 'node:crypto';
import { DateTime } from 'luxon';
import OpeningHours from 'opening_hours';
import tzlookup from '@photostructure/tz-lookup';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Locally, no .env means the docker-compose database: user "postgres" with the throwaway
// password from docker-compose.yml, on host port 5433. Not used on Vercel.
const localDatabaseUrl = () => {
  const u = new URL('postgres://localhost:5433/tablekeeper');
  u.username = 'postgres';
  u.password = 'tk';
  return u.href;
};
const DATABASE_URL = process.env.DATABASE_URL ||
  (process.env.VERCEL ? undefined : localDatabaseUrl());
// Fail at startup, not on the first request. Note: a DATABASE_URL already set in the shell
// wins over .env (Node never overrides existing variables).
if (!/^postgres(ql)?:\/\//.test(DATABASE_URL) || !URL.canParse(DATABASE_URL)) {
  console.error('DATABASE_URL is not a valid postgres:// URL. Expected e.g.\n' +
    '  postgres://USER@127.0.0.1:5432/tablekeeper  (password goes after USER, separated by a colon)\n' +
    "URL-encode special characters in the password ('#' -> %23). If .env looks right, a\n" +
    'DATABASE_URL set in this shell is overriding it: clear it (cmd: set DATABASE_URL=).');
  process.exit(1);
}
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: process.env.VERCEL ? 1 : 20,
});
const app = express();
app.use(express.json({ limit: '16kb' }));
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));

// On Vercel there's no `npm run db:init` step: load schema.sql once, only if the tables are missing.
// The advisory lock stops two cold-starting instances from loading it at the same time.
let schemaReady = null;
const ensureSchema = async () => {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(727001)');
    const { rows } = await c.query("SELECT to_regclass('public.restaurants') AS t");
    if (!rows[0].t) await c.query(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  } finally {
    await c.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    c.release();
  }
};
if (process.env.VERCEL) {
  app.use((_req, _res, next) => {
    schemaReady ??= ensureSchema().catch((e) => { schemaReady = null; throw e; });
    schemaReady.then(() => next(), next);
  });
}

// ---------- errors ----------
class ApiError extends Error {
  constructor(status, code, message, details) { super(message); Object.assign(this, { status, code, details }); }
}
const errBody = (code, message, details) => ({ error: { code, message, ...(details && { details }) } });

// ---------- validation ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateBooking(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new ApiError(400, 'validation_error', 'Body must be a JSON object');
  const problems = {};
  const { restaurant_id, date, time, party_size, guest_name } = body;
  if (typeof restaurant_id !== 'string' || !restaurant_id) problems.restaurant_id = 'required string';
  if (typeof date !== 'string' || !DATE_RE.test(date)) problems.date = 'expected YYYY-MM-DD';
  if (typeof time !== 'string' || !TIME_RE.test(time)) problems.time = 'expected HH:mm (24h)';
  if (!Number.isInteger(party_size) || party_size < 1 || party_size > 20) problems.party_size = 'integer 1-20';
  if (typeof guest_name !== 'string' || !guest_name.trim() || guest_name.length > 100) problems.guest_name = '1-100 chars';
  if (Object.keys(problems).length) throw new ApiError(400, 'validation_error', 'Invalid fields', problems);
  return { restaurant_id, date, time, party_size, guest_name: guest_name.trim() };
}

// ---------- time zones ----------
// Guests think in the restaurant's local wall-clock time. We convert once, at the edge,
// and store absolute instants. DST gaps and overlaps are rejected explicitly.
function localToInstant(date, time, zone) {
  const dt = DateTime.fromISO(`${date}T${time}`, { zone });
  if (!dt.isValid) throw new ApiError(400, 'validation_error', 'Invalid date', { date: dt.invalidExplanation });
  if (dt.toFormat('yyyy-MM-dd') !== date || dt.toFormat('HH:mm') !== time)
    throw new ApiError(422, 'nonexistent_local_time', `${date} ${time} does not exist in ${zone} (DST gap)`);
  if (dt.getPossibleOffsets().length > 1)
    throw new ApiError(422, 'ambiguous_local_time', `${date} ${time} happens twice in ${zone} (DST overlap)`);
  return dt;
}

async function getRestaurant(db, id) {
  const { rows } = await db.query('SELECT * FROM restaurants WHERE id = $1', [id]);
  if (!rows[0]) throw new ApiError(404, 'restaurant_not_found', `No restaurant ${id}`);
  return rows[0];
}

// ---------- opening hours ----------
// OSM hours ('Mo-Fr 11:00-22:00; Sa 18:00-02:00') are parsed by the opening_hours library,
// which only speaks the *server's* local time. So we ask it in wall-clock terms (a Date built
// from local fields) and read wall-clock fields back out into the restaurant's zone.
const ohCache = new Map();

// Public/school holiday rules ('PH off', 'Mo-Fr,PH 10:00-20:00') need the country's holiday
// calendar, which we don't know. Drop them: holidays are treated like normal days.
function withoutHolidays(value) {
  return value.split(/\s*;\s*/).map(rule => {
    if (!/\b(PH|SH)\b/.test(rule)) return rule;
    const stripped = rule.replace(/\b(PH|SH)\b(\s*[+-]\d+\s*days?)?/g, '').replace(/,\s*,/g, ',')
                         .replace(/(^|\s),|,(\s|$)/g, '$1$2').trim();
    return /^[A-Za-z]/.test(stripped) && !/^(off|closed)\b/i.test(stripped) ? stripped : null;
  }).filter(Boolean).join('; ');
}

function tryHours(value, r) {
  try {
    const oh = new OpeningHours(value, { lat: r.lat ?? 0, lon: r.lng ?? 0, address: { country_code: '', state: '' } });
    oh.getOpenIntervals(new Date(), new Date(Date.now() + 8 * 864e5));   // some errors only show on evaluation
    return oh;
  } catch { return null; }
}

// Parsed hours, or null if OSM's value can't be understood (callers fall back to open/close_time).
function parseHours(r) {
  if (!r.opening_hours) return null;
  const k = `${r.id}|${r.opening_hours}`;
  if (!ohCache.has(k)) {
    let oh = tryHours(r.opening_hours, r);
    if (!oh && /\b(PH|SH)\b/.test(r.opening_hours)) {
      const simpler = withoutHolidays(r.opening_hours);
      if (simpler) oh = tryHours(simpler, r);
    }
    ohCache.set(k, oh);
  }
  return ohCache.get(k);
}

const wallClock = (d, zone) => DateTime.fromObject(
  { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() }, { zone });

// Open intervals touching local date `date` (YYYY-MM-DD). Intervals may run past midnight.
function openIntervals(r, date) {
  const oh = r.hours_estimated ? null : parseHours(r);
  if (oh) {
    const [y, m, d] = date.split('-').map(Number);
    try {
      return oh.getOpenIntervals(new Date(y, m - 1, d), new Date(y, m - 1, d + 1, 12))
        .map(([from, to]) => ({ open: wallClock(from, r.timezone), close: wallClock(to, r.timezone) }))
        .filter(i => i.open.toISODate() === date);
    } catch { /* fall through */ }
  }
  const open = DateTime.fromISO(`${date}T${r.open_time.slice(0, 5)}`, { zone: r.timezone });
  let close = DateTime.fromISO(`${date}T${r.close_time.slice(0, 5)}`, { zone: r.timezone });
  if (close <= open) close = close.plus({ days: 1 });           // e.g. 18:00-02:00
  return [{ open, close }];
}

function withinHours(r, start, end) {
  return openIntervals(r, start.setZone(r.timezone).toISODate()).some(i => start >= i.open && end <= i.close);
}

// ---------- idempotency ----------
// Claim the key with INSERT ... ON CONFLICT DO NOTHING inside the booking transaction.
// A concurrent duplicate blocks on the unique index until the first one commits, then sees
// the stored response. If the first one crashes and rolls back, the key frees up automatically.
async function idempotent(req, res, endpoint, fingerprint, work) {
  const key = req.get('Idempotency-Key');
  if (key !== undefined && (!key || key.length > 200))
    throw new ApiError(400, 'validation_error', 'Idempotency-Key must be 1-200 chars');
  const hash = crypto.createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (key) {
      const claim = await client.query(
        `INSERT INTO idempotency_keys (key, endpoint, request_hash) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING RETURNING key`, [key, endpoint, hash]);
      if (claim.rowCount === 0) {
        await client.query('ROLLBACK');
        // Reuse THIS connection. Grabbing a second one from the pool here deadlocks under
        // load (every connection held by a waiting duplicate). Found by the race test.
        const { rows } = await client.query(
          'SELECT * FROM idempotency_keys WHERE key = $1 AND endpoint = $2', [key, endpoint]);
        const prior = rows[0];
        if (prior.request_hash !== hash)
          throw new ApiError(422, 'idempotency_key_reused', 'This key was used with a different request body');
        res.set('Idempotent-Replayed', 'true');
        return res.status(prior.status_code).json(prior.response_body);
      }
    }
    const { status, body } = await work(client);   // business outcomes (201, 409...) get stored too
    if (key) await client.query(
      'UPDATE idempotency_keys SET status_code = $3, response_body = $4 WHERE key = $1 AND endpoint = $2',
      [key, endpoint, status, body]);
    await client.query('COMMIT');
    res.status(status).json(body);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const toJson = (row, zone) => ({
  id: row.id,
  restaurant_id: row.restaurant_id,
  table_id: row.table_id,
  guest_name: row.guest_name,
  party_size: row.party_size,
  status: row.status,
  starts_at: row.starts_at.toISOString(),
  ends_at: row.ends_at.toISOString(),
  local_start: DateTime.fromJSDate(row.starts_at, { zone }).toISO({ suppressMilliseconds: true }),
  timezone: zone,
});

const wrap = fn => (req, res, next) => fn(req, res).catch(next);

// ---------- location ----------
// The map sends its visible box. Bad values are a 400, never a NaN in an Overpass query.
const MAX_BOX_KM = 12;                         // bigger views must zoom in first (5 km radius = 10 km box)
const MAX_RADIUS_KM = 5;
function parseBbox(q) {
  const num = k => (q[k] === undefined || q[k] === '' ? NaN : Number(q[k]));
  const [south, west, north, east] = ['south', 'west', 'north', 'east'].map(num);
  const problems = {};
  if (!(south >= -90 && south <= 90)) problems.south = 'number -90..90';
  if (!(north >= -90 && north <= 90)) problems.north = 'number -90..90';
  if (!(west >= -180 && west <= 180)) problems.west = 'number -180..180';
  if (!(east >= -180 && east <= 180)) problems.east = 'number -180..180';
  if (!problems.south && !problems.north && south >= north) problems.north = 'must be > south';
  if (!problems.west && !problems.east && west >= east) problems.east = 'must be > west';
  const radius = q.radius_km === undefined || q.radius_km === '' ? null : Number(q.radius_km);
  if (radius !== null && !(radius > 0 && radius <= MAX_RADIUS_KM)) problems.radius_km = `number >0..${MAX_RADIUS_KM}`;
  if (Object.keys(problems).length) throw new ApiError(400, 'validation_error', 'Invalid map area', problems);
  const heightKm = (north - south) * 111.32;
  const widthKm = (east - west) * 111.32 * Math.cos((south + north) / 2 * Math.PI / 180);
  if (heightKm > MAX_BOX_KM || widthKm > MAX_BOX_KM)
    throw new ApiError(422, 'area_too_large', 'Zoom in to see restaurants');
  // Distance (and the radius filter) is measured from the caller's position, else the box center.
  const lat = Number(q.lat), lng = Number(q.lng);
  const from = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : { lat: (south + north) / 2, lng: (west + east) / 2 };
  return { south, west, north, east, from, radius };
}

// Great-circle distance.
function distanceKm(aLat, aLng, bLat, bLng) {
  const rad = d => d * Math.PI / 180;
  const h = Math.sin(rad(bLat - aLat) / 2) ** 2 +
            Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLng - aLng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const sizeLabel = seats => seats === 0 ? null : seats <= 20 ? 'small' : seats <= 60 ? 'medium' : 'large';

// ---------- restaurants from OpenStreetMap ----------
// Overpass is a shared free service with tight per-IP limits. We send one query at a time,
// retry the primary with backoff on 429/504 ("busy": waiting works better than switching),
// then try mirrors. Measured: a 5 km radius in central Bangalore is ~900 places, ~3 s;
// 10 km routinely times out on the free servers, hence MAX_RADIUS_KM.
const OVERPASS_URLS = (process.env.OVERPASS_URLS ||
  'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter')
  .split(',').map(s => s.trim()).filter(Boolean);
const BUSY_RETRY_DELAYS_MS = [2000, 5000];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OSM_ID_RE = /^osm-(node|way|relation)-(\d{1,15})$/;
const DEFAULT_SEATS = 40;                       // most OSM places don't record capacity
const DEFAULT_HOURS = ['11:00', '22:00'];       // used when OSM has no parseable opening_hours
const REFRESH_MS = 24 * 60 * 60 * 1000;
const PLACES_TTL_MS = 60 * 60 * 1000;         // restaurants rarely change; Overpass is scarce
const placesCache = new Map();                  // map-box key -> { at, places }
const placeIndex = new Map();                   // place id -> { at, place }, filled by /places

async function overpassOnce(query) {
  let busy = false;
  const attempts = [
    ...[0, ...BUSY_RETRY_DELAYS_MS].map(delay => ({ url: OVERPASS_URLS[0], delay, retryOnlyIfBusy: delay > 0 })),
    ...OVERPASS_URLS.slice(1).map(url => ({ url, delay: 0 })),
  ];
  for (const { url, delay, retryOnlyIfBusy } of attempts) {
    if (retryOnlyIfBusy && !busy) continue;          // primary failed hard: go straight to mirrors
    if (delay) await sleep(delay);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'TableKeeper-prototype/0.1' },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(20000),
      });
      if (r.ok) return (await r.json()).elements;
      busy = r.status === 429 || r.status === 504;
      console.error(`overpass ${new URL(url).host}: HTTP ${r.status}`);
    } catch (e) {
      busy = false;
      console.error(`overpass ${new URL(url).host}: ${e.message}`);
    }
  }
  if (busy) throw new ApiError(503, 'places_busy', 'Map data service is busy; try again in a few seconds');
  throw new ApiError(502, 'places_unavailable', 'Map data service is unavailable right now; try again shortly');
}

let overpassQueue = Promise.resolve();
function overpass(query) {
  const run = overpassQueue.then(() => overpassOnce(query));
  overpassQueue = run.catch(() => {});
  return run;
}

// Everything you can sit down and book at. OSM tags lots of real restaurants as fast_food or
// cafe, so restaurant-only searches look empty in many cities (e.g. 4 vs 8 within 1 km in Dubai).
// Values are the seat estimate used when OSM has no capacity tag.
const EATERY_TYPES = { restaurant: 40, fast_food: 30, cafe: 24, food_court: 80, bar: 40, pub: 40 };
const EATERY_RE = `^(${Object.keys(EATERY_TYPES).join('|')})$`;

function osmPlace(el) {
  const t = el.tags || {};
  const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
  const seats = Number.parseInt(t.capacity ?? t.seats, 10);
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  const known = Number.isFinite(seats) && seats > 0;
  const guess = EATERY_TYPES[t.amenity] ?? DEFAULT_SEATS;
  return {
    id: `osm-${el.type}-${el.id}`,
    name: t['name:en'] || t.name || null,        // many cities map a local-script `name` plus `name:en`
    kind: t.amenity,
    cuisine: t.cuisine ? t.cuisine.split(';').map(c => c.trim().replace(/_/g, ' ')).filter(Boolean).join(', ') : null,
    address: [street, t['addr:city']].filter(Boolean).join(', ') || null,
    lat, lng,
    seats: known ? seats : guess,
    seats_estimated: !known,
    size: sizeLabel(known ? seats : guess),
    opening_hours: t.opening_hours || null,
    outdoor_seating: t.outdoor_seating === 'yes' ? true : t.outdoor_seating === 'no' ? false : null,
    wheelchair: t.wheelchair || null,
    website: /^https?:\/\//.test(t.website || t['contact:website'] || '') ? (t.website || t['contact:website']) : null,
    bookable: true,
  };
}

// A plausible floor plan for `seats`: mostly 2- and 4-tops, a few bigger tables.
function tableLayout(seats) {
  const pattern = [2, 4, 4, 2, 6, 4, 2, 4, 8, 4];
  const caps = [];
  for (let i = 0, sum = 0; sum < seats; i++) { const c = pattern[i % pattern.length]; caps.push(c); sum += c; }
  return caps;
}

// Returns the DB row for a restaurant, creating/refreshing it from OSM when needed.
// Runs OUTSIDE any booking transaction: never hold row locks across a network call.
async function ensureRestaurant(id) {
  const m = OSM_ID_RE.exec(id);
  if (!m) return getRestaurant(pool, id);                         // local fixture ('r1', ...)
  const { rows } = await pool.query('SELECT * FROM restaurants WHERE id = $1', [id]);
  const cached = rows[0];
  if (cached && Date.now() - cached.fetched_at.getTime() < REFRESH_MS) return cached;

  // Usually the place was just listed by /places, so reuse that server-side copy.
  // (Never trust place details sent by the browser: they'd become bookable data.)
  let p = placeIndex.get(id);
  if (!p || Date.now() - p.at > PLACES_TTL_MS) {
    let el;
    try {
      [el] = await overpass(`[out:json][timeout:15];${m[1]}(${m[2]});out center tags;`);
    } catch (e) {
      if (cached) return cached;                                  // stale beats nothing
      throw e;
    }
    if (!el || !(el.tags?.amenity in EATERY_TYPES) || !(el.tags?.name || el.tags?.['name:en']))
      throw new ApiError(404, 'restaurant_not_found', `No restaurant ${id} on OpenStreetMap`);
    p = { at: Date.now(), place: osmPlace(el) };
  }
  p = p.place;
  const hoursOk = !!p.opening_hours && parseHours({ id, opening_hours: p.opening_hours, lat: p.lat, lng: p.lng }) !== null;
  const seats = Math.min(Math.max(p.seats, 8), 400);
  const caps = tableLayout(seats);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [row] } = await client.query(
      `INSERT INTO restaurants (id, source, name, timezone, opening_hours, open_time, close_time, hours_estimated,
                               seats_estimated, cuisine, address, website, lat, lng, kind, fetched_at)
       VALUES ($1, 'osm', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, opening_hours = EXCLUDED.opening_hours,
         hours_estimated = EXCLUDED.hours_estimated, cuisine = EXCLUDED.cuisine, address = EXCLUDED.address,
         website = EXCLUDED.website, lat = EXCLUDED.lat, lng = EXCLUDED.lng, kind = EXCLUDED.kind, fetched_at = now()
       RETURNING *`,
      [id, p.name, tzlookup(p.lat, p.lng), hoursOk ? p.opening_hours : null, DEFAULT_HOURS[0], DEFAULT_HOURS[1],
       !hoursOk, p.seats_estimated, p.cuisine, p.address, p.website, p.lat, p.lng, p.kind]);
    // Tables are created once and never regenerated: reservations point at them.
    // Two first-time requests racing here insert identical ids; ON CONFLICT makes that harmless.
    await client.query(
      `INSERT INTO tables (id, restaurant_id, capacity)
       SELECT $1 || '-T' || n, $1, cap FROM unnest($2::int[]) WITH ORDINALITY AS t(cap, n)
       WHERE NOT EXISTS (SELECT 1 FROM tables WHERE restaurant_id = $1)
       ON CONFLICT (id) DO NOTHING`, [id, caps]);
    await client.query('COMMIT');
    return row;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function restaurantInfo(r, date) {
  const { rows: tables } = await pool.query(
    'SELECT capacity, count(*)::int AS n FROM tables WHERE restaurant_id = $1 GROUP BY capacity ORDER BY capacity', [r.id]);
  const seats = tables.reduce((s, t) => s + t.capacity * t.n, 0);
  return {
    id: r.id, source: r.source, name: r.name, kind: r.kind, cuisine: r.cuisine, address: r.address, website: r.website,
    lat: r.lat, lng: r.lng, timezone: r.timezone, turn_minutes: r.turn_minutes,
    opening_hours: r.opening_hours, hours_estimated: r.hours_estimated,
    hours_on_date: { date, intervals: openIntervals(r, date).map(i => ({ open: i.open.toFormat('HH:mm'), close: i.close.toFormat('HH:mm') })) },
    seats, seats_estimated: r.seats_estimated, size: sizeLabel(seats),
    table_count: tables.reduce((s, t) => s + t.n, 0),
    tables_by_size: Object.fromEntries(tables.map(t => [t.capacity, t.n])),
    max_party: Math.min(20, tables.at(-1)?.capacity ?? 0),
  };
}

function checkDate(date) {
  if (typeof date !== 'string' || !DATE_RE.test(date) || !DateTime.fromISO(date).isValid)
    throw new ApiError(400, 'validation_error', 'Need date=YYYY-MM-DD');
}

// ---------- routes ----------
app.get('/health', (_req, res) => res.json({ ok: true }));

// Restaurants inside a map box (optionally within radius_km of lat/lng), live from
// OpenStreetMap, nearest first. The box is snapped outward to a ~1 km grid, and any fresh
// cached box that covers the request is reused, so pans and smaller radii skip Overpass.
const OVERPASS_LIMIT = 3000;
const placesInflight = new Map();               // box key -> { s, w, n, e, promise }
const covers = (h, box) => h.s <= box.south && h.w <= box.west && h.n >= box.north && h.e >= box.east;

// ---------- Geoapify: the same OSM data as Overpass, but answers in ~1 s instead of 3-15 s ----------
// Used when GEOAPIFY_API_KEY is set (free key: https://myprojects.geoapify.com, 3000 credits/day,
// 1 credit per 20 places). Each result carries the original OSM id and tags in datasource.raw,
// so places keep the same 'osm-node-123' ids and flow through osmPlace() unchanged.
const GEOAPIFY_KEY = process.env.GEOAPIFY_API_KEY || '';
const GEOAPIFY_PAGE = 500;                      // API maximum per request
const GEOAPIFY_MAX_PAGES = 3;                   // dense city centres: up to 1500 places per box
const GEOAPIFY_CATEGORIES = Object.keys(EATERY_TYPES).map(k => `catering.${k}`).join(',');
const OSM_TYPES = { n: 'node', w: 'way', r: 'relation', node: 'node', way: 'way', relation: 'relation' };
let geoapifyDisabledUntil = 0;                  // after a bad key / quota error, use Overpass for a while

function geoapifyToOsm(f) {
  const p = f.properties ?? {}, raw = p.datasource?.raw ?? {};
  const type = OSM_TYPES[raw.osm_type], id = raw.osm_id;
  if (!type || !id) return null;                // not an OSM-backed place: we couldn't book it by id
  const kind = raw.amenity in EATERY_TYPES ? raw.amenity
    : Object.keys(EATERY_TYPES).find(k => p.categories?.includes(`catering.${k}`)) ?? 'restaurant';
  return {
    type, id: Math.abs(id), lat: p.lat, lon: p.lon,
    tags: { ...raw, amenity: kind, name: raw.name ?? p.name,
            'addr:street': raw['addr:street'] ?? p.street, 'addr:housenumber': raw['addr:housenumber'] ?? p.housenumber,
            'addr:city': raw['addr:city'] ?? p.city },
  };
}

async function geoapifyBox(s, w, n, e) {
  const els = [];
  for (let page = 0; page < GEOAPIFY_MAX_PAGES; page++) {
    const url = new URL(process.env.GEOAPIFY_URL || 'https://api.geoapify.com/v2/places');
    url.search = new URLSearchParams({
      categories: GEOAPIFY_CATEGORIES, filter: `rect:${w},${s},${e},${n}`,
      bias: `proximity:${(w + e) / 2},${(s + n) / 2}`, limit: GEOAPIFY_PAGE, offset: page * GEOAPIFY_PAGE,
      lang: 'en', apiKey: GEOAPIFY_KEY,
    });
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) {
      const err = new Error(`Geoapify HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    const features = (await r.json()).features ?? [];
    els.push(...features.map(geoapifyToOsm).filter(Boolean));
    if (features.length < GEOAPIFY_PAGE) return { els, complete: true };
  }
  return { els, complete: false };
}

// One box search, from the fastest source available.
async function searchBox(s, w, n, e) {
  if (GEOAPIFY_KEY && Date.now() > geoapifyDisabledUntil) {
    try {
      return { ...(await geoapifyBox(s, w, n, e)), source: 'geoapify' };
    } catch (err) {
      // 401/403: bad key; 429: daily quota. Don't hammer it; Overpass still works, just slower.
      if ([401, 403, 429].includes(err.status)) geoapifyDisabledUntil = Date.now() + 10 * 60 * 1000;
      console.error(`${err.message}; falling back to Overpass`);
    }
  }
  const els = await overpass(`[out:json][timeout:25];nwr["amenity"~"${EATERY_RE}"]["name"](${s},${w},${n},${e});out center tags ${OVERPASS_LIMIT};`);
  return { els, complete: els.length < OVERPASS_LIMIT, source: 'overpass' };
}

function fetchBox(s, w, n, e) {
  const key = `${s},${w},${n},${e}`;
  const promise = searchBox(s, w, n, e)
    .then(({ els, complete }) => {
      // A truncated answer is fine for this box but mustn't stand in for sub-boxes it may be missing.
      const hit = { at: Date.now(), s, w, n, e, complete,
                    places: els.map(osmPlace).filter(p => p.name && p.lat != null) };
      placesCache.delete(key);                  // re-insert so eviction order is by recency
      placesCache.set(key, hit);
      if (placesCache.size > 300) placesCache.delete(placesCache.keys().next().value);
      for (const place of hit.places) placeIndex.set(place.id, { at: hit.at, place });
      if (placeIndex.size > 20000) placeIndex.clear();              // crude bound; it's only a cache
      return hit;
    })
    .finally(() => placesInflight.delete(key));
  placesInflight.set(key, { s, w, n, e, promise });
  return promise;
}

app.get('/places', wrap(async (req, res) => {
  const box = parseBbox(req.query);
  const snap = (v, f) => Math[f](v * 100) / 100;
  const [s, w, n, e] = [snap(box.south, 'floor'), snap(box.west, 'floor'), snap(box.north, 'ceil'), snap(box.east, 'ceil')];
  const cached = [...placesCache.values()].filter(h => h.complete && covers(h, box));
  let hit = cached.find(h => Date.now() - h.at <= PLACES_TTL_MS);
  let stale = false;
  if (!hit) {
    // Browsers abort superseded requests, but we don't: join an identical/covering query
    // already on its way to Overpass instead of spending another one.
    const pending = [...placesInflight.values()].find(q => covers(q, box));
    try {
      hit = await (pending?.promise ?? fetchBox(s, w, n, e));
    } catch (err) {
      // Overpass busy/down: older results for this area beat an error.
      hit = cached.sort((a, b) => b.at - a.at)[0];
      if (!hit) throw err;
      stale = true;
    }
  }
  const places = hit.places
    .filter(p => p.lat >= box.south && p.lat <= box.north && p.lng >= box.west && p.lng <= box.east)
    .map(p => ({ ...p, distance_km: Math.round(distanceKm(box.from.lat, box.from.lng, p.lat, p.lng) * 100) / 100 }))
    .filter(p => box.radius === null || p.distance_km <= box.radius)
    .sort((a, b) => a.distance_km - b.distance_km);
  res.json({ source: 'OpenStreetMap', attribution: '© OpenStreetMap contributors',
             fetched_at: new Date(hit.at).toISOString(), stale, places });
}));

// Full details for one restaurant (fetched from OSM and made bookable on first use).
app.get('/restaurants/:id', wrap(async (req, res) => {
  const date = req.query.date ?? DateTime.now().toISODate();
  checkDate(date);
  const r = await ensureRestaurant(req.params.id);
  res.json(await restaurantInfo(r, date));
}));

app.get('/restaurants/:id/availability', wrap(async (req, res) => {
  const { date } = req.query;
  const party = Number(req.query.party_size);
  if (typeof date !== 'string' || !DATE_RE.test(date) || !Number.isInteger(party) || party < 1 || party > 20)
    throw new ApiError(400, 'validation_error', 'Need date=YYYY-MM-DD and party_size=1..20');
  const r = await ensureRestaurant(req.params.id);
  const dayStart = DateTime.fromISO(date, { zone: r.timezone });
  if (!dayStart.isValid) throw new ApiError(400, 'validation_error', 'Invalid date');
  const intervals = openIntervals(r, date);
  const until = intervals.reduce((mx, i) => (i.close > mx ? i.close : mx), dayStart.plus({ days: 1 }));
  const { rows: tables } = await pool.query(
    'SELECT id FROM tables WHERE restaurant_id = $1 AND capacity >= $2', [r.id, party]);
  const { rows: booked } = await pool.query(
    `SELECT table_id, starts_at, ends_at FROM reservations
     WHERE restaurant_id = $1 AND status = 'confirmed' AND starts_at < $3 AND ends_at > $2`,
    [r.id, dayStart.toJSDate(), until.toJSDate()]);

  const slots = [];
  for (const { open, close } of intervals) {
    // First slot on the hour or half hour at/after opening.
    let t = open.startOf('hour').plus({ minutes: open.minute === 0 ? 0 : open.minute <= 30 ? 30 : 60 });
    while (t.toISODate() === date && t.plus({ minutes: r.turn_minutes }) <= close) {
      const end = t.plus({ minutes: r.turn_minutes });
      const free = tables.filter(tb => !booked.some(b =>
        b.table_id === tb.id && b.starts_at < end.toJSDate() && b.ends_at > t.toJSDate()));
      slots.push({ time: t.toFormat('HH:mm'), starts_at: t.toUTC().toISO(), available_tables: free.length });
      t = t.plus({ minutes: 30 });
    }
  }
  res.json({ restaurant_id: r.id, date, timezone: r.timezone, party_size: party,
             hours: intervals.map(i => ({ open: i.open.toFormat('HH:mm'), close: i.close.toFormat('HH:mm') })),
             hours_estimated: r.hours_estimated, closed: intervals.length === 0, slots });
}));

app.post('/reservations', wrap(async (req, res) => {
  const input = validateBooking(req.body);
  await ensureRestaurant(input.restaurant_id);      // network call happens before the transaction
  await idempotent(req, res, 'POST /reservations', input, async db => {
    const r = await getRestaurant(db, input.restaurant_id);
    const start = localToInstant(input.date, input.time, r.timezone);
    const end = start.plus({ minutes: r.turn_minutes });
    if (start < DateTime.now()) throw new ApiError(422, 'in_past', 'Cannot book a time in the past');
    if (!withinHours(r, start, end)) throw new ApiError(422, 'outside_hours', 'Restaurant is closed then');

    // Smallest table that fits first. No SELECT-then-INSERT race: we just TRY the insert,
    // and the exclusion constraint rejects overlaps atomically (SQLSTATE 23P01).
    const { rows: tables } = await db.query(
      'SELECT id FROM tables WHERE restaurant_id = $1 AND capacity >= $2 ORDER BY capacity, id',
      [r.id, input.party_size]);
    // Two in-flight inserts that overlap each wait on the other's uncommitted row, and Postgres
    // aborts one with a deadlock (40P01) -> 500s and lost tables in the race test. Queue
    // bookings per restaurant instead; the constraint below stays the actual guarantee.
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`book:${r.id}`]);
    for (const tb of tables) {
      await db.query('SAVEPOINT try_table');
      try {
        const { rows } = await db.query(
          `INSERT INTO reservations (restaurant_id, table_id, guest_name, party_size, starts_at, ends_at)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [r.id, tb.id, input.guest_name, input.party_size, start.toJSDate(), end.toJSDate()]);
        await db.query('RELEASE SAVEPOINT try_table');
        return { status: 201, body: toJson(rows[0], r.timezone) };
      } catch (e) {
        if (e.code !== '23P01') throw e;
        await db.query('ROLLBACK TO SAVEPOINT try_table');
      }
    }
    return { status: 409, body: errBody('slot_unavailable', 'No table available for that time and party size') };
  });
}));

app.get('/reservations/:id', wrap(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) throw new ApiError(404, 'reservation_not_found', 'Not found');
  const { rows } = await pool.query(
    'SELECT res.*, r.timezone FROM reservations res JOIN restaurants r ON r.id = res.restaurant_id WHERE res.id = $1',
    [req.params.id]);
  if (!rows[0]) throw new ApiError(404, 'reservation_not_found', 'Not found');
  res.json(toJson(rows[0], rows[0].timezone));
}));

// Cancel is a single conditional UPDATE: check-and-act in one statement.
app.post('/reservations/:id/cancel', wrap(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) throw new ApiError(404, 'reservation_not_found', 'Not found');
  await idempotent(req, res, `POST /reservations/${req.params.id}/cancel`, {}, async db => {
    const { rows } = await db.query(
      `UPDATE reservations SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed'
       RETURNING *, (SELECT timezone FROM restaurants WHERE id = restaurant_id)`, [req.params.id]);
    if (rows[0]) return { status: 200, body: toJson(rows[0], rows[0].timezone) };
    const exists = await db.query('SELECT 1 FROM reservations WHERE id = $1', [req.params.id]);
    if (!exists.rowCount) throw new ApiError(404, 'reservation_not_found', 'Not found');
    return { status: 409, body: errBody('already_cancelled', 'Reservation is already cancelled') };
  });
}));

// ---------- error handler: the "never a 500 for bad input" net ----------
app.use((_req, res) => res.status(404).json(errBody('not_found', 'No such route')));
app.use((err, _req, res, _next) => {
  if (err instanceof ApiError) return res.status(err.status).json(errBody(err.code, err.message, err.details));
  if (err.type === 'entity.parse.failed') return res.status(400).json(errBody('malformed_json', 'Body is not valid JSON'));
  if (err.type === 'entity.too.large') return res.status(413).json(errBody('payload_too_large', 'Body too large'));
  console.error(err);
  res.status(500).json(errBody('internal_error', 'Something went wrong'));
});

// On Vercel the app runs as a serverless function: export it instead of listening.
export default app;
if (!process.env.VERCEL) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`TableKeeper on http://localhost:${port} (places: ${GEOAPIFY_KEY ? 'Geoapify, Overpass as fallback' : 'Overpass; set GEOAPIFY_API_KEY in .env for faster search'})`));
}
