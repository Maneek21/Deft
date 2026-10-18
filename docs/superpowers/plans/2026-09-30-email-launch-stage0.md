# Email launch Stage 0 handoff

Stage 0 is **complete**. The isolated pgvector prerequisite was resolved during Stage 1 using a new loopback-only WSL cluster and fresh/upgrade schema proof. The baseline below is historical Stage 0 evidence; current production foundations and unfinished integrated gates are in the [Stage 1 checkpoint](2026-09-30-email-launch-stage1.md). Provider configuration and the dedicated UI design skill gap remain separately recorded.

The target remains a full everyday multi-account Gmail/Outlook client inside Deft. [Minimum contracts and architecture decisions](../specs/2026-09-30-email-launch-stage0-contracts.md) define the first journey. [Execution ledger](../experiments/email-launch-stage0/ledger.json) records the exact baseline and ownership. The broader execution plan is in the main checkout at `C:/Users/Osheen Pradhan/Documents/Deft Main Repo/docs/superpowers/plans/2026-09-30-email-launch-execution-plan.md`.

## Verified baseline

| Item | Evidence on 30 September 2026 |
| --- | --- |
| Source | `codex/email-wip-example`, HEAD `0c611bb4b1a000e8b4a066f71974137e5c0f31cd`; Email 1.5.5, Kit 0.1.0-alpha.7 |
| Stack | [PR 347](https://github.com/Maneek21/Deft/pull/347) is open/draft, mergeable and clean against `codex/apps-demo-release-prep` at `153614ee373a874bd88e9119c0ec028f03b69ef8`. Remote heads match; that base is the merge-base. No PR checks are reported. This is not a merge or release certification. |
| Independent consumer | `C:/tmp/deft-email-launch-stage0-consumer-20260930`; tracked Email source copied, current Kit packed, pnpm 10.33.1 frozen install successful. No workspace-link/private-host shortcut. |
| Exact Kit tarball | SHA256 `48a6ad355ede34131305def92b13af7db19c1a67ee143605f637c3f793cacc89` |
| Email build | Package digest `sha256:9491a7a69d97f89d4da706cdf1e4199df85f31827ab4314ff782a1bcb92e79e5`; matches the frozen audited candidate |
| Existing example checks | 30 tests passed, build passed, mailbox smoke passed, Activity recovery smoke passed. Smokes use simulations and perform no mail effects. |
| Current host checks | 25 focused human-action/private-Defty/composer tests passed, none skipped. These do not execute database authorization races. |
| Added fixture checks | 12 tests passed, none skipped, against the consumer's actual parser/runtime. Source and consumer fixture files match byte-for-byte. |

The new [synthetic fixture pack](../../../examples/apps/email/fixtures/launch-stage0/README.md) has two Gmail scenarios, Microsoft and IMAP, a three-message Inbox/Sent conversation, Reply-To/Cc/Bcc, an independent same-subject account, changed IMAP locator, benign PDF, hostile HTML, malformed/truncated MIME and interrupted operations. It honestly records current PDF rejection, locator-based IDs, unavailable real adapters and unimplemented rich containment/recovery checks. Synthetic labels and addresses grant no live account access.

## Compatibility and role matrix

This is the implementation target and evidence status, not an advertised supported matrix. No real account configuration was available in this session.

| Path | Launch target | Current evidence / remaining gate |
| --- | --- | --- |
| Gmail consumer and Google Workspace | Gmail API with owner-delegated OAuth; two accounts from the same provider, independent health/revocation and verified send-as identities | Synthetic identities/MIME only; adapter, real accounts, OAuth registration/review and provider outcomes unverified |
| Outlook.com and Microsoft 365 | Microsoft Graph delegated owner mail; correct From, folders and independent refresh/revoke | Synthetic identity/MIME only; adapter and controlled real-account journey unverified |
| Generic IMAP/SMTP | Verified TLS, declared auth/special-folder capabilities, stable logical IDs despite locator changes | Existing runtime and loopback history plus fresh synthetic parser/recovery checks; custom-provider production compatibility unverified |
| Self-hosted deployment | Deployment-owned registered OAuth clients; encrypted host custody and scoped services | Future design target. Current self-hosted v1 contract does not promise managed OAuth or native Gmail. Update promises only with implementation/evidence. |
| Deft-managed/shared OAuth distribution | Separate operational, provider-review and support gate | Not established; do not imply a hosted credential service exists |
| Desktop and mobile web | Deft shell, light/dark, keyboard, 200% zoom, one mobile pane with Back and 44px targets | Tasks/Chat reference images reused; no new UI built/rendered in Stage 0 |
| Shared/delegated mail | Track send-as/on-behalf/shared access as X18; capabilities and roles must remain representable now | Unverified and not advertised. Required before any shared/enterprise replacement claim; does not silently disappear from the full target. |

Request only scopes needed by declared behavior. Gmail read/modify scopes are restricted; Google describes verification/assessment requirements and exceptions. Deployment-owned registration is not automatically an exemption. Permanent deletion and settings must have separate explicit scope/capability decisions. See [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) and [restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification), checked on 30 September 2026.

For Microsoft, delegated `Mail.ReadWrite` does not grant Send; `Mail.Send` is separate. Shared read/write and shared send permissions apply to work/school accounts. Provider permission consent does not replace Deft's current owner/account/action authorization. See [Graph permission reference](https://learn.microsoft.com/en-us/graph/permissions-reference), checked on 30 September 2026. Avoid broad application-wide mailbox permissions for the initial owner-delegated client.

| Actor | Allowed contract |
| --- | --- |
| Account owner | Connect/reconnect/revoke own accounts, consent to private read, direct trusted human Send/Reply and reversible triage with current exact-payload checks |
| Workspace operator/admin | Configure deployment/provider services and inspect bounded diagnostics; workspace administration alone does not disclose private message bodies or grant send-as |
| Scoped sync service | Named account/binding read, sync and file operations; no implicit Send, AI sharing or other-account access |
| Agent/Defty/MCP client | Explicit selected private context and action grants; agent writes follow current deny/ask/review policy; drafts are reviewable before sending |
| Other member/tenant | No access without an explicit supported share/delegation contract; guessed IDs, equal email addresses and forwarded tool instructions grant nothing |

## Ownership and next packets

Two bounded subagents were used: one created only the fixture directory; the other inspected Deft UI/reference/Next contracts read-only. The lead owns this handoff and all shared architecture. No agents concurrently edited schemas, shared authority, lockfiles or UI primitives.

| Lane | Exclusive files / contract | First acceptance check |
| --- | --- | --- |
| Lead, X01/A01 spike | `packages/db/src/schema.ts` and versioned upgrades; host generic account/connection-target and binding authority under `apps/api/src/lib`; corresponding route/contracts/tests | Two synthetic same-provider targets resolve independently; forged owner/account and revoked target fail. DB checks must actually execute. Freeze target mapping before adapter dispatch. |
| Provider, X01/X02 | New provider adapters and logical mail identity/sync under `examples/apps/email`; current `account-config.mjs`, `mail.mjs`, `mailbox-sync.mjs`, `transport-identity.mjs`, `sent-copy.mjs` and focused tests | Four-account fixture matrix, cross-folder/page conversation, locator move, expired cursor and partial-message failure. No shared schema/authority/SDK edits. |
| Lead, X03 | `packages/app-kit/src/runtime-authoring.ts`, `experience-sdk.ts`, `resource-sync-attachments.ts`; host bridge/renderer/composer and generic file/snapshot API/service contracts/tests | Safe document + typed recipient/file + immutable snapshot; payload substitution/revocation/replay denied. Preserve existing scalar v1 and one-click human flow. |
| UI, X04 | `examples/apps/email/worker.mjs`, `worker-ui.test.mjs` against agreed fixture DTOs | Deft-native account/folder/list/detail/composer layouts and declared states. Desktop/mobile rendered evidence; no direct imports of host React components. |
| Lead integration | `examples/apps/email/build.mjs`, package manifest generation and shared host React components under `apps/web/src/components/apps` | Agree required capability/schema with Kit before package changes; preserve independent consumer build. |
| Defect lane, X05 | `draft-controller.mjs`, its tests, `request-journal.mjs` and focused failed-message/subject paths; assign after provider ownership is narrowed | Reproduce each exact defect first. CAS/reopen/terminal-state behavior must not depend on Activity eviction. |

The provider and defect lanes overlap source files today; they must not run concurrently on those files. Start the A01/A02/A03 spikes first, then assign disjoint adapters and fixture-backed UI. Integrate each accepted slice immediately; do not launch the whole X01–X05 backlog as independent agents.

The UI packet reuses `globals.css`, the workspace shell/sidebar, Tasks toolbar/detail, Chat sender/file hierarchy and overlay primitives. References are `screenshots/38-deft-tasks-reference.jpg` and `39-deft-chat-reference.jpg` in the existing audit directory. The UI agent inspected installed Next 16.3.5 documentation and `apps/web/AGENTS.md`. The full Chat RichComposer has commands/mentions/Enter-to-send coupling; reuse appropriate editor pieces through the host. A dedicated UI design skill is absent from the catalog/local roots. This requested workflow requirement remains unmet and is recorded; do not repeat discovery or pretend another skill supplies frontend design.

## Database prerequisite resolved during Stage 1

Docker startup was blocked by its ingest socket; no factory reset or system configuration change was performed. The existing `Deft-CRM-Test` WSL distro has PostgreSQL16/pgvector0.6.0. A new isolated cluster at `/tmp/deft-email-launch-stage1-20260930` listens only on `127.0.0.1:55435` as `gate_g_test`; existing port55440 data was untouched.

The guarded v30 database was created unused and initialized with the historical baseline through `db:assert-fresh` and `db:push-full`, then upgraded through the supported `db:upgrade` runner to preview.57/58. A second unused `gate_g_email_stage1_pdf_fresh_20260930` database passed current fresh-schema creation. Readback on both shows vector0.6.0,56 ledger versions, preview.57/58 once, all4 target columns/triggers and PDF binding/grant guards. The exact18 Stage1 target/PDF/private-state/adoption HTTP checks pass with zero skips; they are separate from the historical67 baseline tests above.

All database URLs were process-local, with the security test URL exactly matching `DEFT_TEST_DATABASE_URL`. `.env` and live application data were untouched. No mail was sent, live permissions changed, PR merged or release published. X00 is closed; X06 still requires unfinished host/onboarding implementation and real accounts.
