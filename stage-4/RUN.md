# Running Tablekeeper — stage 4

No manual setup, no external dependencies at runtime (pure Node.js standard
library; no npm packages required at all, server or browser).

## Build

```sh
docker build -t tablekeeper-stage4 .
```

## Run

```sh
docker run --rm -p 8080:8080 -e PORT=8080 tablekeeper-stage4
```

The service listens on `0.0.0.0:$PORT` (default `8080`) and is ready as soon
as it logs `tablekeeper listening on 0.0.0.0:8080`. `GET /health` returns
`200 {"status": "ok"}` immediately.

## Using the browser UI

Open `http://localhost:8080/` after seeding a fixture (below). Routes:
`/` (search + booking), `/signup`, `/login`, `/lookup`. No new screens are
required for seating repairs or series amendments; applied plans are
reflected through the existing availability/confirmation/lookup screens.

## New in stage 4

- **Seating-repair plans.** `POST /restaurants/{id}/replans` (manager-only)
  previews a seating rearrangement for a proposed table closure
  `{table_id, from, to}` (RFC3339 instants with explicit offsets). Every
  confirmed booking overlapping the interval is re-seated (if needed) into a
  single table or declared pair with enough capacity under its own frozen
  accepted terms, with no conflicts against fixed bookings, other
  reassignments, previously applied closures, or the proposed closure
  itself. Feasible plans minimize, in order: how many bookings move, total
  unused seats, then a deterministic rank-vector tiebreak. Planning is
  bounded (<=6 tables, <=4 declared pairs, <=6 considered bookings); larger
  inputs are `422 planning_limit`, and no feasible rearrangement is `409
  no_feasible_plan`. A preview changes nothing.
- `POST /restaurants/{id}/replans/{plan_id}/apply` (manager-only, idempotent)
  commits a previously-previewed plan atomically: records the closure,
  reassigns every moved booking (one revision bump + one `reassigned`
  history entry carrying `plan_id`), and bumps the restaurant revision once
  for the whole plan. An intervening restaurant revision invalidates the
  plan (`409 stale_plan`); applying twice under different keys is `409
  plan_already_applied`; replaying the same key returns the original
  response. Applied closures thereafter block availability and new
  bookings/amendments on that table for that interval.
- **Series amendments.** `POST /series/{id}/amend` (owner-only) shifts the
  clock time of eligible occurrences (index >= `from_index`, not cancelled,
  not already an exception) onto each occurrence's own scheduled date,
  validating old cutoff and the resulting date's policy per occurrence, all
  before committing any of them. Series amendments never mark exceptions.
  `expected_revision` guards against concurrent amendments.
- **Restaurant revision.** Now increments on every successful new booking,
  real amendment, cancellation, policy publication, or plan application
  (once per operation/batch); previews, no-ops, failures and replays never
  change it. Surfaced in replan preview/apply responses.

## Smoke test

```sh
curl http://localhost:8080/health

curl -X POST http://localhost:8080/_test/reset \
  -H 'Content-Type: application/json' \
  -d '{"restaurants":[{"id":"r_anker","name":"Zum Anker","timezone":"Europe/Berlin","slot_minutes":30,"reservation_duration_minutes":90,"cancellation_cutoff_minutes":120,"opening_hours":[{"weekday":"thu","opens":"18:00","closes":"23:00"}],"tables":[{"id":"t_1","label":"1","capacity":2},{"id":"t_2","label":"2","capacity":2}],"combinable":[["t_1","t_2"]],"manager_user_ids":["u_mgr"]}],"users":[{"id":"u_mgr","email":"mgr@example.com","password":"hunter2"}]}'

curl "http://localhost:8080/availability?restaurant_id=r_anker&date=2026-12-31&party_size=2&explain=true"
```

See
`/Users/nandinijain/Desktop/Hackathon/dark-factory-wearedevs/tablekeeper/spec/stage-4.md`
for the full API and UI contract.
