# UX walkthrough findings

Run: 2026-04-19T12:46:06.214Z

Env: http://localhost:3000 (dev) / org=maneek@test.com

Automated human-style click-through of Blocks 0–3. Script: `docs/superpowers/audits/ux-walkthrough.ts`.

## Summary

| Severity | Count |
| --- | --- |
| 🛑 Blocker | 0 |
| ⚠️ Major | 7 |
| 🟡 Minor | 4 |
| • Nit | 0 |
| ℹ Note | 2 |

## Majors

- **[1.2 personality]** No link from the agent-employees list to the Personality editor — user has no way to discover it without knowing the URL.

- **[3.2 developer]** No link from the agent-employees list to the Developer credentials page — user has no way to discover it without knowing the URL.

- **[3.1 clone]** POST /:id/clone endpoint exists but no UI affordance — the "Clone agent button" from the plan is missing. User must curl to use it.

- **[3.1 save-as-template]** Save-as-template endpoint shipped but no UI button — wizard step 1 queries the template table so the saved rows would appear there, but user can't save one without an API call.

- **[3.3 webhooks]** agent_webhooks backend ships with full API + HMAC dispatch but no UI — users cannot create/revoke webhooks through the app. Biggest remaining gap for "power users" surface.

- **[1.10 reasoning trace]** ReasoningTrace component ships + hook subscribes to socket events but it is not wired into the chat message UI. Users cannot see tool-call trees until the chat component imports the expander.

- **[console]** 3 JS console errors/page errors during walkthrough.
  - _console.error: Failed to load resource: the server responded with a status of 503 (Service Unavailable) | console.error: Failed to load resource: the server responded with a status of 503 (Service Unavailable) | console.error: Failed to load resource: the server responded with a status of 404 (Not Found)_

## Minors

- **[1.2 save]** Save attempt surfaces "gateway unreachable" as an error banner — correct, but the Save button is not disabled upfront when gateway_unreachable=true, so the user clicks before seeing the warning.

- **[3.2 developer]** No link to documentation or a getting-started guide — raw credentials but no path for a new developer to learn what to do with them.

- **[1.5 clawhub]** After import, no direct "Attach to an agent" CTA — user has to context-switch to the Skills tab and find the new row.

- **[3.8 trace export]** GET /trace.json endpoint ships but no UI button — user has to construct the URL + auth themselves.

## Notes

- **[1.2 personality]** Gateway-unreachable banner renders when no sidecar — correct behavior, but in a dev env with 0 provisioned gateways this is the default experience for every agent, which may be confusing.

- **[2.8 dashboard]** No pending actions in this env — inline approve/reject could not be exercised.
