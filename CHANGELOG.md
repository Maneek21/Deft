# Changelog

All notable changes to Deft are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and during the pre-1.0 alpha phase the project uses a loose interpretation of
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) — minor versions
(`0.X.0`) may include breaking changes to schema, API contracts, or required
env vars. Patch versions (`0.X.Y`) are non-breaking fixes only.

## [Unreleased]

### Notice: Kit `0.1.0-alpha.44` removes deprecated Email compatibility

Not before 2026-11-25, and never fewer than 14 days after this notice merged.
No code changes here and alpha.43 is unchanged. Alpha.44 is the "next breaking Kit
alpha" the existing `@deprecated` notices name. It removes the 26 deprecated
compose, address-list and raster names from the root and `/experience` entry
points, the 9 sandbox names re-exported from the root, the root override of
`checkDeftAppDeveloperContract`, and the `safe-compose-html`, `mailbox-list` and
`native-compose-raster` modules under `@deft/app-kit/examples/email`. Importing only
the root will no longer register the sandbox profile; the `sandbox`, `templates`,
`register` and `cli` modules and the three `examples/email` subpath exports stay,
opt-in. Use `@deft/app-kit/core` and the `deft-email` `runtime/domain` modules, or
keep pinning alpha.43. Names and plan are listed in the Kit README and
`docs/superpowers/plans/2026-11-06-email-host-kit-shrink.md`.

- App-boundary gate: `scripts/app-boundary-ceiling.json` caps the exception count
  at 1,277 (it may only be lowered), each exception's `milestone` now starts with
  its burn-down bucket, and `node scripts/check-app-boundary.mjs --summary` prints
  the counts per milestone. No finding changed.

### Unreleased: merged to `master` after `v0.3.0-preview.141`

Agents and approvals:

- No trust level auto-runs a call classed as destructive. Conservative and
  Standard now queue those calls for approval, as Autonomous already did. This
  includes connected (MCP) tools named like an admin tool or `delete_*`, and
  `module_record_task_unlink`.
- One set of guard rails covers every path on which an agent employee posts a
  chat message as itself: MCP `send_message` and `message_post`, the Agent
  Channel reply and the legacy `deft_post_message` call. The employee must be
  active; the reply-storm detector applies to thread replies; an unhealthy
  (circuit breaker) employee does not post on its own, and an unhealthy
  Autonomous employee falls back to the approval queue; the daily action cap is
  charged once per executed post. The Agent Channel refuses with `409`
  (`EMPLOYEE_UNHEALTHY`, `STORM_DETECTED` or `DAILY_ACTION_LIMIT`) before any
  delivery is attempted.
- A thread reply must name a parent message in the target space.
- Only the requester of an action, or an owner or admin who can still see its
  target, can undo it. The action lists, receipts, dashboard activity and inbox show a Defty action only to its requester, an assigned approver and owners and admins; guests see only their own.
- Native writes (wiki, canvas, knowledge, thread reply, space notes, posting a
  message) check wiki visibility or space membership when they run.
- A connected tool that declares itself destructive always needs approval, and
  destructive tool names are matched regardless of case. `remove_dependency` is
  classed destructive. A destructive action held for approval is stored at the
  full tier, so it shows in pending approvals and the inbox.
- Each step of a Defty plan carries a server-computed destructive flag, and a
  destructive step needs its own approval when the plan runs.
- Defty posts exactly one reply per trigger message, and a cancelled or
  lease-lost reply job does not publish. A database wait timeout retries the
  reply instead of publishing a fallback.
- Messages posted through the human MCP tools (`message_post`, `send_message`)
  wake Defty under the same conditions as the web app, and their @mentions are
  normalised the same way. A thread-follow wake is saved with the message.
- Forwarding a deleted message is refused.
- A retried meeting-prep run does not notify twice. A new socket for an idle user
  broadcasts that user as online.
- Chat (web): Enter sends after Escape closes the @ or # popup. A failed history,
  thread or approval read shows an error with Retry. After a reconnect a channel
  catches up through at most 500 messages before offering a "Load earlier
  messages" control, and an open thread rereads and merges its replies. "Ask Defty" reports a failure instead of doing
  nothing. Presence snapshots replace the online list. Members see an employee's
  trust level read-only; owners and admins can lower it.
- Apps developer preview: the runtime authority check for a resource observation
  is decided in one transaction.
- Docs: the Apps flags section of `docs/self-hosting.md` documents flag
  dependencies and the developer preview profile.

Workspace isolation:

- Realtime rooms and presence are per workspace. A person who belongs to two
  workspaces shows as online only in the workspace where their session is
  connected, and per-user events reach only that workspace's sockets.
- Note folders, note shares and space actions check the caller's current
  workspace. Note shares are limited to active members of the workspace. Guests
  no longer receive the workspace standup, recent activity follows task
  visibility, and the unread notification count is per workspace.

Operator tooling:

- New read-only script `apps/api/src/scripts/audit-mixed-org-rows.ts` lists rows
  whose workspace differs from the workspace of the row they belong to. It never
  writes. See "Checking For Rows Stamped With The Wrong Org" in
  `docs/self-hosting.md`.

## [0.3.0-preview.141] — 2026-11-10 (prerelease)

Agents and chat:

- An agent employee's own chat messages (MCP `send_message` to a space, thread
  or DM, and `message_post`) post without approval at every trust level, within
  the guard rails of space membership and visibility and the daily action cap;
  `message_post` thread replies pass the reply-storm detector. Everything else an employee
  writes follows that employee's trust level. Defty's chat writes always wait for
  approval; the workspace trust level applies to Defty's approved plans and
  background work. A direct message from an employee needs an active workspace
  member as its target.
- Defty answers reads with the asker's visibility: wiki pages, decision lists,
  canvases, notes and conversation memory follow what the asker may read.
- Chat is the only agent-conversation surface. The older endpoints for posting,
  continuing, renaming and deleting a conversation
  (`/api/agent/conversations/:id/...`) answer `410 ENDPOINT_RETIRED`; the list,
  detail, history and trace export endpoints remain and are limited to
  conversations the caller belongs to. Changing the workspace trust setting
  requires an active owner or admin.
- The trust-level and AI settings pages show only what the server confirmed,
  report failed saves, and state that chat requests to Defty always wait for
  approval.
- A message that wakes Defty or a BYOA agent employee is committed together with
  the job that wakes it; if the job cannot be queued the request fails and can be
  retried safely.
- The daily standup uses only unrestricted tasks in live projects, is delivered
  to its own space, and cannot be triggered by guests. Passive knowledge capture
  waits out a quiet window so a later correction or a "don't save" is honoured,
  and scans only public spaces and private spaces Defty was invited to.

Workspace isolation:

- Space membership checks are bound to the caller's current workspace, so a
  member of two workspaces cannot reach one workspace's space with a session for
  the other.

Tooling:

- Typecheck scripts run on TypeScript 7; builds stay on TypeScript 6.
- Dependency updates, including a patched `minimatch` for the ESLint tooling.

The Email-ready release (#424) also shipped in this version:

Operator notes:

- Schema head moves to `0.3.0-preview.135`; existing installations must run the documented upgrade service during deployment (migrations
  `.132` integration capture retirement, `.133` runtime grace resume, `.134`
  restore-access reviews, `.135` connection restore marker).
- Author Kit `0.1.0-alpha.43`. The Experience Worker source cap is raised from
  96 KiB to 112 KiB; apps built against it require this Host or later.
- Anthropic SDK is upgraded to 1.x and the dashboard grid is migrated to
  react-grid-layout v2; web bundles change accordingly.

User-visible changes:

- File transfer queue: private file uploads up to 8 MiB / 30 s, four concurrent
  transfers per owner with a bounded wait, and 45 s attachment downloads with
  busy/gone error reporting.
- Connected app account settings are consolidated into one honest account card.
  Background health and connection status follow the current lease and are scoped
  to the connection owner; reconnect can start directly for connection actions.
- Restore access reviews: single-use reviews, successor marking, freshness checks
  in a transaction, fallback restorable rules, and separate review/confirm phases.
  `agent_policy_default` and `defty_read_grant` are added; record-mirror
  nominations resolve through the owner's human authority; failed approvals are
  retryable and terminal on permanent failure.
- Resumable background leases: lapsed until-revoked leases resume within a 24 h
  grace window and never outlive the owner target deadline.
- Agent-initiated record-mirror nomination and review-time defaults; restore
  observation consents move proposed -> active.
- Web UI polish: Lucide experience icons, phone toolbar grid, scrollable table
  regions, accessible tap targets and muted text, record-form spacing and
  attachment chips, reader chrome.

Fixes:

- System messages are preserved under Anthropic SDK 1.x.
- Module-write idempotency is backfilled so two CRM actions survive; concrete
  approval summaries are produced for multiple CRM module actions.
- Background health uses a bounded grouped query with validation; restore
  per-candidate authority verification is restored; restore activation is refused
  when no review window was issued by `review()`.
- Restore constraints are strengthened; grace resume cannot extend an expired
  finite session; the non-unique restore-review foreign key is dropped; the
  successor marker is allowed on app connection sessions.
- Reconnect flow is cleaned up and starts directly for `connection_action`;
  original attachments are reconciled against draft files on load.
- Record-mirror nominations are approved only from the owner's own web session.
- Dashboard due-today is bucketed in the viewer timezone and the duplicate Done
  summary is removed.
- Directory normalization is case-insensitive; wide tables scroll; recipient
  pills no longer stretch the compose form; the compose From popover restores
  focus.

## [0.3.0-preview.136] — 2026-10-22 (prerelease)

- Scope compact private-record access prompts to write controls on the current
  screen; retain feature-specific guidance and existing authority checks.
- Hydrate seeded Runtime-owned forms without creating a record, bound opening
  waits, and recover read-only failures without replaying writes.
- Keep external mail images hidden until requested with a Show images control.
- Lead app settings with verified connection health and make permission,
  task-source, administration and recovery language easier to understand.

Schema stays131. Author Kit alpha.42 remains immutable. Email28 requires this
Host support and is released and deployed after Host136.

## [0.3.0-preview.135] — 2026-10-21 (prerelease)

- Prevent read-only account-target and background authority checks from
  contending on exclusive organization-membership locks; keep current identity,
  membership, consent and trusted-upgrade checks.
- Return structured, owner-readable account-target, app-open and Runtime
  failures so a temporary infrastructure failure does not request reconnect.
- Pause the foreground startup deadline while the browser tab is hidden and
  resume after the existing authority revalidation when the tab becomes visible.

Schema stays131. Author Kit alpha.42, Email App and Runtime artifacts are
unchanged. Visible-tab acceptance is verified separately from API health.

## [0.3.0-preview.134] — 2026-10-21 (prerelease)

- Isolate app-owned Kit domain modules behind clean core and explicit optional
  compatibility/example entries; preserve Host133 transport and authority fixes.
- Publish additive Author Kit alpha.42 with an exact source/digest metadata asset.
- Prepare native Knowledge provenance/budget and destination revision adapters
  without activating new audience/capture producers or Calendar writers.

Schema stays131. Historical Host133 and Kit41 artifacts remain immutable.

## [0.3.0-preview.133] — 2026-10-21 (prerelease)

- Allow the three retained-account review, activation and status UI requests150seconds of transport time for the bounded120-second server phase and its fresh surrounding checks. Ordinary requests retain35seconds. Server authorization, consent lifetimes and revocation checks remain unchanged.
- Correct the live follow-up failure paired with the separately released Runtime socket-budget correction. Add a client regression that waits past35seconds across all three retained operations while ordinary context still aborts.

Schema remains131, with no migrations or sealed Author Kit changes. Includes the intervening release roadmap documentation update.

## [0.3.0-preview.132] — 2026-10-21 (prerelease)

Corrects the live connect-once acceptance failure found after preview.131. Revalidating multiple declared purposes can exhaust a thirty-second reattachment phase even when every authority check succeeds.

- Bound each retained-account reattachment phase at two minutes, still clipped by the current caller, review, account and action deadlines. Keep every fresh authority, revocation, effect and receipt check.
- Permit only read-only status reconciliation under a still-current trusted upgrade proof after its short issuance window. Revalidate trust revision, roles, source approval and current installation; never restore expired activation authority or issue a background lease from this status path.
- Pair the phase correction with the separately released Runtime HTTP/checker update. Ordinary data/effect budgets and fifteen-minute Runtime sessions remain unchanged.
- Add slow multi-purpose, hard ceiling, finite permission, expired-proof status and revoked-trust regressions.

Schema remains131 with no new migration; historical migration bytes and sealed Author Kit alpha.41 are unchanged.


## [0.3.0-preview.131] — 2026-10-21 (prerelease)

Connect-once platform integration. Schema advances directly from128 to131; Author Kit remains the immutable alpha.41, and Runtime wire contracts remain unchanged.

#### Changed

- Queue a bounded durable successor after each incomplete resource-sync page, reusing ordinary current admission, cursor and attempt fences instead of waiting for the idle scanner (#399).
- Offer one explicit until-revoked initial connection choice for the declared account, private-record and background metadata purposes; provider effects remain separate (#402).
- Let an authenticated, scoped Runtime deployment reacquire fresh short sessions from its current reviewed until-revoked authority without a live browser or hand-copied token (#401).
- Add default-off trust per installation for compatible automatic upgrades. Compare raw authority strictly, preserve finite deadlines and revocation, and deliver fresh version-bound custody and channels over the authenticated Runtime transport (#400).
- Continue an already-approved exact private Experience permission through a completed trusted upgrade. Serialize acquisition, explicit acceptance and revocation across tabs; never recreate a revoked scope (#400).
- Keep receipt-proven retained connection history out of current upgrade-source nomination, preserving the preview.130 renewal fix (#400).
- Make the private-access review easier to read, with visible approval controls and clear storage limits (#389).

#### Database

- Apply only the final schema131 persistent-upgrade guard directly from the published schema128 function. Remove the unpublished intermediate130 replacement; preserve all historical migration bytes and the frozen128 manifest. Fresh bootstrap, exact lineage and no-op upgrade checks remain required.


## [0.3.0-preview.130] — 2026-10-20 (prerelease)

Restores account-permission renewal after a successful connection upgrade retains its historical source. Schema remains128, Author Kit remains alpha.41, and Runtime protocols are unchanged.

#### Fixed

- Nominate the current connected carrier by excluding only receipt-proven superseded history before the two-row ambiguity bound. Fresh owner authority and pending, unknown, source, effect and Runtime fences remain enforced; historical records stay unchanged.
- Match both nullable permission expiry and explicit lifetime mode. Rebuild a proposed scope without retaining its previous lifetime mode, so an account with until-revoked permission remains manageable.


## [0.3.0-preview.129] — 2026-10-20 (prerelease)

Completes preview.128 account-update recovery at the Runtime authority boundary. Schema remains 128 and the Runtime protocol is unchanged. Author Kit alpha.41 packages the additive source-capture contract merged after alpha.40, retaining alpha.40 compatibility.

#### Fixed

- Permit an expired, begun, receipt-free account update to request the Runtime's untouched-attempt closure proof even when Host consumed the callback. Fresh owner authority, exact pins, active-effect fences and immutable callback history still apply. Regression exercises the production Runtime-authority policy rather than bypassing it.

#### Changed

- Prepare generic app-source capture and retained-storage adapters with normalized native Calendar sources (#391).
- Update Zod from 4.6.5 to 4.6.7 (#361).
- Update the MCP client to 2.3.0 for the cross-origin redirect advisory GHSA-6prh-2h8m-c8cw. Preserve the repository release-age policy and the admitted jose6.2.12 resolution.



## [0.3.0-preview.128] — 2026-10-20 (prerelease)

Recovers account updates when Host accepted a callback but the Runtime never started its provider exchange. Schema advances to 128 through a tracked guard-only upgrade; no historical rows, custody, consent deadlines, or existing migration checksums are rewritten. Author Kit alpha.40 packages the additive app-source nomination contract while preserving alpha.39 compatibility; the existing Runtime protocol is unchanged.

#### Fixed

- Recheck current authority and reserve the bounded Runtime request window before consuming an account-update Begin or callback. Expired delivery uncertainty can close through the original status request only with the Runtime's exact untouched-attempt closure proof. Consumed callback history stays immutable, active effects and unknown provider exchanges remain fenced, and the product offers **Recover account setup** before a fresh review (#388).
- Keep **Re-establish background access** available on the connected capability-upgrade settings surface, using the existing generic Runtime installer and app-neutral wording (#388).
- Admit schema128's two pinned function replacements only when the entire prior reviewed catalog and ledger remain exact. Fresh installs and supported upgrades use the same forward migration; repeated upgrades are a no-op (#388).

#### Changed

- Remove 134 unreachable files from the retired built-in Email API implementation. The standalone Email App continues through generic App platform routes; historical database data and migration artifacts are retained (#379).
- Record the app-neutral Host and Author Kit boundary plan for native source contracts, Kit cleanup, and CI enforcement (#378).
- Update Hono from 4.13.9 to 4.13.11 and align generic authentication/error middleware with its stricter types (#380).
- Add the generic trusted Host custody-inventory contract (#381).
- Add native app-source Knowledge audience, versioned capture provenance, and domain-neutral nomination v3 contracts; prior nomination versions remain supported (#383).

## [0.3.0-preview.127] — 2026-10-20 (prerelease)

Lets each App supply its own background-refresh explanation through the optional experience-bundle field `background_refresh_description`. Schema stays 120; no migration.

#### Changed

- Background-refresh reviews use the App's description when present and a neutral Host default otherwise. The generic bundle contract validates 1–500 characters and rejects control characters and angle brackets.
- Author Kit alpha.39 packages the updated contract under a new version, preserving support for alpha.38 and older supported Kits.

## [0.3.0-preview.126] — 2026-10-20 (prerelease)

Restores background resource observation after replacing its consent before the first Runtime claim. Schema stays 120; no migration or App Kit protocol change.

#### Fixed

- The generic observation scheduler now retires a superseded, never-claimed pending read only after validating current consent and the existing recovery identity. Its pending attempt is cancelled and its Run expires without provider work. Existing observation recovery then creates a new Run using the current consent; checkpoint data and historical authority are preserved. Claimed, started, uncertain, and unrelated work remain governed by their existing recovery rules.

## [0.3.0-preview.125] — 2026-10-20 (prerelease)

Lets an owner restore an App Runtime's background work after an App upgrade without anyone copying session tokens. Schema stays 120; no migration. Pairs with Email bundle 1.9.0-preview.18 (App 1.9.0-preview.14, Runtime 0.4.0-preview.18).

#### Added

- Email settings → Accounts has **Re-establish background access**. After an App upgrade the reviewed bindings move to the new version while the Runtime still holds sessions for the old ones, which stopped drafts, sends, organizing and background refresh. The Host now issues sessions for the current reviewed bindings through the ordinary operator checks and delivers them to the Runtime over its authenticated connection transport. Background refresh is included when the account permission lasts until revoked. Tokens never reach the browser, an agent or an operator file.

## [0.3.0-preview.124] — 2026-10-20 (prerelease)

Email connection fixes found while running the live Email journey on preview.123. Schema stays 120; no migration. Pairs with Email bundle 1.9.0-preview.17.

#### Fixed

- A reconnection whose review lapsed before reaching the provider no longer leaves the account reserved. Status now closes it through the reviewed prepared-cancel contract and releases the Runtime reservation, which had blocked reading mail.
- The reconnect screen says when its review has expired instead of silently disabling Continue to provider.
- Creating a Task from an email keeps the chosen project and task details when the app session refresh remounts the panel.
- Background refresh explains that it is required to create Tasks or Knowledge from mail.
- Recovery guidance points to Settings → People → Recovery link, and the People page title no longer says Members.

## [0.3.0-preview.123] — 2026-10-19 (prerelease)

Fixes from the 18 October live release rehearsal on Host preview.122. Schema stays 120; no migration. Pairs with Email bundle 1.9.0-preview.17 (App 1.9.0-preview.14, Runtime 0.4.0-preview.17).

#### Fixed

- Email → Task: Task review now recovers while the source message is still being published, instead of failing with HTTP 403.
- Reliability: exposure-status reads no longer contend with checkpoint publication (the source of rehearsal HTTP 503s); the maintenance pool keeps its connection and survives idle connection failures.
- Defty: scoped member and space discovery, task search by project and description, and assignment by name. The standard OpenAI reasoning model is GPT-5.6 Sol via Responses.
- Dashboard: a rejected agent proposal is shown as a human decision, not a critical failure.
- Hermes: setup reports bundle availability from the release scope instead of linking a missing archive.
- Email draft opening reuses account resolution, and draft loading is bounded.
- Agents and approvals re-check canonical sources before approval and disclosure; proposals are grounded and outcomes reconciled.
- Knowledge and wiki: decision recall and discovery, full source context, preserved wiki versions, authenticated exports and sanitized Markdown answers.
- CRM search typing and filter/sort, chat event fencing, task comment state, mention groups, account recovery and job-startup readiness.

### Release candidate — publication pending

The `0.3.0-preview.16` host and `@deft/app-kit` `0.1.0-alpha.6`
are release preparation candidates. No release tag, image, registry package,
or production certification is implied by this entry. Public installation
instructions continue to use the latest published release.

### Added

- Governed App Runtime actions, reviewed public ingress, owner private resource
  sync, and protocol 7 resource and attachment custody with current authority
  checks and durable Run receipts.
- App Experiences with responsive controls, artifact bound private state,
  explicit human consent separate from technical leases, reviewed agent policy,
  and sealed private Defty context.
- Shared native Defty and MCP discovery of authorized Runtime actions and
  bounded immutable action batches, with one exact host review and per effect
  release checks. CRM personalization uses existing declarative module records.
- Explicit owner authorized observation recovery for terminal resource sync
  Runs, retaining the original cursor, projections, and unknown outcome history.
- A matching portable Author Kit candidate and an Email WIP example. Email is
  a reference implementation requiring separately reviewed setup and an operator
  supplied mail account; synthetic SMTP acceptance does not prove delivery.

### Upgrade preparation

- The candidate includes supported schema upgrades through the existing
  `0.3.0-preview.56` migration identity. Migration names identify schema steps;
  they do not imply that corresponding product releases were published. Use
  `pnpm db:upgrade` for an existing supported installation and preserve migration
  checksums and retained authority data.
- New App capabilities remain subject to their explicit feature flags and
  reviewed consent. See [release boundaries](docs/app-release-boundaries.md)
  for host, Kit, and Email source ownership and candidate packaging.

## [0.3.0-preview.15] — 2026-09-08

### Added

- Connected Apps can request access to supported workspace resources and run
  bounded scheduled actions after operator review. App Kit includes the matching
  package and authoring support. These experimental features are disabled by
  default; see [product status](docs/product-status.md) before enabling them.

### Fixed

- Retrying a task, project, event or message after a lost response no longer
  creates a duplicate of the same request.
- Notes retain pending edits through interrupted saves and refresh expired image
  access. Unavailable private notes show a recoverable error instead of an empty
  editor.
- Native calendar creation and editing use the profile timezone consistently;
  editing targets the existing event. Task date controls support keyboard use.
- Chat attachments appear once in the composer, and search previews show readable
  text rather than stored HTML.
- Connections wait for initialization before joining chat rooms, and background
  queues wait until storage is ready. Automation lists use fewer database queries.
- Approved task creation records its result. Invalid App uninstall requests
  return a useful client error instead of a server failure.
- Backups and upgrades preserve recovery assets; container process supervision
  propagates startup failures and shutdown correctly.

### Security

- Browser sessions rotate durable refresh credentials and invalidate outstanding
  credentials on password changes. Public OAuth endpoints have bounded requests.
- Tiptap dependencies are updated to 3.30.4, including the fix for
  [GHSA-cp6q-959q-f8rh](https://github.com/advisories/GHSA-cp6q-959q-f8rh).

### Release and upgrade notes

- This is a **core** release. Hermes is not certified or distributed as a
  supported integration bundle for this release. Existing
  integration source and historical certification records are not new proof.
- The schema advances to `0.3.0-preview.29`, including durable browser-session
  state and scoped native-create identities. Back up first and use the documented
  versioned upgrade path; do not run fresh-install initialization on existing data.
- Keep the previous image, database backup, uploads, and encryption secrets
  together for recovery. Image rollback alone is not a database rollback.
- Images remain Linux amd64 previews. This release does not claim long-duration
  soak coverage or Hermes certification. Read the release's verification results
  and [current limitations](docs/current-limitations.md) before deployment.

## [0.3.0-preview.14] — 2026-08-31

### Fixed

- Declarative Apps built by the public App Kit are no longer rejected when a
  valid included Module omits schema-defaulted fields such as
  `required: false`. Package artifact integrity and host-side Module semantic
  validation remain independently enforced.

## [0.3.0-preview.13] — 2026-08-27

### Added

- Hermes now ships with the native-first `deft-platform` adapter (`0.2.0`) and
  direct HTTP Deft MCP as the default integration path. The Node Agent Channel
  bridge remains packaged only as an explicit rollback adapter.
- Native onboarding and mode-aware certification now prove accepted-once
  delivery, governed MCP access, private memory, restart identity, and exactly
  one authenticated final reply against Hermes Agent `0.20.5` at the pinned
  `v2026.8.19` commit.

### Fixed

- Accepted chat, task, approval, and certification events survive process
  restarts, empty model output, failed sends, lost success responses, and
  expired handlers without silent loss or duplicate durable replies.
- Profile-bound transport journals now fail closed on endpoint, employee, or
  profile reuse while permitting credential rotation; stale reply anchors and
  non-final certification output can no longer consume another event's final
  slot.
- Certification proof is causally bounded by immutable durable messages and
  real process identity rotation, so retries or later unrelated traffic cannot
  retroactively satisfy an earlier challenge.

### Security

- Autonomous task and notification finals use server-owned event keys, exact
  organization/employee-bound effect reconciliation, and generation-token
  fencing so a stale or malicious client cannot create a second task comment or
  overwrite a reclaimed attempt.

## [0.3.0-preview.12] — 2026-08-25

### Fixed

- The Windows Hermes Agent Channel service installer now keeps its long-running
  supervisor persistent. It no longer adds a duration-bound repeating task
  trigger that could terminate a healthy bridge and cause repeated event
  reclaims.

## [0.3.0-preview.11] — 2026-08-25

### Fixed

- A Hermes employee delivery now recovers after a mid-task bridge restart:
  Deft abandons the stale runtime attempt when the same fenced event is
  reclaimed, while preserving the one-employee single-flight guard across
  different events.

## [0.3.0-preview.10] — 2026-08-24

### Fixed

- Multiple independently installed Hermes employee channel services can now
  run side by side on Windows; each service root receives its own stable mutex
  instead of silently exiting behind the first employee's global mutex.
- Windows service health and repair checks now compare bridge timestamps as UTC
  instants, preventing healthy employees from appearing stale or being
  restarted on hosts outside UTC.

## [0.3.0-preview.9] — 2026-08-24

### Fixed

- GitHub releases publish the environment template as
  `default.env.example`, and `SHA256SUMS` now records that exact downloadable
  filename instead of an unavailable leading-dot name.

## [0.3.0-preview.8] — 2026-08-24

### Added

- Agent Channel v2 now carries structured source evidence, task context, scoped
  conversation locality, renewable leases, single-flight runtime correlation,
  truthful terminal outcomes, and bounded progress heartbeats for independently
  hosted Hermes employees.
- The matched Hermes bundle now includes a Deft employee policy/reporting hook
  and governed memory provider. Fresh sessions automatically receive relevant
  company Knowledge, while employee-private writeback is versioned,
  provenance-bearing, correction-aware, and retry-safe.
- Task and generic module contracts expose executable transition/schema
  guidance, atomic module relations, Contacts-compatible examples, runtime
  readiness diagnostics, artifact-oriented outcome cards, and immutable AI
  attribution.
- CI and release publication now require a commit-bound certificate from two
  consecutive clean-state Hermes employee recovery/security gauntlets. The
  production-image path also runs the Agent Channel and MCP self-host smoke.

### Fixed

- Ambiguous Hermes handoffs reconcile correlated durable effects instead of
  replaying completed work or reporting false failure; duplicate claims,
  expired leases, restarts, and credential rotation remain fenced.
- Hermes can discover and write Contacts and other declarative modules through
  the shared module schema rather than relying on module-specific tool names.
- Connector backoff timestamps ending in `.401Z` are no longer mistaken for an
  HTTP 401 credential failure.

### Security

- Employee identity remains bearer-bound across task, chat, memory, and module
  operations; private-space context and corrections cannot cross their current
  organization or membership boundary.
- Retrieved Knowledge, attachments, module data, and provider descriptions stay
  explicitly untrusted; external writes and destructive commands fail closed,
  and persisted progress, outcomes, receipts, and memory reject or redact
  secret-like content.

## [0.3.0-preview.7] — 2026-08-23

### Changed

- The release-pinned Hermes integration bundle is now version `0.2.1` and
  includes the fresh-install reliability fixes and their regression coverage.

### Fixed

- Hermes service reinstall, repair, stop, and uninstall now terminate both the
  bridge child and its verified PowerShell supervisor so refreshed credentials
  cannot be shadowed by a stale environment.
- Deft employee policy recognizes Hermes's real `mcp_deft_*` tool namespace as
  governed Deft work while continuing to block unapproved external writes.
- Idle channel status no longer sends a null event ID, and ambiguous transport
  failures no longer replay a non-idempotent Hermes inference request and
  duplicate long-running work.

## [0.3.0-preview.6] — 2026-08-23

### Added

- Agent Channel v2 compatibility negotiation, lease/fencing capability checks,
  release and schema readiness metadata, and a release-pinned Hermes integration
  bundle with complete checksums.
- End-to-end employee certification now proves real channel delivery, Hermes
  runtime inference, employee-scoped MCP calls, a nonce-bearing reply, terminal
  outcome reporting, and wiki memory recall/writeback before showing Ready.

### Changed

- Runtime transport contact, health, and employee readiness are now distinct UI
  states. A polling process can no longer make an uncertified employee appear
  ready to work.
- The Windows Hermes service uses structured semantic health and fails closed on
  incompatible protocol versions instead of retrying malformed work forever.

### Fixed

- Prevented newer Hermes bridges from consuming older unclaimed Agent Channel
  events, which previously caused silent non-response and unbounded redelivery.
- Fresh-install and supported-upgrade gates now require Agent Channel leases and
  wiki memory-sync schema before the API reports ready.

## [0.3.0-preview.3] — 2026-08-22

Delta from `v0.3.0-preview.2`. Deft remains alpha.

### Added

- Structured text attachments are now bound to their exact org and message,
  authorized through the same space-membership rules as chat, and presented to
  the agent as untrusted user data with filename/type/size provenance.
- Defty can deterministically compile an attached CSV into one governed,
  full-review module bulk-import proposal. The generic importer resolves the
  target from installed manifests, validates every header/value, limits batches
  to 100 rows, and uses per-row receipts/idempotency so replay cannot duplicate
  records.
- The certified App Protocol v2 implementation contract now defines closed
  Modules, provider-neutral Capabilities, staged App Packs, encrypted Governed
  App Runs, cross-app references, explicit grants, and the Native Equivalence
  branch gate.

### Security

- Retrieved wiki and agent-memory context remain outside system instructions
  and are explicitly framed as untrusted data on the current user turn.
- Agent-authored approval proposals use the canonical actor boundary, cannot
  impersonate a human requester, and recheck live membership, module access,
  employee health, trust, and action budgets before execution.
- Signed action receipts redact secret-like input fields while preserving stable
  verification semantics.
- Attachment lookup is exact-message and exact-org scoped with path containment,
  media/size limits, and no generic filesystem access.
- Bulk-import approval/history/receipts retain row counts, field names, digests,
  and resource IDs but scrub CSV row values and raw retry keys.

### Changed

- Release-tagged GHCR images are keylessly signed with Cosign. The release job
  verifies the workflow identity and GitHub build provenance for the exact image
  digest before it can create a GitHub Release.
- Versioned-upgrade CI now snapshots representative chat, task, wiki, team, and
  agent-action data from a populated `v0.2.0-preview.1` database, runs the entire
  checksummed upgrade chain twice, and requires byte-for-byte preservation.
- Self-hosting docs now provide digest-first signature/provenance verification
  commands and explicitly document forward-only migration recovery.

## [0.3.0-preview.2] — 2026-08-20

Delta from `v0.3.0-preview.1`. Deft remains alpha.

### Changed

- Multi-collection modules, including bundled Contacts, use header
  collection tabs on every viewport. Desktop no longer renders a second
  left rail next to the workspace sidebar.
- Product browser smoke now asserts Contacts collection tabs and the
  absence of a second collections aside.

## [0.3.0-preview.1] — 2026-08-19

First AGPL-3.0-only preview. This is the delta from `v0.2.0-preview.4`.
Earlier `[Unreleased]` notes that already shipped on the `0.2.0-preview`
line are not repeated here.

### Added

- Declarative Modules v1: first-class Deft applications defined through
  strict `deft.module.json` manifests, reusing storage, permissions,
  search, approvals, receipts, tasks, audit, and agent access.
- Bundled Contacts module as a manifest-defined CRM surface for contacts,
  companies, deals, and activities — not CRM code in core.
- Module distribution, provenance locking, sideloading, immutable module
  versions, compatible upgrades, and runtime verification for bundled
  module artifacts.

### Changed

- Relicensed the current release line from BSL 1.1 to GNU AGPL v3.0 only.
  Historical tags through `v0.2.0-preview.4` retain the licenses shipped
  in those revisions. Relicensing does not rewrite old tags or images.
- Removed Redis/BullMQ from the supported runtime. Scheduled work uses
  PostgreSQL `job_queue` with in-process workers.
- Hardened live chat reconnect behavior so subscriptions survive socket
  reconnects.
- Updated dependency and security-tooling pins used by the release line
  (pnpm action, CodeQL, patch/minor group).

### Fixed

- Destructive pilot knowledge-receipt seeding now uses real
  message-backed sources, explicit simulated-history metadata,
  tenant-scoped replacement, and deterministic planning.
- Chat browser smoke assertions are scoped to actual message rows.
- Cross-org receipt semantics are preserved in the module runtime.
- Preview GitHub Releases now attach `.env.example` and include it in
  `SHA256SUMS`. Shell `dist/*` previously omitted that dotfile.

## [0.2.0-preview.1 — 0.2.0-preview.4]

Historical BSL 1.1 preview releases. These tags introduced the portable
preview-image and self-host upgrade line and remain licensed under the
terms included in those revisions.

See the GitHub Releases page and tag comparisons for exact historical
contents.

## [0.1.0-alpha] — 2026-05-26

> Historical release snapshot. Some integrations and architecture described below were later retired or narrowed. Use [FEATURES.md](FEATURES.md), [current limitations](docs/current-limitations.md), and the self-hosted v1 contract for the current product boundary.

First public alpha. Deft is a source-available AI-native workspace: native chat
+ tasks + an AI agent (Defty) with direct SQL access to your data, plus a
Bring-Your-Own-Agent (BYOA) MCP surface for connecting external runtimes
(Claude Code, Claude Desktop, Codex, Cursor, custom MCP).

### Added — platform

- Multi-tenant Postgres + Drizzle ORM workspace with `org_id` row-level
  isolation on every table; soft-deletes throughout for agent history.
- Native chat surface: TipTap composer, threads, group DMs, pins, mentions,
  reactions, file uploads, presence + typing indicators over Socket.io
  (Redis adapter).
- Native tasks: 6-status engineering flow (`backlog → todo → in_progress →
  in_review → done → cancelled`), p0–p3 priority, Board / List / Timeline /
  Calendar / Pipeline views, labels, reactions, mentions in description +
  comments, recurrence (daily / weekly / biweekly / monthly), inline
  activity diff log, archive + soft-delete with 7-day recovery window.
- Unified `events` table for connected tool data so the agent queries native
  + Google Calendar / GitHub in one breath.
- Real-time over Socket.io with Redis adapter; background jobs via BullMQ.
- Custom JWT + bcrypt auth (jsonwebtoken + bcryptjs); Google OAuth optional.
- File storage via Cloudflare R2 or local disk with presigned uploads.

### Added — agent

- **Defty** — built-in platform agent. Runs in-process via Anthropic API
  with direct SQL access, 42+ native tools, multi-step planning, persistent
  memory (remember / recall), and streaming responses.
- **Multi-provider Defty** — pluggable reasoning backend:
  `anthropic` / `openai` (gpt-5.x and o-series via Responses API) /
  `openrouter` / `ollama`. Falls back gracefully if a provider key is unset.
- **BYOA employees** — every `agent_employees` row is an external runtime
  connecting via MCP at `/api/mcp/v1`. Per-employee trust levels, daily
  action caps, cost tracking ($100/day default), circuit breakers (3
  consecutive errors → `unhealthy` flag blocks dispatch).
- Three-tier approval flow: auto-execute / quick-approve / full-review.
- Three trust levels per org: Conservative / Standard / Autonomous.
- Workflow executor for the `task.status_changed` trigger with 4 actions
  (`add_comment` / `assign_to` / `add_label` / `notify`).
- GitHub `PR → task close`: parses `PREFIX-N` refs in PR title/body on the
  `pr_merged` transition and closes each referenced task with an
  attribution comment.
- Heartbeat lifecycle with per-tick logging (`agent_heartbeat_turns`),
  cost guardrails, idempotency via `prompt_sha`, and loop detection.
- Unified `/inbox` queue: mentions + DM unread + task notifications +
  agent approvals in one tab strip, with a single aggregated badge count.
- Skills primitive with three tiers (bundled / marketplace / org); 14-entry
  ClawHub allowlist bundled as a static fallback when the daily catalog
  fetch fails.
- Webhook-callable agents with HMAC-SHA256 signing (per-webhook key,
  constant-time comparison; legacy raw-secret accepted with deprecation
  warning).

### Security

- **Phase 7 hardening** — 10 vulnerabilities fixed:
  - XSS prevention via DOMPurify on all `dangerouslySetInnerHTML` sites (6
    components).
  - IDOR fixes on workflow-run / agent-message / wiki-citation delete
    endpoints (verify ownership before delete).
  - Space-membership enforcement on every space / message / pin endpoint
    and on the WebSocket `space:join` event.
  - Upload path traversal fix (`path.basename` + `Content-Disposition:
    attachment`).
  - Daily-notes optimistic locking via CAS version check (409 on
    conflict).
- Webhook signing migrated from raw-secret comparison to HMAC-SHA256.

### Changed — architecture

- **Phase 9 simplification** (2026-04-28): collapsed 5 agent kinds
  (`native`, `openclaw`, `claude_sdk`, `custom_mcp`, plus the unkinded
  built-in) down to 2 roles — Defty (in-process, well-known
  `deft-agent@system.local` system user) and BYOA (every
  `agent_employees` row, MCP-only).
- Removed the in-process gateway: `openclaw-gateway.ts`,
  `openclaw-dispatch.ts`, `openclaw-client.ts`, `openclaw-chat-envelope.ts`,
  the `gateway-ping.ts` worker, the `provider_instances` table, and 10
  OpenClaw sidecar columns on `agent_employees`. All archived under
  `docs/deprecated/openclaw/`.
- Trigger system retained — `trigger_subscriptions` still routes webhooks,
  `member.joined`, cron, and `task.status_changed` events into
  `agent_actions` rows that BYOA clients pull via `poll_pending_work`.
- **Phase 1–4 agent-chat unification** (2026-05-07): collapsed
  `agent_conversations` + `agent_messages` tables into the unified
  `spaces` + `messages` schema (each `/agent` conversation is a
  `spaces` row of type `agent_conversation`; each agent turn carries
  structured Anthropic content in `metadata.agent_blocks`). Deleted the
  dedicated `/agent` route — chat is now the only agent-conversation
  surface. Approval inbox promoted to a top-level `/approvals` page
  (now `/inbox?tab=approvals` after Phase 5).

### Known limitations

- **`pnpm db:push-full`** is required for fresh installs — not
  `db:push` or `db:migrate`. The `apply-extras.ts` script applies
  schema features `drizzle-kit push` can't express (`tsvector` generated
  columns + GIN indexes for wiki/task FTS; pgvector ivfflat indexes;
  expression-based unique indexes).
- **No transactional email** — invites and password recovery are
  admin-generated one-time URLs (shared out-of-band by an admin).
- **API can't deploy to Vercel** — WebSocket support required.
  Use Railway, Fly.io, or any container host. The Next.js web app
  deploys to Vercel fine.
- **No Supabase support** — blocked in India.
- Repo history still contains ~44 MB of audit screenshots (cleaned in
  #26, not history-rewritten — history rewrite would break in-flight
  forks/clones during alpha).

### License at release

The `0.1.0-alpha` tag was originally published under BSL 1.1. The current
codebase has since been relicensed under [GNU AGPL v3.0 only](LICENSE); consult
the license file present in the exact revision you use.

[Unreleased]: https://github.com/Maneek21/Deft/compare/v0.3.0-preview.141...HEAD
[0.3.0-preview.15]: https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.15
[0.3.0-preview.14]: https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.14
[0.3.0-preview.13]: https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.13
[0.3.0-preview.12]: https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.12
[0.3.0-preview.11]: https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.11
[0.3.0-preview.10]: https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.10
[0.3.0-preview.9]: https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.9
[0.3.0-preview.8]: https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.8
[0.3.0-preview.7]: https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.7
[0.3.0-preview.6]: https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.6
[0.3.0-preview.3]: https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.3
[0.3.0-preview.2]: https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.2
[0.3.0-preview.1]: https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.1
[0.2.0-preview.1 — 0.2.0-preview.4]: https://github.com/Maneek21/Deft/releases/tag/v0.2.0-preview.4
[0.1.0-alpha]: https://github.com/Maneek21/Deft/releases/tag/v0.1.0-alpha
