# Native create replay decision

Scope: native message, task (all three supported create routes), and calendar event creates. Preserve tenant/current-user authorization, distinct intentional equal-content creates, structured validation errors, existing clients, and disabled automatic POST retries.

Current flow validates authorization, inserts a generated-ID record, performs associated work and returns 201. Messages already transact attachments; tasks reserve a number and insert activity separately; events insert directly. No supported request identity currently connects an explicit retry to its committed create. The raw equal-body B1 repro alone cannot distinguish a retry from a deliberate second create.

Options considered:

1. Client-only prevention or content deduplication: small but cannot survive response loss/restart safely and conflates equal-content intentional creates. Rejected.
2. Per-resource request columns: atomic and relatively small, but repeats collision/hash/retention semantics across three tables and loses replay tombstones when events are deleted.
3. A narrow native-create identity table and transaction helper: selected. Store only scoped identity hash, normalized request hash and resource ID, not response bodies. Atomically commit the primary write and identity. Serialize same-key transactions using a transaction advisory lock and enforce uniqueness. Load current authorized resource on replay and return not-found for deleted resources. Existing unkeyed clients remain compatible but cannot receive a replay guarantee.

Interface: optional validated Idempotency-Key header; scope includes organization, user and native operation/resource container. Equal key with changed validated payload returns structured conflict. Keys remain recorded for the organization and actor account's lifetime; deleting the actor or organization removes its identities. Resource deletion alone retains the tombstone. No time-based expiry can silently recreate a deleted result. Administrative restoration must restore the identity table with its matching user/resource data. Fresh schemas and supported upgrades add the same additive table; old code can ignore it, but reverting to old code loses the replay guarantee and must be documented.

The browser must retain the same identity for one unresolved create intent and rotate after success or explicit cancellation/new intent. No generic automatic POST retry is enabled. Persist only request identity/fingerprint in tab-scoped storage, scoped to the authenticated session; never raw draft content or credentials. Existing auth interception must not replay across session changes.

Primary insert, attachment claims/task number/activity and identity share one transaction. Only the first successful create runs existing post-commit notifications/broadcast/dispatch. This prevents replay from duplicating that work; it does not introduce a broad outbox redesign or claim exactly-once delivery of every post-commit action after a crash.

Acceptance before completion: original lost-response browser journey with explicit identity, concurrent same-key requests, conflicting payload, distinct equal creates, tenant/user/revocation denial, deleted result, restart, attachments/activity counts, fresh/upgrade parity and adjacent API auth/Notes behavior. Reviewers must distinguish new keyed-client guarantees from unsupported retroactive deduplication of B1 unkeyed requests.
