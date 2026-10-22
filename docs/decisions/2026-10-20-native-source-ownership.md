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

Capture budget settings accept `knowledge_capture_daily_token_budget` and
`knowledge_capture_account_daily_token_budget`. The storage owner reads retained
setting spellings during rollback. If both spellings are configured, the lower
cap wins. Both use the same physical UTC-day org and app-account reservation
rows; no counter reset, copy or destructive migration accompanies these aliases.

Neutral capture uses an explicitly versioned policy with app-owned eligibility
and v3 body nominations. The schemas and evidence adapter land before activation.
Do not enable new producers until the native audience and dual provenance readers
have switched and their gates pass. Existing producers and saved policies keep
their bounded decoder; they are never silently reinterpreted as the new version.
The deployed Host 127 baseline does not accept the neutral policy version. A later
activation change must declare the upgraded Host minimum before app rollout.

Calendar and dashboard read both stored models through the native Calendar owner.
Unknown versions and mixed models fail closed; ordinary rows without source
metadata remain ordinary. No normalized writer is enabled by this reader switch.
Once new writes are enabled, rollback requires a Host build containing this dual
reader. An older binary that renders only a series master is not a safe rollback
target for normalized recurrence. Keep the retained decoder and data available.
