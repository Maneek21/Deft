# Bounded resource sync catch-up

Background refresh intervals govern polling after a resource stream is caught
up. When a successful metadata or observation page has `has_more: true`, the Host
commits a durable continuation job with the page and checkpoint. That job becomes
eligible after one second and admits the next bounded Run without waiting for
the installation scanner. Queue load and provider work can still add delay.
Each page retains the reviewed item, byte and storage limits.

Admission holds the existing checkpoint lock and rechecks live binding and
observation consent. It requires the latest intent to be the exact successful
predecessor of the current checkpoint generation and sequence, and verifies the
retained output against the applied page digest and opaque cursor. The cursor
alone cannot indicate more work. Missing or expired evidence preserves normal
cadence. Each continuation rechecks current authority and must still match the
checkpoint generation, sequence and preceding Run. A stale job cannot start work
for a replaced checkpoint. The ordinary scanner remains a recovery safety net.

The ordinary attempt queue, lease and idempotency fences remain in force. A
concurrent scan returns the existing Run. Provider errors, uncertain results and
capacity failures do not advance the checkpoint and cannot create a new intent
for that cursor through the catch-up path; existing recovery rules apply.
An unknown outcome is retained for inspection rather than replayed. Each
continuation admits at most one page, then yields to other accounts. A complete
page (`has_more: false`) returns to the reviewed refresh interval even when its
delta cursor is non-null; fast catch-up does not shorten idle polling.

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
