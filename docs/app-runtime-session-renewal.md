# Opt-in runtime session renewal

Introduced in schema109/Kit alpha.25 and retained in schema117/Kit `0.1.0-alpha.32`: support for technical renewal of a newly issued runtime credential. Existing credentials are unchanged and cannot opt in later. This does not grant an action, create a Run, renew a consent, or retry an effect.

Use an explicitly reviewed future finite deadline; the example is not a default or a promise that the Host will admit that ceiling. The authenticated human issuer accepts either the existing `{}` body or
`{"technical_renewal":{"requested_until":"2026-10-14T03:00:00.000Z"}}`.
The response adds `renewable_until` only for an opted-in session. The Host fixes that ceiling at the earliest of the requested finite deadline, the issuing browser session family's deadline, and the original private target's consent deadline when a private target exists. Missing target authority or an unknown target deadline denies issuance. The access bearer must remain valid through issuance; its short JWT lifetime is not the renewal ceiling.

Store the normal two-field credential with optional enrollment metadata:
`technical_renewal: { expires_at, renewable_until }`. Do not put a browser bearer or refresh credential in the runtime.

`client.renew({expected_expires_at}, signal)` uses the same scoped credential and returns the closed object `{session_id, expires_at, renewable_until}`. The Host checks current membership, original role, original SID, App/version/grant, registration, binding, and original private target before renewal and every dispatch. The session ID, token, epochs and ceiling remain immutable. The technical expiry extends by at most the existing fifteen-minute lifetime and never beyond the original ceiling. Expired or revoked sessions cannot be resurrected. A reduced current authority deadline that precedes the existing expiry denies renewal and dispatch.

An older expected expiry is a lost-acknowledgment or restart reconciliation: after current authority checks, the Host returns its still-live expiry without another extension. A runtime restarting with stale enrollment metadata must block claims until one bounded reconciliation succeeds with the exact session and original ceiling. A denied or uncertain reconciliation leaves that channel dormant; unrelated reads can continue. No renewal can recover an authoritatively expired session. A new human issuance is required then, or after the immutable ceiling ends.

Renew ahead of expiry while preserving the same client for active attempts. Stop new claims when there is insufficient lease time, abort renewal on shutdown, and never treat transport failure as permission to retry an effect. Renewal does not change a Run's retained authority, sequence, attempt deadline or idempotency key.
