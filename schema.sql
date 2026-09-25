-- TableKeeper schema. The key idea: double-booking is made IMPOSSIBLE by the
-- database itself (an exclusion constraint), not just "checked" by app code.
DROP TABLE IF EXISTS idempotency_keys, reservations, tables, restaurants CASCADE;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Restaurants are discovered live from OpenStreetMap. A row is created the first time someone
-- looks at a place's availability, because bookings need something to reference.
-- id is 'osm-node-123' / 'osm-way-456' for OSM places; 'r1', 'r2' are local test fixtures.
CREATE TABLE restaurants (
  id              text PRIMARY KEY,
  source          text NOT NULL DEFAULT 'local' CHECK (source IN ('local','osm')),
  name            text NOT NULL,
  timezone        text NOT NULL,            -- IANA zone, e.g. 'America/New_York'
  opening_hours   text,                     -- OSM opening_hours syntax; wins over open/close_time
  open_time       time NOT NULL,            -- fallback daily hours, local wall-clock time
  close_time      time NOT NULL,
  hours_estimated boolean NOT NULL DEFAULT false,
  turn_minutes    int  NOT NULL DEFAULT 90 CHECK (turn_minutes > 0),
  seats_estimated boolean NOT NULL DEFAULT false,  -- true when OSM had no capacity tag
  kind            text,                     -- OSM amenity: restaurant, cafe, fast_food, bar, pub, food_court
  cuisine         text,
  address         text,
  website         text,
  lat             double precision CHECK (lat BETWEEN -90 AND 90),
  lng             double precision CHECK (lng BETWEEN -180 AND 180),
  fetched_at      timestamptz               -- last refresh from OSM
  -- Size/capacity are NOT stored here: they're derived from `tables`, so they can't drift.
);

CREATE TABLE tables (
  id             text PRIMARY KEY,
  restaurant_id  text NOT NULL REFERENCES restaurants(id),
  capacity       int  NOT NULL CHECK (capacity > 0)
);

CREATE TABLE reservations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  text NOT NULL REFERENCES restaurants(id),
  table_id       text NOT NULL REFERENCES tables(id),
  guest_name     text NOT NULL,
  party_size     int  NOT NULL CHECK (party_size > 0),
  starts_at      timestamptz NOT NULL,       -- always an absolute instant (UTC inside)
  ends_at        timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  -- THE invariant: no two confirmed reservations on the same table may overlap.
  -- Half-open range [start, end) so a 19:30 end and a 19:30 start don't collide.
  CONSTRAINT no_double_booking EXCLUDE USING gist (
    table_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status = 'confirmed')
);

CREATE TABLE idempotency_keys (
  key           text NOT NULL,
  endpoint      text NOT NULL,
  request_hash  text NOT NULL,
  status_code   int,                         -- NULL while the first request is still running
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, endpoint)
);

-- Test fixtures for race-test.js (not shown in the UI, which lists OSM places only).
-- Party of 4 fits T2, T3, T4 -> at most 3 bookings per slot.
INSERT INTO restaurants (id, name, timezone, open_time, close_time, turn_minutes) VALUES
  ('r1','Harbor Bistro',  'America/New_York','17:00','22:00',90),
  -- A 24h diner so DST edge cases (1-3am) can be exercised.
  ('r2','Night Owl Diner','America/New_York','00:00','23:59',60);
INSERT INTO tables VALUES ('T1','r1',2),('T2','r1',4),('T3','r1',4),('T4','r1',6);
INSERT INTO tables VALUES ('N1','r2',4);
