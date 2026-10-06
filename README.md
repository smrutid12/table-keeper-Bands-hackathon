# Tablekeeper — Bands hackathon entry

![Uploading tablekeeper-cover.png…]()

**Track:** `tablekeeper` — a restaurant reservation system where a table must never be
double-booked, under concurrency, retries and time zones.

## How to read this repository

| Path | What it is |
|---|---|
| [`FACTORY.md`](FACTORY.md) | The factory: seats, design, costs, and a bad result it caught (and one it didn't) |
| [`mandates/`](mandates/) | One `.md` per seat: harness, model, and how that seat works |
| `room.json` | The Band Desktop room log the factory ran in |
| [`stage-1/`](stage-1/) | JSON API: reservations, availability, idempotency, DST handling |
| [`stage-2/`](stage-2/) | Browser UI, combined-table bookings, recovery from stale/lost responses |
| [`stage-3/`](stage-3/) | Dated policies, reservation history/revisions, recurring series |
| [`stage-4/`](stage-4/) | Seating-repair planning (combinatorial solver) and series amendments |

Each `stage-N/` folder is a complete, standalone service — `Dockerfile` + `RUN.md` —
built by copying the previous stage forward and extending it. See each folder's
`RUN.md` for how to build and run it.

## Status

All four stages were built, reviewed, and accepted by the band in a single dark-factory
dispatch. Independently verified afterward with the project's own harness
(`python -m harness run --track tablekeeper --repo . --stage 4`):

```
stage 1: fail   (114/120 — 6 failing checks)
stage 2: fail   (22/25 — 3 failing checks)
stage 3: pass   (7/7)
stage 4: pass   (6/6)
highest contiguous stage: 0
```

Stage 3 and 4's own suites pass cleanly. Stage 1 and 2 have a small number of real
conformance gaps that recurred identically across three independent from-scratch
rebuilds, despite deliberately sharpening the Reviewer and Implementer seats'
instructions in response. See [`FACTORY.md`](FACTORY.md) for what those gaps are, why
they're a genuine factory limitation and not an oversight we're hiding, and what we
tried.

## Root prototype (Vercel deploy)

The files at the repository root (`server.js`, `api/`, `public/`, `schema.sql`, `vercel.json`) are a separate Postgres-backed TableKeeper prototype deployed on Vercel.


A reservation API where a table **cannot** be double-booked, even under 100 simultaneous
requests, retries, and DST weirdness.

### Run it
```bash
npm install
# Database: set DATABASE_URL in .env (git-ignored), e.g. for a local Postgres:
#   DATABASE_URL=postgres://postgres:<password>@127.0.0.1:5432/tablekeeper
#   URL-encode special characters in the password: '#' -> %23, '@' -> %40.
# No local Postgres? `docker compose up -d` and leave .env out (defaults to the container on :5433).
npm run db:init                           # creates the DB if needed, loads schema + demo restaurants
npm start                                 # http://localhost:3000 (UI + API)
npm run race                              # the proof script (re-run db:init first for a clean board)
```

### Endpoints (placeholder until the real SPEC drops)
| Method | Path | Notes |
|---|---|---|
| GET  | /places?south=&west=&north=&east=[&lat=&lng=] | restaurants in a map box, live from OpenStreetMap (box ≤ 0.3°) |
| GET  | /restaurants/:id?date=YYYY-MM-DD | type, size, seats, tables, hours; makes an OSM place bookable on first use |
| GET  | /restaurants/:id/availability?date=YYYY-MM-DD&party_size=N | slots in local time + UTC |
| POST | /reservations | body `{restaurant_id, date, time, party_size, guest_name}`, optional `Idempotency-Key` header |
| GET  | /reservations/:id | |
| POST | /reservations/:id/cancel | conditional UPDATE, idempotent |

Errors are always `{"error": {"code", "message", "details?"}}`.

### Where restaurants come from
Restaurants are not seeded: the map searches OpenStreetMap data for whatever area is on screen
(results cached 1 h). Two sources, same data and ids:
- **Geoapify Places API** when `GEOAPIFY_API_KEY` is set in `.env`: ~1 s per search. Free tier
  3000 credits/day, 1 credit per 20 places (a 5 km search in a busy area is ~7-25 credits).
- **Overpass API** otherwise, or automatically if Geoapify rejects the key or runs out of quota: free, no key, 3-15 s.

Picking one copies it into `restaurants` so bookings have something to reference; details are
re-fetched from OSM at most daily. Restaurant types: restaurant, cafe, fast_food, food_court, bar, pub.
- **Type**: OSM `cuisine`. **Hours**: OSM `opening_hours` (holiday rules ignored); none → 11:00–22:00, flagged `hours_estimated`.
- **Size / capacity**: OSM `capacity` when mapped (rare); otherwise 40 seats, flagged `seats_estimated`.
  A table layout is generated once from the seat count and never regenerated (reservations point at it).
- **Time zone**: derived from coordinates (`@photostructure/tz-lookup`).
- `r1` / `r2` are local fixtures for `race-test.js` only.

### Why it's correct
- **Double booking**: `EXCLUDE USING gist (table_id WITH =, tstzrange(starts_at, ends_at) WITH &&)`.
  The app never does check-then-insert; it just tries the insert and handles SQLSTATE 23P01.
- **Idempotency**: key is claimed with `INSERT ... ON CONFLICT DO NOTHING` in the *same* transaction
  as the booking. Duplicates block on the index, then read the stored response. Same key +
  different body → 422. Crash mid-request → rollback frees the key.
- **Time zones**: store instants (`timestamptz`), accept local wall-clock + restaurant IANA zone,
  reject DST-gap times (`nonexistent_local_time`) and DST-overlap times (`ambiguous_local_time`).
- **Bad input**: validated at the edge, JSON parse errors mapped, final handler as a safety net.

### Bug the race test caught
The replay path first fetched the stored response with a *second* pool connection. Under 30
concurrent replays every connection was held by a waiting duplicate → pool deadlock.
Fix: reuse the transaction's own connection. Keep this story for the demo.
