# Factory design

Three seats, each with one job, coordinating directly with each other. No dedicated
orchestrator seat — the human dispatches the stage task directly to the seat doing the
work, and the band resolves everything else itself.

## Seats

| Seat | Harness | Model | Owns |
|---|---|---|---|
| Implementer | Claude Code | claude-sonnet-5 | Reads the spec, builds/extends the service, self-tests, commits, hands off |
| Reviewer | Claude Code | claude-sonnet-5 | Independently re-verifies every claim against the committed revision; accepts or escalates |
| Investigator | Claude Code | claude-sonnet-5 | Root-cause analysis when Reviewer finds a failure; never writes code or renders a verdict |

Each seat's full instructions are in `mandates/`. They're deliberately written as
general engineering disciplines — a review methodology, a debugging methodology, an
implementation methodology — with zero reference to reservations, tables, or any
tablekeeper vocabulary. Point the same three seats and the same handoff protocol at a
completely different problem and the mandates still read correctly.

## Why this shape

**No coordinator seat.** An early design had a seat also acting as dispatcher. It
correctly refused the job the moment it was asked — its own mandate scoped it to
root-cause analysis, not orchestration, and it said so rather than silently absorbing a
role it wasn't built for. Rather than override that, the factory was built around it:
the human dispatches directly to Implementer, and Investigator only ever sees a
handoff when there's something to actually diagnose.

**Reviewer escalates, it doesn't just report.** Reviewer's mandate requires it to verify
every claim itself — rerun the gate, read the actual commit, not trust "all green" — and
attack the design rather than confirm it, working through explicit lenses (trust
boundaries on new inputs, symmetry with problems found earlier in the same round,
untested orderings, non-functional failure modes). When something fails, Reviewer
doesn't report pass/fail back to Implementer — it packages the failing evidence into a
self-contained handoff to Investigator and relays the diagnosis back, so the fix
addresses the cause Investigator found, not the symptom Reviewer observed.

**Investigator never touches code or calls the verdict.** Keeping diagnosis separate
from both implementation and acceptance means a fix always passes back through
Reviewer before anything is accepted — a diagnosis is not the same as a fix, and an
explanation is not the same as a verified correction.

**Dark-factory autonomy is layered on top of, not instead of, each seat's base
methodology.** Each seat's core instructions (the review/debugging/implementation
disciplines above) are generic and portable. A separate, explicit "this factory's
operating rules" section is appended to each — overriding any built-in instinct to ask
a human for product, scope or timing decisions, and wiring in the literal `@handles`
and handoff protocol specific to this room. That split exists so the reusable
methodology and the one-room operating protocol don't have to be rewritten together.

## What it cost

The practice run (an unscored 4-stage shared-counter service, same shape as this track)
dispatched once and finished all four stages in about 18 minutes wall-clock, with no
escalation to Investigator needed — Reviewer's own ad hoc adversarial testing caught
nothing wrong on the first pass.

The real tablekeeper build needed three independent full rebuilds to reach a stable
result (see "What we tried that didn't work" below). The final accepted run hit a
Claude Code session/usage limit mid-stage-3, stalling roughly four hours; it was
resumed with a single zero-content message telling the band to continue, which we're
disclosing here rather than omitting because it's a real operating cost of a
long-running autonomous build on a subscription plan, not a design choice. Per-seat
token or dollar spend wasn't separately metered for this run.

## How it catches a bad result

Across the rebuild cycles, Reviewer's independent re-verification (never trusting
Implementer's report, always re-running the gate and reading the actual diff) caught
and routed to Investigator, through Implementer's own fix, several real defects before
they reached an accepted revision:

- A stale-confirmation UI bug in stage 2: a rejected resubmission could leave a prior
  successful booking's confirmation on screen next to a fresh error. Reviewer reproduced
  it live with a real browser session, not just by reading the code.
- A reversed-table-pair bug in stage 3: `["t_2","t_1"]` against a stored `["t_1","t_2"]`
  was being treated as a real amendment (bumping revision, writing history) instead of
  the no-op it actually is.
- A series-exception bug in stage 3: amending a recurring occurrence directly, rather
  than through the batch-move endpoint, wasn't marking the occurrence as an exception
  or bumping the series revision.

All three were fixed and verified fixed — not just claimed fixed — before the revision
that introduced them was ever accepted.

## What we tried that didn't work

Independently verifying each of the three full rebuilds against the project's own
harness (beyond the checks shipped for iteration) surfaced the same 9 failures, byte
for byte identical, every time: `GET /availability` doesn't reject `party_size=0`
even though the same rule is enforced on `POST /reservations`; `POST /_test/reset`
doesn't validate reservation reference format or length; one cross-timezone
double-booking edge case resolves wrong; and the stage-2 availability grid's
`data-available` flag doesn't correctly reflect real capacity or state after a booking.

After the first two rebuilds reproduced the identical set, we added explicit
instructions to both Reviewer and Implementer: that a validation rule the
specification states once for a field must be checked at *every* endpoint accepting
that field, not just the one it was introduced against, and that UI state claiming to
reflect the server must be checked against the real server state after a mutation, not
assumed. The third rebuild reproduced the identical 9 failures again.

We're treating this as a genuine, currently-unresolved limitation of this factory
rather than retrying indefinitely: the same model, given the same specification,
converges on the same blind spot regardless of how the review instructions are worded.
Closing it would likely need either a different verification mechanism (e.g. an
automated cross-reference between every field name in the spec and every endpoint that
accepts it) or a different reviewing model, not another round of prompt wording.
