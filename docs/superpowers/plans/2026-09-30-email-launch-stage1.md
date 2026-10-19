> Privacy redaction: controlled provider addresses below are reserved synthetic replacements, not original observed provider values. Original source/evidence is preserved privately. Original SHA256: `0934c27d0f9a2be2ec219fbd1ef1be1a1f386bcab7f1211be32ff59bb0d18b63`.

# Email launch Stage 1 checkpoint

Stage 1 remains **in progress**. Email 1.5.9 now has locally verified member-owned
setup, saved-draft/PDF custody, exact one-click confirmation, Runtime release and
a durable one-shot executor. Actual HTTP/PostgreSQL/SDK, native child-process and
mocked Gmail checks pass. **No mailbox is connected in Deft and no live email has
been sent.** Matching demo rollout and the controlled provider journey remain.

The full Gmail/Outlook replacement and all 90 requirements remain on the
[execution plan](C:/Users/Osheen Pradhan/Documents/Deft Main Repo/docs/superpowers/plans/2026-09-30-email-launch-execution-plan.md).
The authorized sender is `controlled.recipient@invalid.example`; the controlled recipient is
`source.sender@invalid.example`. Its separate Gmail connector profile was verified
read-only; it will verify only the exact probe after a real Deft Send.

## Implemented and remaining

| Batch | Status | Current behavior and remaining exit |
| --- | --- | --- |
| X00 baseline | Done | Isolated upgrade/fresh parity through 60; populated demo 56 clone upgraded and rerun locally. Host03 restored DB/uploads and booted, but failed schema identity; final-image and stopped recovery proof remain. |
| X01 accounts/adapters | In progress | Authenticated setup/callback/status/local disconnect and encrypted OAuth custody; reviewed owner opt-in, fixed admin admission, member resource consent and optional action consent. Live configuration, supervised refresh, expired-consent teardown and multi-account proof remain. |
| X02 identity/sync | In progress | Account index/bounded metadata adapters exist; main lazy reader, complete conversations/deletion reconciliation and supervised OAuth sync remain. |
| X03 trusted interactions | In progress | Draft/PDF CAS, immutable MIME, exact confirmation and SDK payload release. Native one-shot CLI/recovery tests pass with fixture providers. Live Send, trusted-parent reply files and broader composition remain. |
| X04 native Deft shell | In progress | Unified settings, shared plain editor, trusted From and file controls. Actual member setup inspected desktop/mobile, including no-session activation into a fresh personal session. Rich reader/recipient controls and broader device/state coverage remain. |
| X05 correctness | Done | Autosave/reopen, subject validation, failed-message isolation and submitted-draft retention repaired. |
| X06 integrated milestone | Not certified | Local HTTP/DB/SDK and provider fixtures pass. Connected sender, exact receipt/Sent, second account, Reply all and broader recovery/revocation proof remain. |

## Candidate and authority

Implementation worktree `C:/tmp/deft-gate-g-integration-20260924`, branch
`codex/email-wip-example`, base HEAD
`0c611bb4b1a000e8b4a066f71974137e5c0f31cd`, plus uncommitted Stage 0/1 work.
Pre-existing `apps/web/next-env.d.ts` and unrelated main-checkout changes remain.
No commit, push, host cutover, live schema upgrade or publication occurred.

Email 1.5.9's first Send is one plain-text new message to one recipient, trusted
From, one PDF≤2MiB and MIME≤4MiB. Upload/removal atomically changes the saved draft
revision. Host-resolved immutable MIME/file bytes and the displayed snapshot
digest bind prepare/confirm and the exact Run; later edits cannot substitute them.
Old workers without the payload handshake fail before provider start.
[Outgoing custody](../specs/2026-09-30-email-stage1-outgoing-custody.md) remains
generic host storage; Email semantics stay in the governed module.

Runtime release checks current exact owner/tenant/target/Run/attempt/claim and
conservative deadlines around I/O and commit. The encrypted POSIX operation
journal retains accepted/unknown outcomes and prevents blind resend. The
65-edit regression retires superseded unconfirmed previews while preserving
current and confirmed MIME/PDF. Identity tombstone pruning remains future work;
the 4096-identifier bound can eventually deny new storage.

Member setup is default-off and requires Protocol 7 `owner_connections`, the
attachment-broker conjunction, immutable admin admission/fixed operator, current
membership and exact owner resource consent. Actions are separately optional;
the browser cannot nominate owner, organization or operator. Legacy setup keeps
its manager gate. Status/local disconnect are independent of Send authority but
still require live source consent; expiry-only teardown remains missing.
The private provider registry must be configured manually for each new exact
owner/target/binding; no automatic adapter provisioning is claimed.
[Owner connection decision](../specs/2026-09-30-email-stage1-owner-connection.md)
records these boundaries.

## Current focused evidence

Counts overlap and are **not additive**. Older milestone passes remain historical
in the ledger; no190-test suite rerun was performed for this slice.

| Check | Result and limit |
| --- | --- |
| Owner contract/member HTTP |12 passed: 5 contracts and 7 HTTP parent/nested tests;0 failures/skips, real isolated PostgreSQL. |
| API TypeScript/compatibility | `tsc --noEmit` exit0; scalar Runtime 1 and legacy Sync consent 3 pass. |
| Kit |14 focused tests pass; TypeScript/pack exit0. |
| Native Email CLI |3 tests pass with actual SDK, native child process, loopback host and fixture provider; no deployed host/provider journey. |
| Recipient/builder/milestone |20 exact-recipient tests and4 builder/joined tests pass against bounded provider fixtures. No real receipt claim. |
| Web |13 app normalizer tests and7 owner/connection tests pass; final web TypeScript exit0. New four-file lint0 errors/warnings; installed component0 errors/6 existing hook warnings. |
| Member UI |8 inspected captures:2 final fresh-reload desktop/mobile and6 historical source-uncertain captures. Actual InstalledAppExperience enters owner setup without a session, activates one own resource, optionally selects actions and opens a fresh personal session; lost acknowledgement recovers without a second activation. APIs/authentication are synthetic. |
| Database | Supported60 upgrade and fresh push-full pass. Owner-admission parity:17 columns,11 constraints,3 indexes,7 guard functions,2 triggers and ledger 60. Earlier four-table custody parity is historical. |
| Demo56 rehearsal | Protected live logical backup restored locally; supported 57–60 dry-run/apply/rerun exit 0, zero pending. Host03 restored 37 uploads and booted its actual API/Next entrypoint; health/ready returned 200 and doctor passed 8 checks, but health incorrectly reported schema 56 against ledger 60. This is a failed final-image identity check and not a stopped recovery point. |
| Schema guard | Existing release-source-identity test passes after the source constant was corrected to 60. A network-none negative fixture confirms the new packaged-schema guard rejects host03. The next candidate still requires actual health/ready verification. |

Consumer `C:/tmp/deft-email-launch-stage0-consumer-20260930`, Node 24.14.0,
pnpm 10.33.1; frozen install/build exit0. Packed Kit 0.1.0-alpha.9 SHA256:
`1016b89e14d5386de8e0663446e42c011b18bf32130e089cd01aebe97d28ce0a`.
Email 1.5.9 package:
`sha256:7a43017d2c2ad41e8028a90ee0e2c43d910f80520c35aabb51ffa49afc070b03`.
Worker artifact remains
`sha256:dd23d0242f6f2948d329c66eab5078c40504a8d2170ab673a7f1478449fe90ef`.
Separate read-only 1.5.7-indexed.1 package remains
`sha256:334106d7bdad1b1c0a3ccd24c52dc9afdbecbc60d46a29c96012b0b45228675b`.
The audit source manifest records exact 97-public-file consumer parity.

Current member UI identity is in `stage1/member-setup-ui-evidence.json`.
Earlier `production-send-ui-evidence.json` and its one mocked Send at revision7
retain their original hashes as historical evidence. Invalid mobile pending/
conflict images remain excluded. Native file picker,200% browser coverage,
complete live-device matrix and provider delivery remain unverified. Tasks/Chat
and shared Deft primitives were reused; no dedicated design skill was installed.

## Demo preparation and remaining gates

Demo remains release0.3.0-preview.16/schema 56 with seeded Email and the historical
fixture supervisor, not a Gmail1.5.9 runtime. Google Gmail API is enabled; the
Testing client has only the authorized sender test user and exact callback.
After an unused client secret appeared in a tool result, that client was deleted
and replaced. The replacement secret was privately stored with 0600/0700 custody,
byte-verified and removed locally; no secret is in source/audit. The client is
privately prepared, but provider registry/host deployment, mailbox consent and
Send remain unconfigured/unexecuted.

[Candidate preparation](../experiments/2026-09-30-email-demo-candidate.md)
records local artifacts, disk budget and rollback. Provisional image01 passes
build/offline imports but cannot upgrade this deployed history: its LF historical
SQL differs from applied CRLF checksums. A read-only export verified all 53
applied SQL files; 33 exact deployment-byte overrides are identified in corrected
source02 and its source offer. Working-tree SQL/ledger were never rewritten or
checks waived. That source certified the populated56→60 local DB rehearsal.
Host03 built with that explicit baseline and passed offline imports/checksums.
Its actual restored-host rehearsal exposed a hardcoded health schema 56 against
ledger 60, so it must not be deployed. The source constant is corrected; host04
is the next frozen build and actual health-identity gate. Reviewed Email 1.5.9
activation also returned `APP_UPGRADE_BLOCKED` for one historical unknown inbox
sync Run. A narrow reviewed administrative closure is being implemented; it
must preserve unknown/no-retry evidence rather than assert a provider outcome.
Runtime bundle03 has 48 exact package versions/66 dependency links; an offline
import check caught and fixed a missing peer link. Matching final host bytes,
source offer and deployment configuration still require review.

Root relocated exactly six old archives after verifying protected off-host
copies of all 1,485,162,767 bytes. No image, volume or broad prune was performed;
the fresh free-space observation is 4,169,437,184 bytes. This does not certify
final-image load capacity. The provisional
streamed-load admission budget is4,138,341,398 bytes before backup working files;
recheck the final image and storage-driver peak. Other live workloads must remain.
Protected read-only off-host backup and DB rehearsal are complete; take a fresh
stopped app/external-writer recovery point before cutover. Full rollback restores
schema 56 plus exact prior image/configuration/keyrings/uploads/old email-state
into a clean isolated project. Do not run the old image against a newer ledger
or repeat unknown provider effects.

Runtime03 is mounted read-only in a staged root-owned candidate overlay with an
empty private registry, read-only configuration and writable custody. Compose
preflight passed without build/pull or public Postgres ports. A private capture
wrapper and synthetic PDF are prepared; no executor/provider action ran. These
staging actions have not switched the live host or connected a mailbox.

Next: finish the matching image/capacity/stopped-recovery gates, configure the
governed module and controlled one-shot executor, connect the sender in Deft,
send the exact authorized PDF probe once and verify recipient bytes/Sent. Then
complete the second-account/full X06 journey and the unchanged replacement plan.
Stage 1 and the full app are not complete.
