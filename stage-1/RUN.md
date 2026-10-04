# Running Tablekeeper — stage 1

No manual setup, no external dependencies at runtime (pure Node.js standard
library; no npm packages required at all).

## Build

```sh
docker build -t tablekeeper-stage1 .
```

## Run

```sh
docker run --rm -p 8080:8080 -e PORT=8080 tablekeeper-stage1
```

The service listens on `0.0.0.0:$PORT` (default `8080`) and is ready as soon
as it logs `tablekeeper listening on 0.0.0.0:8080`. `GET /health` returns
`200 {"status": "ok"}` immediately.

## Smoke test

```sh
curl http://localhost:8080/health

curl -X POST http://localhost:8080/_test/reset \
  -H 'Content-Type: application/json' \
  -d '{"restaurants":[{"id":"r_anker","name":"Zum Anker","timezone":"Europe/Berlin","slot_minutes":30,"reservation_duration_minutes":90,"cancellation_cutoff_minutes":120,"opening_hours":[{"weekday":"thu","opens":"18:00","closes":"23:00"}],"tables":[{"id":"t_1","label":"1","capacity":2}]}]}'

curl "http://localhost:8080/availability?restaurant_id=r_anker&date=2026-12-31&party_size=2"
```
