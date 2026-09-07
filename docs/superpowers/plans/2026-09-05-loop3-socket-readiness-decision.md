# Loop 3 socket readiness repair

The controlled 60-user B2 run delivered 10,440 of 10,800 room messages (58 of 60 clients) and the recovery message reached 58 of 60 clients. Notification delivery to user rooms remained exact. Source inspection found that the async connection callback awaits initial room setup and a second session verification before registering `space:join`. The real browser emits that event immediately on connection, matching the test. A focused delayed-initialization reproduction must accompany the fix.

## Scope and options

1. Delaying or retrying joins only in the test would hide a real client race. Rejected.
2. Moving all handlers before initialization would accept events before the established session/room verification boundary unless every handler gained a guard. This is a larger and more error-prone change.
3. Hold incoming packets in the existing per-socket middleware until initialization and handler registration finish. Preserve per-packet session validation, the second post-room-join verification, and generation checks. Release the barrier unsuccessfully on disconnect so pending packets do not wait indefinitely. Preferred, subject to checking Socket.IO dispatch semantics and a focused reproduction.

No protocol, database, dependency, or client retry change is required. The server still scopes room access to current organization/membership. Failed or revoked initialization must never release a join. Successful initialization must not lose an already received join.

Review of the touched path also found that privileged rooms were joined before the second verification completed. Join only the logout control room (`web-session`) early, then verify and check connection/generation before joining data-bearing rooms. Keep the post-join generation check. Per-packet verification must also recheck connection/generation after its await before dispatch. This closes the demonstrated initialization window for the current in-memory adapter; it does not claim atomic room authorization for a future distributed adapter.

Failure/recovery tests cover immediate join during delayed initialization, one room delivery after initialization, and rejection/disconnect during initialization. Then rerun the unchanged 60-client fanout and restart gates on a new frozen candidate. Rollback is the small socket patch; it does not alter persisted data.

## Separate capacity fixture correction

The original capacity room was marked as the default room. Scheduled daily standup legitimately adds Defty there. That changes the room from 60 humans to 61 participants and invalidates the fixture's expected human-only notification counts. Create a separate default room for bootstrap/automation and a non-default certification room containing exactly the 60 declared users. Assert the exact membership before and after load; do not adjust expected counts to accommodate contamination. Preserve the failed run and unchanged timing/fanout thresholds.
