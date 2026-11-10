# Apps and Modules: implementation audit and shortest completion path

Reviewed 2026-09-09. Read-only product audit; no implementation, migration, deployment, or PR change.

## Assessment

The work so far is a credible governed extension foundation, worth extending rather than replacing. Modules provide real domain records and native views; Apps add portable packaging, dependencies, reviewed authority, and governed execution. Track A reuses the AppAction/AppRun path instead of introducing another effect executor. The architecture has advanced further than the public authoring and operator experience.

This is not yet a general application platform. B, C, D, and applicable Gate G requirements are substantial remaining work, especially private resources, browser isolation, synchronization recovery, and public transaction semantics. Counting completed phases would overstate readiness: the remaining tracks introduce new trust boundaries, not just additional screens.

## Revision and evidence

- Root checkout is `2d478aee`, predating most Apps implementation. Its existing changes were preserved.
- Audited fetched master `46da535e1c7b85e2f2301faf780237c5241a254b`, extracted into `tmp/app-audit-2026-09-09/current` without switching the user's checkout.
- Published preview.15 is based on `a1aeab4336d5f2005864ca852d17cf82b0eeb9f8`. Subsequent master changes are documentation. [Release](https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.15).
- Fresh local App Kit build and five contract/CLI test files: **34 passed, zero failed/skipped**. The separate packed-external test was not rerun.
- Fresh focused API batch: **47 passed, one failed to connect to the deliberately unreachable test database, zero skipped**. The unavailable case was `module-task-links.test.ts`; this is not evidence of a product regression. Tests included Module query compilation/upload, resource authorization/adapters, automation definitions/scheduling/scanning/dispatch and management pagination. Docker's Linux engine is unavailable, so no local database integration, restore, or browser validation was performed.
- Downloaded and inspected the release API CI log: **1,331 passed, zero failed, 12 skipped**. The Protocol v2 review/automation lifecycle test ran and passed. [API job](https://github.com/Maneek21/Deft/actions/runs/34188124938/job/101940821834).
- Fresh GitHub checks show release-candidate build, typecheck, production-image browser smoke, versioned upgrade and security checks successful. These are CI evidence, not fresh local executions.
- Public npm lookup for `@deft/app-kit@0.1.0-alpha.2` returned E404. Preview.15's release assets contain source and operator artifacts but no standalone App Kit tarball.
- Local logs are under `tmp/app-audit-2026-09-09/`. Final root status preserved prior unrelated modifications; this report is the sole intended new tracked-path artifact.

## What is working well

| Area | Implementation assessment | Boundary |
|---|---|---|
| Modules | Strict manifests, records, typed query compilation, native views, relations, task links, scoped agent access and lifecycle controls form a useful internal-App substrate. | Organization-oriented Module access is not a private mailbox security model. |
| Packaging and authoring | Protocol v0/v1/v2, deterministic packages, strict rejection of unsupported fields, templates and permission reports provide a coherent authoring contract. | Supported artifacts are still Module artifacts; executable experiences are not implemented. |
| Governance | Requested authority is separate from effective grants. Binding/version/resource pins and live authorization sit behind common services. | Public capability vocabulary remains the sandbox-email proof contract. |
| Resource participation | Module and Task adapters delegate to existing owners rather than inventing parallel ACL rules. Search candidates undergo live resolution. | ResourceRef v1 accepts only Module and Task references. |
| Track A | Bounded daily definitions, durable fires, claim fencing and shared Run execution provide meaningful automation. | Not a workflow engine, cron language, campaign delivery product or arbitrary event automation. |
| Lifecycle/recovery | Explicit versions, digests, transactions, retained inputs and receipts give later tracks something substantial to build on. | Historical certificates do not automatically certify changed release candidates. |

Examples of sound implementation decisions: `module-service.ts:229` re-reads manager membership under a transaction row lock; `resource-provider-adapters.ts:173` resolves through the Module owner; `resource-search-service.ts:24` treats search results as candidates; `apps-connected-grants-db.test.ts:1202` exercises scanning, queue delivery, provider effect and receipt creation using production service paths.

The implementation is complex: ModuleService is 4,249 lines, AppActionService 1,730, and live Run authorization 1,433 at this revision. Size alone is not a defect. It does increase the cost of scattered changes. Preserve these common entry points and extract only the seams required by a concrete new consumer; a broad cleanup rewrite would delay the product and reopen proven behavior.

## Findings, ordered by delivery importance

### 1. Current release coverage does not continuously enforce all existing Apps boundaries

**Confirmed evidence gap; high priority before extending the kernel.** The release API log skips live Module/Task owner-authorization, independent Contacts/Campaigns resource composition, App-origin ancestry, four-surface preparation/execution, and several flag-on MCP Run tests. Examples: `resource-provider-adapters-db.test.ts:25` requires a database name matching `phase4.*test`; `app-action-service-db.test.ts:72` and `app-origin-run-cutover-db.test.ts:33` require phase5-style names. Ordinary CI uses `deft_test`.

The dedicated Track A workflow still pins candidate `121aa7c0...` and migration floor preview.26 (`.github/workflows/app-platform-track-a-certification.yml:14`). That is legitimate immutable historical evidence, but rerunning it does not certify preview.15 or future B/C changes.

Recommended closure: retain historical records and add a mandatory current-candidate Apps conformance job with the required disposable database/flag profiles. Fail if mandatory cases skip. Attach its revision, image digest, executed cases and restore evidence to one current ledger. No claim that these skipped behaviors are broken is warranted.

### 2. The public extension contract is narrower than the internal architecture

**Confirmed contract limit; required Gate G work, not an accidental defect.** `packages/app-kit/src/index.ts:520` fixes the private interface to `sandbox_email_send`; the connected input shape is the email proof. `packages/shared/src/resources.ts:95` closes ResourceRef v1 to Module and Task providers. Private mail, blobs and arbitrary community capability verbs cannot be delivered merely by writing a new App manifest.

Recommended closure: introduce additive contracts for the resources/capabilities actually consumed by Email Lite and Booking; retain host-owned classification, validation, grants and revocation. Use a second heterogeneous consumer to justify shared interfaces. Do not weaken the parser into accepting arbitrary verbs or identifiers.

### 3. External author distribution remains unfinished

**Confirmed user-journey friction.** The kit exists and its local authoring tests pass. However, npm returns E404, no standalone kit is attached to preview.15, and the guide starts by packing a matching Deft checkout. An experienced contributor can proceed; a newcomer cannot simply obtain the kit through the expected public package channel.

Recommended closure: publish one matching kit tarball with checksum and version metadata through a public release channel, or publish the package. Provide one short bootstrap guide and run it from a clean directory outside Deft. Do not build a marketplace to solve distribution.

### 4. Track A has improved, but its recovery claim needs a precise current boundary

**Partially closed historical finding.** The new production-path DB test at `apps-connected-grants-db.test.ts:1202` proves duplicate scanner/handler deliveries converge on one provider effect and receipt. It also revokes after Run creation and asserts no provider effect. Its enclosing test passed in release CI. The September 5 statement that the entire scheduled-provider path lacks explicit coverage is therefore stale.

This test calls handlers within its process; duplicate delivery is not itself a killed/restarted-worker experiment. `scripts/selfhost-verify-app-run-restore.ts` verifies one restored receipt; that helper alone is not proof of a newly due automated effect after restoration.

Recommended closure: one current-image scenario that interrupts/restarts the worker around dispatch, distinguishes unknown outcomes from safe retries, then restores DB/keyrings and executes a newly due fire. Reuse existing fixtures and record exact assertions. This audit did not independently execute or locate current-image evidence for that whole scenario.

### 5. Scale and operator usability need bounded acceptance, not speculative redesign

**Static risk, not a reproduced performance failure.** Management now pages and batches queries. Resource search still serially resolves each candidate through an owner adapter that can make multiple reads (`resource-search-service.ts:26`, `resource-provider-adapters.ts:186`). This is a sound authorization pattern, but mail-sized collections may expose latency and query-count costs.

Before specialized sync is declared supported, measure query counts, search latency, queue fairness and recovery backlog at explicit fixture sizes. Optimize with batched owner-authorized resolution if measurements demand it. Keep live ACL checks.

Automation UI now shows eligibility, terminal reasons and Run/receipt inspection. It still does not visibly show the approved validity dates in its row, and public management exposes pause/resume rather than permanent definition revocation. Treat those as focused operator improvements, not justification for a general retry/workflow editor.

## September 5 findings that should not be reopened as new work

- The management 50-row truncation has cursor pagination, a Load-more path and a 101-definition regression fixture.
- Per-definition latest-fire queries were replaced by batched reads.
- Expiry/delivery eligibility, terminal reasons and Run/receipt inspection are present.
- The mobile card `min-w-0` change and ancestor-overflow assertion are already in current source. PR #317 is still open/behind, but its two affected files have no difference against current master. Reconcile the PR administratively; do not implement the same fix again. This audit did not freshly render it.
- Preview.15 is published. The old recommendation to ship the first stabilized preview has been fulfilled.

## Shortest credible route to the final product shape

Use **two independent proof products**, with one evolving through multiple gates: Email Lite for B/C and Booking for D plus the A/D compound proof. Preserve separate plane gates. This adopts the useful direction of the existing unmerged Email Lite proposal; its detailed SDK surface and protocol numbering remain proposals to reconcile, not implemented contracts.

| Step | Minimum deliverable | Exit evidence |
|---|---|---|
| 0. Rebaseline | Current-candidate conformance, reconciled old findings, public kit artifact, exact claim/dependency ledger. | Mandatory existing-boundary tests execute; outside author builds/stages a supported App; current recovery evidence is explicit. |
| 1. Resolve the dangerous unknowns | Hostile static-UI isolation spike and runtime/ownership recovery decision. Compare opaque sandbox origin with cookieless per-App/version origins against actual self-host deployment. | Cookies, storage, egress, parent DOM, revocation and asset delivery have observed outcomes; no speculative manifest contract frozen first. |
| 2. Track B | Isolated Email Lite shell over existing permitted resources; immutable assets and the smallest closed bridge its workflow uses. | Independently packaged UI works at desktop/mobile sizes; hostile content and live revocation pass. No mailbox-sync claim yet. |
| 3. Track C kernel | One operator-registered runtime, explicit App binding, short-lived pull claims, leases, bounded callbacks, cancellation, health and budgets. | Restart, stale callback, compromise/revocation and unknown-outcome tests pass through existing Run identity. |
| 4. Track C resources + consumed G | Provider-authoritative one-way mailbox projection; private ACLs, inherited blob access, cursor/checkpoint/tombstone/freshness and resync rules. | Search/context/citations preserve privacy; deletion, restore/resync and attachments behave correctly; full Email Lite compound proof passes. |
| 5. Track D + consumed G | Booking over Deft-canonical slots first; isolated public principal, bounded durable ingress, idempotent slot claim and outbox. | Double-booking, replay, cookie isolation, rate/payload limits, disable and crash boundaries pass; booking-triggered bounded governed automation proves A+D. |
| 6. Remaining G and final certification | Every remaining promised adapter/security context/lifecycle rule, compatibility policy and current-image operations. | Two independent heterogeneous Apps use public packages without core edits; upgrade/restore/outage/performance gates pass. |

Deft-canonical booking is the smaller first D proof: a database transaction can commit ingress, a unique slot claim and its outbox. External-calendar booking introduces remote confirmation and reconciliation; defer it unless it is essential to the target use case.

Gate G must be a running ledger, not a final cleanup phase. Every row needs its first consumer, contract version, owner, implementation and evidence. Email privacy and blob inheritance precede mailbox use. Public authorization precedes Booking. A final full-workspace claim must still include all promised messages/chat, wiki/notes, files, calendar, people and teams adapters and applicable security contexts—even if the first two Apps do not exercise every one. Two demos alone do not close G.

The main efficiency gain is reusing product fixtures, provider failure controls and the certification harness. Deliver parser, review, enforcement, author guidance and conformance together for each new manifest feature. Once contracts are settled, independent packaging/docs/test-fixture tasks can proceed alongside implementation, but avoid concurrent incompatible edits to shared grants, ResourceRef or Run authority.

Defer marketplace/payments, broad connector catalogs, bidirectional sync, arbitrary workflow DSLs, general compute orchestration, extra proof Apps and a comprehensive bridge API that Email Lite does not consume. Keep preview maintenance separate from platform development; preview.15 already provides a usable feedback baseline.

No new calendar estimate is justified from phase counts or commit throughput. Re-estimate after the isolation spike and the first runtime restore/resync experiment. Those two experiments reduce the largest uncertainties; shortening their feedback loops is more likely to accelerate completion than increasing feature concurrency.

## Recommendation

Continue the existing foundation. First close the current-candidate boundary-test/distribution gaps, then execute Email Lite B → C → compound proof, followed by Booking D → A/D proof and all remaining applicable G requirements. The engineering investment so far is reusable; the next improvement should be a simpler path from outside author to useful installed App, backed by current evidence at each new trust boundary.
