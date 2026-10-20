# Bounded resource sync catch-up

Background refresh intervals govern polling after a resource stream is caught
up. A successful page with `has_more: true` becomes eligible for another bounded
Run five seconds after settlement. The existing durable scanner admits that Run
on its next pass (normally within one minute, longer under scan backlog).
Each page retains the reviewed item, byte and storage limits.

Admission holds the existing checkpoint lock and rechecks live binding and
observation consent. It requires the latest intent to be the exact successful
predecessor of the current checkpoint generation and sequence, and verifies the
retained output against the applied page digest and opaque cursor. The cursor
alone cannot indicate more work. Missing or expired evidence preserves normal
cadence. No schema migration or app wire-contract change is required; retained
pages from earlier Host versions can immediately use this path.

The ordinary attempt queue, lease and idempotency fences remain in force. A
concurrent scan returns the existing Run. Provider errors, uncertain results and
capacity failures do not advance the checkpoint and cannot create a new intent
for that cursor through the catch-up path; existing recovery rules apply.
No retry loop or new provider call path is introduced. A complete page (`has_more: false`) returns to
the reviewed refresh interval even when its delta cursor is non-null.

The alternative of enqueuing a second per-binding continuation job would duplicate
the existing durable scan and recovery controls. Reusing the scanner provides a
bounded restart-safe continuation with fair scanning and no additional queue or
schema. Moving a page loop into each app would duplicate Host policy and hide
inter-page failure and lease boundaries.

Successful page receipts include signed `has_more` and `coverage` facts alongside
the applied checkpoint sequence and page digest. Here `coverage` describes
catch-up of the declared sync stream, not completeness of unrelated app data.
After a page settles on the updated Host, verify the current checkpoint using:

```sql
SELECT c.resource_binding_id, c.cursor_sequence, c.retained_record_count,
       c.last_applied_at, r.envelope->'facts'->>'coverage' AS coverage
FROM app_sync_checkpoints c
JOIN app_runs run ON run.org_id = c.org_id AND run.id = c.last_applied_run_id
JOIN app_run_receipts r ON r.org_id = c.org_id AND r.run_id = run.id
WHERE c.resource_binding_id = '<binding-uuid>'
  AND c.state = 'active' AND run.state = 'succeeded'
  AND r.receipt_kind = 'attempt_terminal'
  AND r.envelope->'facts'->>'checkpoint_id' = c.id
  AND (r.envelope->'facts'->>'cursor_sequence')::bigint = c.cursor_sequence
  AND r.envelope->'facts'->>'page_digest' = c.last_applied_page_digest;
```

Expect `coverage = complete` once the declared stream has no further pages.
Receipts written before this change have no coverage fact; SQL must not infer
completion from a null field or a non-null cursor.
