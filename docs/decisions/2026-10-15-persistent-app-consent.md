# Explicit persistent App permission with bounded transport

> Historical decision, October 15, 2026. The October 20–22 releases add
> until-revoked initial setup, compatible trusted-upgrade continuity and scoped
> service reacquisition after technical-session expiry. The finite initial
> enrollment and human-only reissuance statements below describe the original
> slice. Use [Connect once](../app-connect-once.md) and
> [current renewal/recovery](../app-runtime-session-renewal.md) for operation today.

An already connected named account can receive a separately reviewed `consent_lifetime: "until_revoked"` grant with an explicit null consent deadline. The signed owner policy must opt in with `allow_until_revoked: true`. Null or omission without that literal never grants access; existing finite grants and historical canonical payloads retain their original semantics and are not converted by migration. Initial account enrollment remains finite; existing custody is converted only through the authenticated, two-minute consent-continuation review.

Data and background-observation grants use the same explicit lifetime, with a separate five-minute review deadline bound into the review digest. Permission lasts until explicit revocation, disconnect, membership/role change, installation/grant/registration epoch change or custody change. Each use still reconstructs current authority. New policy/version scope requires a new review.

Technical requests, OAuth callbacks, exact-message Send reviews, Run input/result retention, claims and transport leases remain finite. Persistent action and v3 observation channels renew the same still-live credential for at most fifteen minutes at a time, against current named human membership/role and exact installation/account authority; they do not depend on the browser session remaining logged in. Initial issuance still requires an authenticated human. Expired leases are not revived, and uncertain effects are not retried.

Repeated manual finite continuation does not satisfy persistent permission. Invented distant dates, automatic extension of finite human grants, a new credential/principal framework and disabling lifetime guards were rejected. The broader parent Worker permission added for srcdoc remains separately documented; this decision does not change sandbox isolation.

Acceptance requires finite-byte compatibility, explicit-null/mixed-mode denial, finite review and request expiry, persistent permission across clock advancement and original browser-session expiry, current revocation/member/role/custody denial, same-credential bounded renewal, and real PostgreSQL 119→120 preservation. Fixture checks alone do not prove live provider acceptance.
