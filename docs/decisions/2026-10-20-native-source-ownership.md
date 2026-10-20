# Native source ownership

Native Knowledge and Calendar own destination policy, retained-copy access and
recurrence projection. Applications nominate evidence through the existing source,
capture and review/commit contracts. Trusted Host storage adapters retain legacy
decoders and key inventories; applications cannot decide key retirement.

The alternatives were per-read application callbacks and bulk payload rewriting.
Callbacks would make retained-copy access depend on runtime availability. Rewriting
payloads or source IDs would make rollback and unknown mappings harder to verify.

Version capture associations within the existing capture-source publication JSON.
Preserve its original publication fields, source IDs and citations. New associations
record the capture digest/time, destination page revision and declared audience.
Legacy associations keep a bounded reader; absence or an unknown mapping is not
permission to invent an audience. Do not create another source registry.

The fresh database initializer verifies a hash-pinned historical catalog before
forward convergence. Adding physical columns would require a separately reviewed
catalog transition. The JSON association provides the required additive version
without weakening that restore gate or altering historical migrations.

Land contracts and adapters before switching callers. Run both recurrence suites,
PostgreSQL audience checks, current-authority races, idempotency and custody refusal
tests before removing a helper. Keep legacy data and the registered storage owner
until backfill, interrupted resume, rollback and restore are independently proven.
No table or key retirement is authorized by this refactor.
