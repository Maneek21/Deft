# Deft core capability quality assessment

Reviewed October 3, 2026. This audit evaluates the shared capabilities needed beneath Chat, Tasks, Calendar, Knowledge and Dashboard: attention, search, identity, agent governance, files, references, activity history and app lifecycle. It also spot-checks Projects, Calendar, Knowledge and Dashboard where their behavior reveals shared-system weaknesses. It is not an exhaustive review of every primary product screen.

Deft already has substantial implementations of these capabilities. The main weakness is inconsistent enforcement across the different ways users and agents reach the same resource. Strong access checks on a primary route do not consistently extend to Inbox snapshots, audit history, older task routes, search and attachments. Product completeness also varies: references and governed actions have considerable depth, whereas app removal, calendar scheduling breadth and failure recovery remain incomplete.

Recommendation: retain the existing systems and prioritize shared authorization and lifecycle consistency. The evidence does not justify rebuilding the core. It does justify a hardening milestone before presenting these services as a dependable foundation for arbitrary installed apps.

## Baseline and confidence

The primary source is GitHub master `b567af6ff12e5e4c61dbc54eddde17a81b986a28`. Native mentions PR 352 merged on October 2. Local checkout `C:/Users/Osheen Pradhan/.codex/worktrees/native-mentions/Deft Main Repo`, HEAD `a0cd499d`, has an identical source tree to that master SHA and was clean before and after the review. The main workspace remains an older dirty checkout; its application code was not used as the current baseline.

The Platform/Email candidate at `C:/tmp/deft-gate-g-integration-20260924` was considered separately. Its unmerged experience, runtime and synchronization work is not counted as current-master completeness. The published preview.15 remains a September 8 prerelease; current master, the published image and the evolving demo are different artifacts.

Three GPT-6.1 Sol agents inspected attention/search/references, identity/governance, and files/apps. The lead checked key source paths, examined product integration, ran consolidated focused tests and reviewed fresh GitHub evidence. Recent Universal Tagging and Fast Inbox chats were inspected to separate merged functionality from planned improvements. No other chat was directed or paused.

Evidence labels used below:

- **Reproduced:** actual route executed with controlled in-memory storage; not a live database or production exploit.
- **Source-confirmed:** the relevant producer, consumer and authorization/lifecycle path were inspected; a database regression still needs to be run.
- **Scope gap:** a capability is absent, constrained or explicitly deferred; not necessarily an implementation bug.
- **Risk:** a credible failure mode whose triggering conditions were not exercised.

No fresh browser usability, screen-reader, production load, database concurrency, external runtime or backup-restore certification was performed. Ratings describe implementation maturity and observed risks, not measured user satisfaction or production readiness.

## Capability assessment

| Capability | What is good already | Main limitation | Assessment |
| --- | --- | --- | --- |
| Inbox and attention | Durable states, snoozing, feedback, event records, approval expiry, stable cursor pagination and realtime refresh | Older task attention does not recheck current task visibility/deletion; planned fast-triage improvements are not implemented | Usable and substantial, with an important privacy/lifecycle gap |
| Search and navigation | Membership-aware results, task visibility, grouped results and protection against stale search responses | Deleted-project tasks remain searchable; knowledge branch errors appear as empty results; ranking quality unmeasured | Useful scoped search, incomplete failure and lifecycle handling |
| Identity and sharing | Persisted sessions, live membership and roles, refresh-replay revocation, password/session coordination | Re-inviting existing offboarded accounts has inconsistent activation/acceptance/revocation semantics | Strong foundation requiring lifecycle repair |
| Agent participation and approvals | Credential-bound employee identity, explicit human MCP distinction, live reviewer checks, atomic approval claims and trust policy | Outcome/receipt durability is incomplete; older employee scope semantics need clarification | One of the deeper systems, with operational reliability limits |
| Files and attachments | Authenticated downloads, target access checks, bounded extraction, safe local paths and staged cleanup | Web/MCP access differs after project deletion; upload size enforcement comes after body parsing; cleanup failures can lose retry information | Credible attachment subsystem, incomplete operational hardening |
| References and provenance | Authorized cross-links, current previews, typed native mentions and passive employee attention | Native mentions are opt-in; source-deletion retention policy needs consistency; generic app participation remains incomplete | Strong within supported native scope |
| Audit and action history | Structured mutation events, signed receipts and useful attribution | General audit browsing bypasses resource privacy; recording failures are swallowed | Valuable implementation with a high-priority access defect |
| App lifecycle | Deterministic packages, zero-authority staging, reviewed grants, upgrade pins and disable/re-enable controls | Destructive uninstall/export-retention workflow unfinished; rich general platform remains a separate candidate | Strong governance, unfinished end-to-end product |

## Inbox and attention

The active Inbox already uses the durable attention model. It is not simply a list of notifications. It has status transitions, snoozing, feedback, retained events and separate approval behavior. The current route uses a time-and-ID cursor, which avoids the ambiguity of timestamp-only pagination. The UI uses incremental loading and socket-driven refresh. [Attention route](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/routes/attention.ts#L31)

The important defect is retained task content. `visibleAttentionCondition` automatically admits source types outside message, space, agent action and native mention. Task assignment/update/blocker attention uses the omitted task source type. The secondary item filter also omits task authorization. A previously delivered title/body can therefore remain in Inbox after task access is removed or the task is deleted. Recipient ownership of the notification is not sufficient authority to keep reading its source content. **Source-confirmed.** [Visibility condition](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/lib/attention.ts#L60)

The newer native-mention path is stronger: it resolves current source visibility and binds employee acknowledgement to an authenticated employee and write scope. Extend that consistency to older attention types rather than inventing another inbox store.

The retained legacy `/api/inbox` route has weaker pagination: its cursor narrows notifications but repeatedly includes the newest DM and approval rows. This is a compatibility defect, not evidence that the active attention UI has that pagination bug. The Fast Inbox chat contains a plan for improved triage; its keyboard and workflow proposals should not be counted as delivered.

## Search and references

Search applies task visibility, message membership and note visibility. The command palette protects against out-of-order requests and can explain overall or module-specific failures. These are meaningful correctness measures, not just visual polish.

Two gaps remain. Task search joins Projects without excluding soft-deleted projects, while project deletion preserves task rows. Search can consequently return tasks whose project has been removed from ordinary navigation. Separately, Knowledge retrieval exceptions are converted into an empty result array, so a failed retrieval looks like no matching knowledge. **Both source-confirmed.** [Task search](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/routes/search.ts#L45), [knowledge retrieval](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/routes/search.ts#L152)

Cross-references are comparatively well designed: they authorize both the requested resource and linked sources, exclude deleted task/project records, avoid returning historical denormalized context and derive previews from current authorized sources. [Cross-reference routes](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/routes/cross-references.ts#L32)

Native mentions now cover the supported Chat, Tasks and Knowledge paths, but require `DEFT_NATIVE_MENTIONS_ENABLED=true`; merged does not mean enabled on every deployment. App-owned arbitrary resources are not yet covered by a complete shared contribution contract. Wiki citations also need an explicit policy for excerpts after source-message deletion: membership is rechecked, but retaining an excerpt is a separate content-retention decision.

No relevance benchmark was run. This review supports “useful authorized discovery,” not “excellent search relevance at scale.”

## Identity and sharing

Request authentication rechecks persisted sessions and current active organization membership, with roles sourced from the database. Refresh replay revokes the session family. Password changes coordinate with session issuance and revoke existing sessions. These are substantial protections against stale authority. [Web sessions](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/lib/web-sessions.ts#L44)

The clearest membership problem is the existing-account re-invite path. Generating an invite immediately reactivates an offboarded membership. An existing password makes invite acceptance report already accepted, while deleting the pending invite only deactivates accounts without a password. An administrator can therefore revoke the pending invitation while the previously offboarded account remains active. **Source-confirmed lifecycle inconsistency; no live account was tested.** [Reactivation](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/routes/members.ts#L1118), [acceptance](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/routes/invites.ts#L142), [revocation](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/routes/members.ts#L1300)

This needs a clear distinction between restoring access and issuing a pending invitation, followed by a complete revoke test. It does not require replacing authentication.

Authorization helpers also coexist with older routes that implement different rules. For example, `/api/tasks/project/:projectId` verifies project organization but does not apply the shared restricted-task visibility predicate to its task list. Historical watchers themselves count as an access relationship in that predicate. These paths deserve focused regression tests before private-task guarantees are expanded. [Legacy task list](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/routes/tasks.ts#L1665), [task visibility](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/lib/task-visibility.ts#L12)

## Agent governance and audit history

Personal MCP and employee MCP have materially different authority models. Personal clients act as their authorizing human. Employee identity is bound to credentials, and employee access to private conversations requires explicit membership. Approval resolution rechecks reviewer membership, requester/admin policy, employee status and tool availability before claiming the pending action. App/module paths add live authorization checks. Preserve these systems. [Approval resolver](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/lib/agent-approval-resolver.ts#L863)

The highest-priority defect in this audit is general audit visibility. The audit route restricts general rows by organization and excludes module rows, but it does not authorize the underlying message or space before returning raw states. Agent message creation stores message text and space name in those rows. An ordinary same-organization member can consequently read content through the audit route that requires space membership through the normal message route. **Reproduced with the actual Hono route and in-memory query results; not a live database exploit.** [Audit read](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/routes/audit.ts#L58), [content recorded](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/lib/agent-actions.ts#L2254)

Module audit already uses a targeted access check and a restricted projection. That provides a useful local pattern, though each native resource still needs its own correct authorization.

Receipts have signatures, sanitized parameters, result hashes and serialized generation. However, receipt and audit insertion failures are caught after effects and do not reliably produce durable recovery work. The accurate claim is signed evidence when recorded, not guaranteed evidence for every completed effect. Some older automatic execution paths record executed state before the operation completes. **Source-confirmed reliability limitation, already recognized in the earlier remediation plan.** [Receipt recording](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/lib/receipts.ts#L174), [audit recording](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/lib/audit.ts#L15)

An additional contract question remains: employee credentials expose resource scopes, but older native tool handlers do not visibly apply them as uniformly as newer native-mention/App tools. Clarify and test intended compatibility semantics before describing every resource scope as a consistently enforced restriction. This audit does not claim a reproduced scope escalation.

## Files and attachments

Files have real protections: authenticated organization-scoped download, current target checks, uploader-only access while unattached, fail-closed handling of multiple targets, safe filesystem paths, attachment disposition, `nosniff` and private/no-store responses. Processing fingerprints content, rejects several unsafe formats and bounds extracted text. This is a useful attachment subsystem.

Three concrete hardening needs remain:

1. Human task-attachment access omits the deleted-project check that MCP includes. Soft-deleting a project leaves retained task attachments accessible through one path and denied through the other. **Source-confirmed.** [Human access](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/lib/attachment-access.ts#L36)
2. Upload parses the multipart body before checking the 50 MB file limit. No earlier application request-size limit was found; rate limiting only bounds request counts. Oversized requests can consume parsing memory before rejection. **Source-confirmed ordering; no load test.** [Upload](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/routes/upload.ts#L23)
3. Deletion removes database rows before storage bytes. Failed storage deletion returns a pending indication without durable retry work. The retention worker also discards returned orphan identifiers after logging their count. **Recovery risk; storage failure not injected.** [Deletion](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/routes/upload.ts#L134), [retention](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/lib/attachment-retention.ts#L37)

The audited native implementation uses local storage. Documentation mentioning R2 does not establish a working R2 backend; no corresponding native implementation was found. Backup guidance appropriately requires database, uploads and configuration together, but no restore rehearsal was performed here. A full Drive product, indexing every file format and general app-private file custody are separate capabilities.

## App installation and lifecycle

The governance is stronger than a basic plugin loader. Staging grants no execution authority. Activation pins packages and review decisions, rechecks manager access, uses transactions and tracks lifecycle/grant epochs. Disable revokes connected grants; connected re-enable requires fresh review. Upgrades and dependencies have explicit constraints. These are worth preserving. [App service](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/lib/app-service.ts#L373)

The lifecycle is nonetheless unfinished. Uninstall deliberately refuses until an export and retention decision exists. This is safer than deleting data, but it means an operator cannot yet complete the full install-to-removal journey. [Uninstall refusal](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/lib/app-service.ts#L593)

The development candidate contains substantial additional runtime, Experience and synchronization work. It must be consolidated and certified against an exact host/Kit/schema combination before its features become part of the public completeness claim. This remains consistent with the general app-platform plan; the core audit adds concrete prerequisites around shared access, deletion and evidence durability.

## Product integration spot checks

**Projects and Tasks:** Projects already provide identity, prefixes, task grouping, archive/delete/restore and configurable presentation. Tasks have multiple views, assignments, relationships, comments and history. The issue is authorization parity across those views and APIs, not missing basic project infrastructure. A project is not yet evidence of a universal container for all app resources.

**Calendar:** Native event editing, personal calendar views, ICS subscriptions and time-zone helpers exist. The current native API stores attendee metadata; that is not a complete invitation/RSVP lifecycle. ICS parsing deliberately keeps one base event rather than expanding recurrence, and synchronization upserts feed items without reconciling items removed from the feed. Those are material limits for a scheduling product. [ICS parsing](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/lib/ics.ts#L28), [sync](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/workers/handlers/ics-sync.ts#L60)

An isolated probe of the actual event PATCH route accepted an end before start with HTTP 200 and attempted to persist the invalid range. A malformed start produced a RangeError and HTTP 500 instead of a validation response. Create validates these cases; update does not. **Reproduced with in-memory storage.** [Event update](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/routes/events.ts#L94)

Keeping Calendar core is a product decision, not a statement that it is already a mature scheduling system. Its reliability and supported recurrence/invitation contract need an explicit delivery scope.

**Knowledge:** Scope-aware pages, citations, graph links, history and export provide substantial functionality. The current UI has guards against stale detail/save responses, so older findings about that behavior should not be repeated unchanged after the mentions merge. However, backend edits snapshot a version and then update by page ID without an expected-version condition. Concurrent edits can overwrite each other; the version snapshot conflict is ignored. **Source-confirmed lost-update risk; concurrency not reproduced.** [Wiki update](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/routes/wiki.ts#L983)

**Dashboard:** It aggregates genuine work and agent information, but the facade converts many failures to null or empty arrays, making unavailable data difficult to distinguish from nothing needing attention. Its shared provider fetches core data on mount without a general refresh subscription. The core endpoint computes today from server-local midnight while other date logic uses organization/user time zones. These are consistency risks for a trusted daily overview. Widgets are statically registered; installed-app contributions remain future platform work. [Facade](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/web/src/app/%28app%29/dashboard/lib/facade.ts#L151), [day boundaries](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/routes/dashboard.ts#L17)

## Recommended priorities

| Order | Work | Completion evidence |
| --- | --- | --- |
| 1 Access and membership correctness | Resource-authorized audit projections; task attention reauthorization; consistent deleted-project behavior; repair re-invite lifecycle and older task-list access | The same denied actor receives no content through detail, list, search, Inbox, audit, attachment and MCP paths; pending re-invite revocation demonstrably removes the restored access |
| 2 Durable outcomes and recovery | Align completed effects, action status and receipts; retain storage cleanup jobs; add revision checks for wiki writes | Inject failures between effect/status/receipt recording and row/blob deletion; recovery neither loses work nor duplicates effects; stale wiki writes return a conflict |
| 3 Truthful daily experience | Calendar PATCH validation, declared recurrence/deletion behavior, Dashboard refresh/time-zone/error handling, Knowledge search diagnostics | Invalid updates rejected; fixture recurrence and feed removal behave as documented; unavailable data cannot masquerade as an empty day or empty search |
| 4 Platform completeness | Reuse corrected source authorization for app contributions; complete export/retention/removal; certify the candidate | An outside-built app participates through supported interfaces and completes install, update, disable, export and removal without core patches |

Apply fixes in shared owner services where possible and retire or align duplicate compatibility routes. Do not introduce a second identity system, inbox, resource registry or receipt store to work around inconsistent callers.

## Verification and limits

The lead executed **113 focused tests, all passing, with no skips**, covering task permissions/status and date helpers, calendar form helpers, Inbox wiring/view models, module search diagnostics, attachment processing/local storage, module upload validation, grant staging, approval policy and untrusted MCP descriptions. These are unit, source-wiring and local filesystem checks; they do not establish database or browser correctness.

Fresh GitHub inspection confirmed successful current-master [CI](https://github.com/Maneek21/Deft/actions/runs/37026892933) and [Security](https://github.com/Maneek21/Deft/actions/runs/37026893282). CI includes Type Check, Test API, Build, Production Image and Browser Smoke, and Versioned Upgrade. Hermes Employee Release Gate is explicitly skipped. Green checks are evidence for their tested scenarios, not disproof of uncovered paths above.

Two additional controlled probes exercised actual route code with in-memory storage: calendar update validation and general audit visibility. Runnable audit artifacts are under `C:/tmp/deft-core-quality-audit-20261003`. No configured database, existing account, provider connection or deployed workspace was mutated.

Reproduction commands for the 113 focused tests:

```text
# From the clean current-master-equivalent checkout
node --import tsx --test apps/web/src/lib/calendar-event-form.test.ts apps/web/src/lib/calendar-members.test.ts apps/web/src/components/task-calendar-helpers.test.ts apps/api/test/task-permissions.test.ts apps/api/test/task-dates.test.ts

# From its apps/api directory
pnpm exec tsx --test test/inbox-redirect.test.ts ../web/src/lib/inbox-view-model.test.ts ../web/src/lib/module-search-notice.test.ts test/attachment-processor.test.ts test/file-store.test.ts test/module-manifest-upload.test.ts test/app-grant-service.test.ts test/mcp-tool-trust-boundary.test.ts test/agent-approval-matrix.test.ts
```

This audit changes only this report in the main workspace and saves controlled probes outside the repository. Existing work is preserved. The findings are recommendations for subsequent implementation, not claims that the defects have been fixed.
