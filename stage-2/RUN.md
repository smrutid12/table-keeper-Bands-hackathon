# Running Tablekeeper — stage 2

No manual setup, no external dependencies at runtime (pure Node.js standard
library; no npm packages required at all, server or browser).

## Build

```sh
docker build -t tablekeeper-stage2 .
```

## Run

```sh
docker run --rm -p 8080:8080 -e PORT=8080 tablekeeper-stage2
```

The service listens on `0.0.0.0:$PORT` (default `8080`) and is ready as soon
as it logs `tablekeeper listening on 0.0.0.0:8080`. `GET /health` returns
`200 {"status": "ok"}` immediately.

## Using the browser UI

Open `http://localhost:8080/` after seeding a fixture (below). Routes:
`/` (search + booking), `/signup`, `/login`, `/lookup`.

## Smoke test

```sh
curl http://localhost:8080/health

curl -X POST http://localhost:8080/_test/reset \
  -H 'Content-Type: application/json' \
  -d '{"restaurants":[{"id":"r_anker","name":"Zum Anker","timezone":"Europe/Berlin","slot_minutes":30,"reservation_duration_minutes":90,"cancellation_cutoff_minutes":120,"opening_hours":[{"weekday":"thu","opens":"18:00","closes":"23:00"}],"tables":[{"id":"t_1","label":"1","capacity":2},{"id":"t_2","label":"2","capacity":2}],"combinable":[["t_1","t_2"]]}]}'

curl "http://localhost:8080/availability?restaurant_id=r_anker&date=2026-12-31&party_size=2"
```

`available_options` in that response lists both single tables and the
`t_1`+`t_2` combination. `POST /reservations` accepts `table_id` (single) or
`table_ids` (array of 1 or 2) — see `/Users/nandinijain/Desktop/Hackathon/dark-factory-wearedevs/tablekeeper/spec/stage-2.md`
for the full API and UI contract.
