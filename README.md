# Tablekeeper — Bands hackathon entry

<!-- TODO: team name and members -->

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
