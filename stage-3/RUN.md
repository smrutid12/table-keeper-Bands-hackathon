# Running Tablekeeper — stage 3

No manual setup, no external dependencies at runtime (pure Node.js standard
library; no npm packages required at all, server or browser).

## Build

```sh
docker build -t tablekeeper-stage3 .
```

## Run

```sh
docker run --rm -p 8080:8080 -e PORT=8080 tablekeeper-stage3
```

The service listens on `0.0.0.0:$PORT` (default `8080`) and is ready as soon
as it logs `tablekeeper listening on 0.0.0.0:8080`. `GET /health` returns
`200 {"status": "ok"}` immediately.

## Using the browser UI

Open `http://localhost:8080/` after seeding a fixture (below). Routes:
`/` (search + booking), `/signup`, `/login`, `/lookup`.

## New in stage 3

- **Dated policies.** `POST /restaurants/{id}/policies` (manager-only, via
  `manager_user_ids` on the restaurant fixture) publishes a new
  `{effective_from, slot_minutes, reservation_duration_minutes,
  cancellation_cutoff_minutes, opening_hours, capacities}` policy version.
  `GET /restaurants/{id}/policies` lists all published versions. Every
  booking/availability/amend operation resolves the policy in effect for the
  reservation's local date (greatest `effective_from` <= date, ties broken by
  greatest `policy_version`; falls back to a synthesized "policy 0" from the
  restaurant's base fixture fields when nothing has been published yet).
- **Accepted terms & revisions.** Every reservation freezes the policy it was
  booked/amended under as `accepted_terms`, and carries a `revision` counter.
  Amend/move requests may pass `expected_revision` for optimistic
  concurrency; a mismatch is `409 stale_revision`.
- **History & decision.** `GET /reservations/{reference}/history` and
  `GET /reservations/{reference}/decision` return `404` (not `401`) for
  anonymous or non-owner callers, to avoid revealing a reference exists.
- **Recurring series.** `POST /series` adopts an existing reservation as the
  anchor of a weekly/N-weekly series (`count`, `interval_weeks`), planning and
  validating every occurrence before committing any of them. `GET
  /series/{id}` (owner-only, 404-shaped like history/decision) returns all
  occurrences. A direct `PATCH`/cancel on an occurrence's own reference
  bumps the series revision; a real (non-no-op) amendment also flags that
  occurrence as an `exception`.
- **`available_options` / `explain`.** `GET /availability?...&explain=true`
  adds a per-table `explain` breakdown (`capacity`/`no_overlap` rule
  results) alongside the existing `available_options` list of bookable
  single tables and combinable pairs.

## Smoke test

```sh
curl http://localhost:8080/health

curl -X POST http://localhost:8080/_test/reset \
  -H 'Content-Type: application/json' \
  -d '{"restaurants":[{"id":"r_anker","name":"Zum Anker","timezone":"Europe/Berlin","slot_minutes":30,"reservation_duration_minutes":90,"cancellation_cutoff_minutes":120,"opening_hours":[{"weekday":"thu","opens":"18:00","closes":"23:00"}],"tables":[{"id":"t_1","label":"1","capacity":2},{"id":"t_2","label":"2","capacity":2}],"combinable":[["t_1","t_2"]],"manager_user_ids":["u_mgr"]}],"users":[{"id":"u_mgr","email":"mgr@example.com","password":"hunter2"}]}'

curl "http://localhost:8080/availability?restaurant_id=r_anker&date=2026-12-31&party_size=2&explain=true"
```

See
`/Users/nandinijain/Desktop/Hackathon/dark-factory-wearedevs/tablekeeper/spec/stage-3.md`
for the full API and UI contract.
