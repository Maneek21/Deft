# Changelog

All notable changes to Deft are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and during the pre-1.0 alpha phase the project uses a loose interpretation of
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) — minor versions
(`0.X.0`) may include breaking changes to schema, API contracts, or required
env vars. Patch versions (`0.X.Y`) are non-breaking fixes only.

## [Unreleased]

### Defty answers to everyone who can read the conversation

- In a room, a thread, a group DM or a DM between two people, Defty now uses only the
  records every reader of that conversation can see: its members and guests and, for a
  public room, everyone in the workspace who can open it, plus any agent that can read
  it (with that agent's project limits). It used to answer with the asker's access, so a
  reply in a public room could name a restricted task that the other people there get
  "not found" on. Tasks and their counts, projects, messages, notes, canvases and wiki
  pages are checked this way. So are the tasks named in the room's messages, Defty's
  earlier replies there, and the drafts it shows for approval.
- When Defty leaves something out because not everyone there can see it, its reply ends
  with "Some items were left out because not everyone here can see them."
- In those conversations, lookups that aren't checked this way (team and people reports,
  calendars, GitHub, memory, decisions and knowledge, Modules, Apps and connected tools)
  aren't run. Defty says to ask it in a direct message instead.
- A 1:1 DM with Defty works exactly as before.

## [0.3.0-preview.157] — 2026-11-27 (prerelease)

Changes since `v0.3.0-preview.156`: #624, #625, #626 and #627 (#624 changes only tests).
Release scope `core` (no Hermes compatibility claim). Cut from master at `763fbccc`. No
database migration: `packages/db` is unchanged since 156, and `DEFT_SCHEMA_HEAD` stays
`0.3.0-preview.154`.

### The welcome "Say hello in #general" is posted

- The last step of the welcome tour, **Say hello in #general**, now posts your hello to
  the workspace's default space (#general, unless it was renamed) or, if you see no
  default space, to a space named general. **Post and finish** used to send it to an
  address that doesn't exist, so the hello was lost without a word. If the hello can't be
  posted, the step now says "Your hello wasn't posted. Try again, or skip and say hello in
  #general later." and stays open, so you can try again or skip; trying again can't post
  the hello twice. With neither space, the step says "There's no #general to post in.
  Skip, and say hello in a space later." instead of posting the hello to another space
  you're in.

### Sharing a note with a person works

- **Share note** now shares the note with the person you pick. The dialog sent no one
  (the server answered "user_id required"), so a note couldn't be shared with a person;
  only **Org** visibility worked. **Add people** now leaves out you, the people the note is
  already shared with, and Defty, which reads notes as the person asking it and so gains
  nothing from a share. If a share is refused, the dialog says "Couldn't share the note
  with *name*. Try again." A person under **Shared with** whose name you can't see is shown
  by email address, or as "Someone".
- `GET /api/members` gives each person an `is_defty` flag, so Defty can be recognised even
  by a guest, who sees no one else's email address.

### Calendar events show on their attendees' calendars

- An event you create with attendees now also shows, read-only, on the calendar of each
  attendee who is an owner, admin or member of the workspace: on **Calendar**, on the
  dashboard, in their published calendar feed, and to Defty and MCP tools reading their
  calendar. Before, it was stored only on your calendar and attendees never saw it.
  Attendees are matched by email address. Only you can change or delete the event, and
  attendees see no **Edit** or **Delete**. A guest, a deactivated member, someone outside
  the workspace and members who aren't attendees see nothing. Events imported from another
  calendar, and invitations accepted from email or an app, stay visible only to their
  owner. Nobody is notified.

## [0.3.0-preview.156] — 2026-11-27 (prerelease)

Changes since `v0.3.0-preview.155`: #620, #621 and #622. Release scope `core` (no Hermes
compatibility claim). Cut from master at `e7bbd39d`. No database migration:
`packages/db/upgrades` is unchanged since 155, and `DEFT_SCHEMA_HEAD` stays
`0.3.0-preview.154`.

### "Email me about this report" starts unticked

- On hosted Deft, the **Email me about this report** box in **Report a problem** (user
  menu) is now unticked when the form opens. A report carries your account's email
  address only when you tick the box yourself. Ticked, it works as before: the Deft team
  can email you at that address about the report.

### The Apps guide says hosted Deft has no Email

- **Apps and App packages** (`docs/modules-and-apps.md`) now says Email is a self-hosted
  developer preview and that hosted Deft doesn't include Email at launch: new hosted
  workspaces get no Email helper. It also says the newest Email release's
  `compatibility.json` names Deft 0.3.0-preview.138, and that no Email release has been
  tested with 0.3.0-preview.155.

### Clearer messages when an app update is refused

- **Upload new version** with a file whose version is older than, or the same as, the
  installed app no longer offers **Update**. The check now says the file's version is not
  higher than the installed one, names both versions, and suggests the next one: "The
  installed app is 1.2.0 and this file is 1.0.5. Give the file a higher version, such as
  1.2.1." The server refuses such an update with the same words, and the page no longer
  adds "Refresh and try again." The server used to suggest 1.0.1 whatever the installed
  version was, and a file identical to the installed one got only "No newer version of this
  app is available".
- Removing a record type that still holds records is refused, as before, with a line that
  says so and names the records, such as: "Roles: record type removed, but it still holds the
  records "Product designer" and "Backend engineer"". It used to read "Roles → Record: does
  not fit in …".
- A `"$schema"` that is not text of at most 2,048 characters is now reported as
  "$schema: must be a text URL (found a number)" (or "must be a text URL of at most 2048
  characters (you have …)") instead of "unknown key "$schema"". Deft checks only that it is
  text and its length, not that it is a URL.

## [0.3.0-preview.155] — 2026-11-26 (prerelease)

Changes since `v0.3.0-preview.154`: #610, #613, #609, #614, #615, #616, #617 and #618, plus
#612 (154's release branch merged back into master, which adds nothing new). Release scope
`core` (no Hermes compatibility claim). Cut from master at `2529a7b2`.

### Build your own app in the browser

A workspace owner or admin can now build an app and change it without leaving Deft. It all
happens in **Settings → Apps**, which lists every app in one place: the ones that come with
Deft (Contacts installs in one click), the ones built in the workspace, and App Kit packages.
Settings → Modules now opens this page.

- **Start from a starter app.** Four are offered: Hiring pipeline, Vendor tracker, Light CRM
  and Content calendar. Name one, choose whether to add a few sample records, and install.
  No file is needed. The samples come with their links (a candidate linked to its role, a
  deal to its company). The app is an ordinary uploaded app, yours to edit and update, and
  it opens on a board. If the name is taken, or belongs to an app that ships with Deft, it installs as "<name> 2"
  (web address ending in `-2`). If adding samples stops part-way, the app stays installed
  and the message says how many were added.
- **A plain-words check before install.** Before an app file installs, the check step
  describes it: each record type and its fields ("Stage: pick one of Applied, Phone
  screen…, starts as Applied, required"), how record types link ("Each Candidate links to
  one Role"), its views ("Pipeline: a board grouped by Stage") and who can see the records.
  It asks "Let Defty read these records?". The answer defaults to no; yes turns on read
  access for Defty after install.
- **Edit, Check and Save.** **Edit** on an app built in the workspace opens its app file.
  **Check** reads it the way the server will: it must be valid, keep its id and slug, and
  raise its version. **Save** updates the app, and raises the version by one patch step if
  you didn't. Every record is kept. A change that would break existing records is refused;
  when it is their values that no longer fit, the message names them (see "Updates" below).
  Save applies only if nobody updated the app since you opened it (`If-Match`); if someone
  did, you're told to load the newest version. An app that ships with Deft shows **View
  file** instead of **Edit**: its file opens read-only and says why. An app that belongs to
  an App Kit package has no Edit or View file button; it changes only with a new version
  of its package.
- **Download** saves an app's file. It starts with a `$schema` line, so an editor checks the
  file as you type.
- **Upload an app** takes any `.json` file, whatever it is called, and works out what it is.
  An app file installs after the check step, or updates the installed app with the same id
  and slug, keeping every record. An App Kit package goes to inspect and review, as before.
  A wrong file, such as a text file or broken JSON, gets a plain message, and nothing is
  sent.
- The four starter files are plain app files (`apps/web/src/lib/app-templates/*.json`), ready
  for the website to offer as downloads.

### Upgrade notes

- **No migration.** Schema head stays `0.3.0-preview.154`, so an upgrade from `.154`
  changes no schema and the `upgrade` service has nothing to apply. Back up first, as for
  every upgrade. To roll back, run `.154`'s image digest: there is nothing to undo in the
  database.
- **Settings → Apps needs no switch any more.** On `.154` it appeared only in a web build
  with `NEXT_PUBLIC_FEATURE_APPS`, and app files were managed on Settings → Modules. Now it
  is always there for owners and admins, with everything above. App Kit packages still
  appear on it only with the Apps switches on (`NEXT_PUBLIC_FEATURE_APPS` in the web build,
  `DEFT_APPS_ENABLED` on the server).
- No setting is added, changed or removed. Author Kit stays `0.1.0-alpha.43`.

### Behaviour changes an operator should know

- **Developer pairing answers 404 when it is off.** With developer pairing off
  (`DEFT_APP_DEVELOPER_PAIRING_ENABLED` not `true`, as on hosted), `POST /api/apps/pairings`
  and its revoke route answer 404 `NOT_FOUND` instead of 503. `GET /api/apps` now also
  returns `developer_pairing: { available }`, and the Apps page shows **Pair Codex** only
  when it is `true`. With `DEFT_APPS_ENABLED` off, `/api/apps` is not mounted at all, as
  before.
- **Reserved app names are refused (409).** An upload can no longer take the slug or id of
  an app that ships with Deft (such as `contacts` or `com.deft.contacts`), or any id that
  starts with `com.deft.` or `io.deft.`. Installing such an app file
  (`POST /api/modules/sideload`) or staging such an App package answers 409
  `MODULE_IDENTITY_RESERVED`, with a message that says what to change. Before, an upload
  could block bundled Contacts, or Email, in that workspace for good, because an installed
  app cannot be uninstalled. Bundled Contacts still installs in one click. Apps installed
  before this release are not touched.
- **An App package can't carry an app that ships with Deft, even unchanged.** Staging one is
  refused with 409 `MODULE_IDENTITY_RESERVED`, and an App update may not add one. So the
  Contacts CRM App's upload through Settings → Apps is now refused; installs made before
  155 keep working (see `docs/crm-operator-demo-guide.md`). Email still stages through its
  own reviewed entry point, which now trusts only a Protocol 7 package with the id
  `io.deft.email`. No upload route can mark a package first-party.
- **"Module" is "app" in every word a person reads:** the web app (app and record pages,
  task links, approval cards, search, Settings → Personal AI connections, the sign-in
  consent screen), error messages, and the descriptions of the app record tools for MCP
  clients and Defty. A collection is a "record type", and a manifest is the "app file".
  **No route, API field, error code, OAuth scope (`read:modules`, `write:modules`) or MCP
  tool name (`module_list` and the rest) changed.** A client that matched on the old message
  text should match on `code` instead. The API only gains fields: `developer_pairing`
  above, and the `details` below.
- **Upload errors are readable.** A refused app file or App package gets at most three plain
  lines that name where the problem is, such as
  `Candidates → fields: at most 64 fields (you have 500)`, instead of the validator's raw
  JSON. A JSON syntax error names its line and column when they can be found. This covers installing and updating
  an app, inspecting and staging an App package, and the check the browser runs before
  upload. The same lines are in `details.lines`.
- **Updates name the records that block them.** When an update is refused because some
  records' values would not fit the new version, the message names up to five of them by
  title, with the field and the problem, such as
  `Candidates → Email: now required, but empty in "Dana Example" and "Sam Sample"`, or
  `… → Notes: removed, but still has a value in …`. Up to 20 of the records, each with its
  problems, are in `details.records`, and the total in `details.record_count`. The code is
  still `MODULE_VALIDATION_ERROR`. Other refusals are unchanged and name no records: links
  that no longer fit (for example, a link field made single while some records link to
  more than one) name the field and give the record's id in `details.source_record_id`, and
  a member field that points to someone who is not an active member gives
  `details.invalid_member_ids`.
- **`"$schema"` is allowed in an app file.** Add
  `"$schema": "https://deft.ing/schemas/deft.module.v1.schema.json"` and an editor checks
  the file as you type. The line is dropped on upload, so it never changes the app's digest.
  The schema file is `docs/schemas/deft.module.v1.schema.json`, for the website to serve at
  that address. It describes what you write: `required`, `multiple` and `subtitle_fields`
  are optional, because Deft fills them in. (A first draft marked them required, so editors
  flagged valid files and all four starter apps failed it.) A file missing something truly required
  (such as `id`, or a field's `label`) still fails. App Kit, which builds App packages and
  ships on its own, does not accept the line yet.

### Limits

- **Apps hold data and views only.** An app adds record types, fields, links and views
  (boards, tables, timelines, forms and record pages). It can't run code of its own, add
  custom screens or buttons, send email, run on a schedule, or connect to outside services.
- **Apps are turned off, never deleted.** Turning an app off hides it and keeps its records.
  Its id and slug stay taken.
- **A customer-built App package (App Protocol 0, records and views only) can't be
  upgraded.** Deft refuses another version of it (409), and it can't be uninstalled.
  Changing it means a new App with a new id. Connected packages keep their separate,
  reviewed upgrade flow.
- **Guests can't see apps or their records** (403 `MODULE_ACCESS_DENIED`). Owners, admins
  and members see and change every record in an app; there are no private records, record
  types or fields. Only owners and admins install, update and turn off apps.
- **At most 64 fields per record type.** An app also holds at most 8 record types, each with
  at most 8 views, in an app file of at most 128 KB.

### Docs

- The six guides the website copies from `docs/` (first workspace, first agent action, first
  MCP connection, the MCP task example, building your first app, and apps and App packages)
  say "For Deft v0.3.0-preview.155." and were checked against this release. "Build your
  first app" starts in the browser (Settings → Apps, a starter app, editing, uploading a
  file), with the self-hosted command line second. "Apps and App packages" explains that a
  customer's app is an app file, and that App packages are for Deft's own Email at launch.

### Notices carried forward (unchanged since `.142`)

Kit `0.1.0-alpha.44` removes deprecated Email compatibility. Not before 2026-11-25, and never
fewer than 14 days after this notice merged. No code changes here and alpha.43 is unchanged.
Alpha.44 is the "next breaking Kit alpha" the existing `@deprecated` notices name. It removes
the 26 deprecated compose, address-list and raster names from the root and `/experience` entry
points, the 9 sandbox names re-exported from the root, the root override of
`checkDeftAppDeveloperContract`, and the `safe-compose-html`, `mailbox-list` and
`native-compose-raster` modules under `@deft/app-kit/examples/email`. Importing only the root
will no longer register the sandbox profile; the `sandbox`, `templates`, `register` and `cli`
modules and the three `examples/email` subpath exports stay, opt-in. Use `@deft/app-kit/core`
and the `deft-email` `runtime/domain` modules, or keep pinning alpha.43. Names and plan are
listed in the Kit README and
`docs/superpowers/plans/2026-11-06-email-host-kit-shrink.md`.

- App-boundary gate: `scripts/app-boundary-ceiling.json` caps the exception count at
  1,277 (it may only be lowered), each exception's `milestone` starts with its burn-down
  bucket, and `node scripts/check-app-boundary.mjs --summary` prints the counts per
  milestone. No finding changed.

## [0.3.0-preview.154] — 2026-11-26 (prerelease)

Changes since `v0.3.0-preview.153`: #603, #607 and #608. Release scope `core` (no Hermes
compatibility claim). Built from the branch `release/v0.3.0-preview.154`; nothing merged
into master after #608 is in this release.

Upgrade notes:

- **One migration, additive: `0.3.0-preview.154`.** It adds one table, `note_files` (which
  note shows which uploaded file), with an index; it changes and deletes nothing.
  Schema head moves from `0.3.0-preview.149` to `0.3.0-preview.154`. The release's
  `upgrade` service (`pnpm db:upgrade` from a source checkout) applies it; a fresh install
  (`pnpm db:push-full`) creates it. Stop Deft and back up the database and the uploads
  volume first, as for every upgrade.
- **Existing note images are covered.** The migration itself inserts no rows. When the
  server starts, it records the images in notes saved before this release (see "Note
  images" below). It runs on every start, does nothing twice, and the hourly clean-up of
  unattached uploads waits until it has succeeded.
- **Rolling back.** Upgrades are forward-only. To return to `.153`, stop Deft, restore the
  pre-upgrade database and uploads backups, and run the previous image digest. `.153`'s
  `upgrade` service refuses a database that already has `.154` ("newer than this Deft
  build"). An image removed from a note on `.154` is deleted 24 hours later and is only
  in a backup made before that.
- No setting is added, changed or removed. Author Kit stays `0.1.0-alpha.43`.

Note images (#603). On `.153` and earlier, an image in a note loaded only for the person
who pasted it; everyone else saw "Image is unavailable".

- **Now.** An image in a note loads for everyone who can open that note: people it is
  shared with, members of its space, and, for a note visible to the whole workspace, its
  owners, admins and members.
- **Nobody else.** Only images the note's author uploaded count. A file that no note you
  can read shows still answers as unknown. Guests follow the note rule: they see the images
  of notes shared with them and of notes in their spaces. A deleted note's images load
  only for the person who uploaded them.
- **Notes saved before this release.** Their images are covered too: the server records
  them when it starts (an image still waiting to be cleaned up is kept). As on a save, only
  images the note's author uploaded count. An upload from before Deft checked file types
  is not included and still loads only for its uploader.
- **Removed images are deleted.** An image you take out of a note is deleted 24 hours
  later, once no other note of yours shows it (later still if a scheduled message you have
  not sent yet carries it). Before, it was kept for ever.
- **Workspace export.** A person's export now includes the images of the notes they can
  read, the same files the app lets them load.

Tasks (#607). An unknown task priority or status is refused with a clear error instead of
a server error, wherever a task is created or changed: the app and API, bulk changes, the
MCP tools and Defty.

- **Priority.** Valid values are `p0`, `p1`, `p2` and `p3`. Creating a task with another
  value (for example `urgent`) through `POST /api/tasks`, `POST /api/projects/:id/tasks` or
  `POST /api/tasks/project/:projectId` now answers 400 `VALIDATION_ERROR` and creates
  nothing. Before, it answered 500. Editing a task, bulk edits, the MCP `task_create`,
  `task_update` and `task_bulk_update` tools (personal and agent employee) and Defty's task
  tools check it the same way, on the task and on each subtask, and refuse it with each
  tool's usual error. Before, MCP and Defty task creation quietly used `p2` instead, an
  agent employee's `task_update` quietly skipped it, and the personal MCP `task_update`
  failed with a database error. A missing or `null` priority is still `p2`.
- **Status.** Valid values are `backlog`, `todo`, `in_progress`, `in_review`, `done` and
  `cancelled`. An unknown status (for example `open`) on those three create routes now
  answers 400 `VALIDATION_ERROR` instead of 500, and Defty's `update_task_status` refuses it
  instead of failing with a database error. A missing or `null` status is still `backlog`.

Note backlinks (#608). A note or message that names a task by its key now links to that
task when the project's prefix holds a digit, such as `R9G-1` or `RC8-12`. Before, the key
was read from its last letters (`R9G-1` as `G-1`), so the task got no backlink, or a task
in another project whose prefix matched those letters got it instead.

- A key is matched whole, the way task search matches it since `.153`, so a zero-padded
  key (`R9G-01`) links nothing. A prefix may also start with a digit (`9RC-1`). A key must
  stand as its own word (`preR9G-1` links nothing), and a note links only the task whose
  key is written exactly, with its dash. A note still links only tasks its author may see.

## [0.3.0-preview.153] — 2026-11-26 (prerelease)

Changes since `v0.3.0-preview.152`: #598, #600, #599 and #601. Release scope `core`
(no Hermes compatibility claim). Built from the branch `release/v0.3.0-preview.153`, not
from master: #603 (note images for every reader, with a migration) is not in this release.

Upgrade notes:

- No migration. Schema head stays `0.3.0-preview.149`; `pnpm db:upgrade --status` on an
  install already at `.144` to `.152` has nothing to apply. An install on an older release
  follows the earlier upgrade notes first (stop Deft, back up the database and the uploads
  volume, `pnpm db:upgrade`).
- No setting is added, changed or removed. Author Kit stays `0.1.0-alpha.43`.
- Owners, admins and members see fewer tasks: a task restricted to named people now
  reaches only those people on task lists, counts, reports and notices. Read "Restricted
  tasks" below.
- Guests see fewer notes. If your workspace has guests, read "Notes and guests" below.
- Only an owner, an admin or a project's current lead can now change who leads it. Read
  "Project leads" below.

Restricted tasks (#600). A task can be restricted to the people it names: its assignee,
co-assignees, creator and named viewers, plus its watchers and its project's lead (a guest
also needs to be named on it or lead its project; watching does not count for a guest).

- **What leaked.** Owners, admins and members not named on a restricted task could see it
  in a project's task list and in a team dashboard's top tasks. This was so in 152 and
  earlier (since restricted tasks were added). Owners are not exempt from the rule: an
  owner sees a restricted task only when it names them or they lead its project.
- **Now.** A restricted task's row, title and count reach only the people it names, in:
  - **Task views:** a project's task list, a team dashboard's top tasks, a task's subtasks,
    parent, dependencies and subtree, and subtask counts.
  - **Counts:** a project's task counts, totals and weekly completions, the dashboard's
    project counts, the people directory and member detail.
  - **Agents and tools:** the MCP tools `project_list`, `project_get` and `team_workload`;
    Defty's team performance, workload, 1:1 prep and expert-finder tools; activity
    receipts.
  - **Reports:** the 1:1 prep and manager pulse pages show only the restricted tasks the
    manager may see; the weekly digest's task totals, workload alerts and People Graph
    count no restricted task.
  - **Notices:** the @mention, workflow, unblocked, duplicate, blocked and stalled notices.
    A restricted task's stalled or overdue nudge goes to the person, not to an agent.
  - **Copies:** a copy of a restricted task, and the next occurrence of a recurring one,
    stay restricted to the same people (they used to be open to everyone).
- **Known limits, not fixed here.** 1:1 preps, snapshots and People Graph counts saved
  before this release keep what they showed when they were made (as do notices written
  before it). Defty answering in a shared room can quote what the person who asked may
  see, the same family as the room-publication limit (D2). `/api/audit` shows owners and
  admins task audit snapshots, a restricted task's title included. Two fields still show
  that hidden tasks exist, without their titles: a project's `task_counter` (the last
  reserved task number, shown to owners, admins and members), and a visible subtask's
  `parent_task_id` when its parent is a restricted task hidden from an owner, admin or
  member.

Task search (#600). `GET /api/tasks/search`, used by the task pickers, searched titles only
when a query did not look like a task key, and keys only when it did: `rc8` searched only
for the key `RC-8` (so no task titled "rc8 notes"), while `R8O-1`, a key whose project
prefix holds a digit, searched only in titles. It now matches a task's key (`PREFIX-N` or
`PREFIXN`, any case) and its title for every query, key matches first, and still shows only
tasks the caller may see.

Project leads (#600, #601). A project's lead sees all of its tasks, restricted ones
included, so naming a lead grants that access:

- **Changing a lead.** Before, any member could make themselves lead of an existing project
  and so read its restricted tasks. Now only an owner, an admin or the project's current
  lead can change it: anyone else gets `403 FORBIDDEN` from `PATCH /api/projects/:id`, and
  a tool error with code `FORBIDDEN` from the MCP tool `project_update`. Guests were already
  barred from changing the lead. So a member can no longer give a lead to a project that
  has none; an owner or admin can. When changing a lead through the API, the new lead
  must be an active member of the workspace (`400`); a change racing another lead change
  answers `409 CONFLICT` (`CONFLICT` from the MCP tool). Members still set a lead when
  creating a project, and still edit a project's other fields.
- **Creating a project.** A guest can no longer set a lead when creating a project:
  `POST /api/projects` with `lead_id` from a guest answers `403 FORBIDDEN`, and the MCP
  tool `project_create` refuses it. A guest may still create a project without a lead.
- **Workflow rules.** A rule's `assign_to` action no longer assigns a restricted task to
  someone who can't already see it, whoever wrote or edited the rule; the run records the
  action as not done.

Notes and guests (#598). A privacy change for every install, hosted or self-hosted, that
has guests:

- **Before.** On `.152` and earlier, a guest could list, open and search every note
  visible to the whole workspace, as a member could.
- **Now.** A guest sees their own notes, notes shared with them and notes in their spaces.
  Any other note answers as if it did not exist (404, or left out of a list) on the notes
  page and its templates, search, tags and tag counts, task backlinks, the MCP note and
  team tools, Defty's note tools and retrieval, note mentions and note promotion to the
  wiki. A team link to a hidden note still shows as restricted, without its title or
  label, and a hidden note can't be linked to a team. A workspace export
  made for a guest (`--member`) holds only the notes that guest may open; a whole-workspace
  export (`--whole-workspace`) still holds every note, private ones included. Owners,
  admins, members and agents can open what they opened before.
- **Search fix, for everyone.** Search now finds a note shared with you. It used its own
  copy of the rule, without shares; every note surface now uses the one rule.
- **For members too.** Defty's note search and note retrieval now also return notes shared
  directly with you (notes you could already open): every note surface now uses the one
  rule. A note linked to a team that the reader can't see now shows no title or label
  there, and can't be linked by a team lead who can't see it (before, a private note's
  title showed to every team reader in the MCP team tools).

Note images (#599):

- **Fixed.** An image pasted or inserted into a note was kept as an unattached upload, and
  the file clean-up deleted it (and its stored file) after 24 hours, so the note showed a
  broken image from the next day on. Saving a note's text now keeps the images it shows:
  on create and edit, from the notes page, the MCP note tools and Defty's `create_note`.
  Only uploads you made yourself, in the same workspace, are kept this way; naming someone
  else's upload in your note does not keep it. Scheduling or cancelling a message that
  carries a kept image no longer puts it back on the 24-hour clock.
- **Already lost.** An image pasted into a note before this release could be deleted by
  the clean-up (it runs about hourly) once it was 24 hours old; a deleted image can't be
  restored from the app: paste it again. An older image that still shows is kept once the
  person who pasted it edits and saves the note's text (renaming the note alone does not
  keep it).
- **Still only the person who pasted it.** An image pasted into a note still loads only for
  the person who pasted it. Sharing the note gives no one else access to the image, so
  they see it as unavailable (unless the same file is also attached to a message or task
  they can read). The fix for everyone who can read the note comes in the next release.
- **Known gap.** Removing an image from a note keeps its file; nothing deletes it yet.

## [0.3.0-preview.152] — 2026-11-25 (prerelease)

Changes since `v0.3.0-preview.151`: #592, #593, #594, #595 and #596. Release scope `core`
(no Hermes compatibility claim).

Upgrade notes:

- No migration. Schema head stays `0.3.0-preview.149`; `pnpm db:upgrade --status` on an
  install already at `.144` to `.151` has nothing to apply. An install on an older release
  follows the earlier upgrade notes first (stop Deft, back up the database and the uploads
  volume, `pnpm db:upgrade`).
- Two optional settings are added: `DEFT_TELEMETRY` (leave unset for on; `off` turns the
  anonymous install ping off) and `DEFT_SUPPORT_EMAIL`. No setting is changed or removed.
  Author Kit stays `0.1.0-alpha.43`.
- Self-hosted installs now send one anonymous install ping. Read "Telemetry, self-hosted"
  below; to stop it, add `DEFT_TELEMETRY=off` to `.env` before you start this release.
- Guests see fewer tasks. If your workspace has guests, read "Guests" below first.

Telemetry, self-hosted (#592). A self-hosted install sends one thing, the install ping, and
nothing else:

- **What.** A `POST` to `https://get.deft.ing/v1/installs/ping` with four fields: an
  anonymous install id, the event, the Deft version and the time. The event is
  `installed` once, when the first owner creates the workspace, and `person_added` each
  time someone accepts an invite and becomes an active member (guests too; agents never
  send one). No names, email addresses, workspace names, message, task or file content,
  counts or credentials.
- **The install id** is derived from the install's own `ENCRYPTION_KEY` and its first
  workspace's id (a keyed hash, HMAC-SHA256; the key never leaves the server). It is
  stable: it stays the same across restarts, upgrades and a restored backup, and changes
  only if that key is rotated (or the workspace is created again on a new database). It is
  not linked to any person or address, and nobody without the key, the Deft project
  included, can compute it or turn it back into a workspace id. The control plane keeps,
  per install id, when it was first and last seen, the last version and how many people
  were added; it keeps no IP address, user agent or headers.
- **When not.** Never with `DEFT_TELEMETRY=off`, on a paused start, from a development
  build (only `NODE_ENV=production` sends, as the Docker image is), or on a hosted cell.
  One attempt with a five-second limit; it never delays signup or an invite.
- **Nothing else.** Self-hosted installs send no error events, no problem reports and no
  heartbeats. The web app reports errors in the page to your own API server, which keeps
  nothing and tells the page to stop. "Report a problem" exists only on the hosted
  service; on a self-hosted install, `DEFT_SUPPORT_EMAIL` (optional) shows your own help
  address in the user menu ("Get help") and sends nothing.
- **Turn it off:** add `DEFT_TELEMETRY=off` to `.env` and restart. It is disclosed in
  `docs/self-hosting.md` ("Telemetry"), in one line on the setup screen while the ping is
  on, and in `.env.example`.

Telemetry, hosted cells (#592, #593). Only on hosted workspaces (`DEFT_HOSTED=true`) with
the seat-statement settings set; error events and the heartbeat also need a production
build and `DEFT_TELEMETRY` not off. Everything goes to the Deft control plane only, over
the cell's seat-statement channel, never to a third party:

- **Error events.** Unhandled request errors, other 5xx answers, failed background jobs,
  uncaught process errors and browser errors, scrubbed in the cell. No part of an error's
  own message is sent: only fixed text for a message the JavaScript engine or the browser
  writes ("Cannot read properties of undefined (reading <quoted>)"), or an error code in
  the format of a system or database error code ("code ECONNREFUSED"), or nothing. Also the error class, frames as
  file, line and function (browser frames: the web app's own bundles, no function names),
  the code's route templates and the app's page templates, and only error references the
  cell itself issued. At most one batch a minute (a fatal exit included), grouped by
  fingerprint, at most 50 events and 64 KB; a failed batch is dropped and counted, never
  retried, and sending pauses after failures or a 429.
- **"Report a problem"** in the user menu, for everyone signed in (guests included): the
  text the person writes, as written, a category, and their account's email address if
  "Email me about this report" is ticked (it is ticked when the form opens; unticking it
  leaves the address out); with it the release, their role, the page (as a template),
  the browser family and the cell's recent error references. Sent only when the person
  asks; they get a short reference or are told it was not sent.
- **Heartbeat.** Shortly after start and then about hourly: the cell id, the release, the
  seats in use (counted exactly as the seat limit counts them; guests and agents never
  count) and the time. Nothing else.
- **Never sent automatically** (in error events and the heartbeat): message or task
  content, names, email addresses, uploaded file names, links, keys, request bodies,
  headers or query strings. A problem report carries what the person chose to write, and
  their email address as above.
- `/api/metrics` adds `deft_telemetry_heartbeats_total`, `deft_telemetry_error_events_total`,
  `deft_telemetry_error_batches_total` and `deft_telemetry_install_pings_total`.

Database memory: approvals (#594). Read this one if Deft's Postgres runs on a small machine
(512 MB):

- A room's pending-approvals poll now costs a database connection about 7 MB to plan
  instead of about 36 MB, and an Inbox approval of a Defty action about 17 MB instead of
  about 30 MB: the approval review check plans only the parts the approvals it meets need.
  Who sees and who reviews an approval is unchanged; a test compares every narrowed check,
  and a room's list, with release 151's for every person, role, room and approval state.
- **Trade-off.** A room's pending approvals now refresh when something changes, with a
  fallback check every 30 seconds; with slow database reads a change can take about 1
  minute to show (151 was about 35 s). This also stops a few open tabs running into the
  per-user request limit.
- Measured on Postgres 16 capped at 512 MB, one pending approval with six tabs open: the
  database's four connections grew to 112 MB in all instead of 213, and at least 369 MB
  stayed available instead of 268.
- **Known limit.** Approvals from outside agents still plan about 19 MB (room) to 30 MB
  (Inbox).

Guests (#595). A privacy change for every install, hosted or self-hosted, that has guests:

- **Before.** On `.151` and earlier, a guest could read every workspace-wide task, its
  comments, activity and files, as a member could.
- **Now.** A guest sees only the tasks of projects they lead or belong to, and tasks that
  name them (as assignee, co-assignee, creator or named viewer; watching does not count).
  A guest belongs to a project linked to a room they are in (archived or not). Restricted
  tasks keep their own rule for guests too. Any other task answers as if it did not exist
  (404, or left out) everywhere: task lists, boards, the table, search, calendar and
  timeline, task detail, subtasks, dependencies, comments, activity, files and their
  downloads, project and team counts, the dashboard, member profiles, live updates,
  notifications and the unread count, the Inbox, workflow run history, the MCP task,
  project, search and Inbox tools, Defty's task tools and approval cards, and a
  member-scoped workspace export made for a guest. Notifications already sent to a guest
  about such a task are no longer shown.
- **No longer allowed for a guest:** changing who leads an existing project (a lead sees
  all of its tasks); creating, changing or deleting workflow rules; watching, commenting on, editing
  or nesting a subtask under a task hidden from them; listing 1:1 preps made before they
  became a guest. Project lists and details no longer show a guest a project's task
  counter.
- **For everyone:** watching a task now needs read access to it. Before, anyone signed in
  could watch any task by its id and, as a watcher, read it even when it was restricted.
  A subtask created or moved through the API now needs a parent task of the same workspace
  (otherwise 404).
- **Unchanged.** Owners, admins and members see what they saw before. The rule follows the
  person's active role in the workspace, never their session or token.
- **Known limits.** Deft has no way yet to link a room to a project (only the demo seed
  scripts write these links), so on hosted workspaces nothing links rooms to projects and a
  hosted guest belongs to a project only by leading it. The room publication limits (D2)
  are unchanged: task text published into a room reaches everyone in it, guests included
  (Defty's replies about other projects' tasks, the daily standup in #general, and a clip
  summary read by a guest who joins the room later). Per-viewer room messages are a later
  design.

Also changed:

- **Launch checks (#596).** Tests only, no behaviour change: CI now guards seat limits,
  clip routes, setup tokens and stored AI addresses.

## [0.3.0-preview.151] — 2026-11-25 (prerelease)

Changes since `v0.3.0-preview.150`: #585, #586, #587, #588, #589 and #590. Release scope
`core` (no Hermes compatibility claim).

Upgrade notes:

- No migration. Schema head stays `0.3.0-preview.149`; `pnpm db:upgrade --status` on an
  install already at `.144` to `.150` has nothing to apply. An install on an older release
  follows the earlier upgrade notes first (stop Deft, back up the database and the uploads
  volume, `pnpm db:upgrade`).
- Two optional settings are added, both for the API's database pools:
  `DEFT_DATABASE_POOL_MAX_LIFETIME_SECONDS` (default `300`) and
  `DEFT_DATABASE_POOL_IDLE_TIMEOUT_SECONDS` (default `10`). Leave them unset for the
  defaults. A value that is not a whole number in range stops the API at startup, naming
  the setting. No setting is changed or removed. Author Kit stays `0.1.0-alpha.43`.
- Guests see fewer people. If your workspace has guests, read "Guests" below first.
- No page loads fonts from Google any more. A proxy or browser policy of your own that
  allowed `fonts.googleapis.com` or `fonts.gstatic.com` for Deft no longer needs to.

Guests (#587). A privacy change for every install, hosted or self-hosted, that has guests:

- **Before.** On `.150` and earlier, a guest received the same people a member saw, with
  every email address, from the member list, the people directory and member profiles.
- **Now.** Guests no longer see every member or any member's email address; they see only
  people they share a space with (a room, a direct or group message, or an agent
  conversation, archived or not), and no email address but their own. This holds in the
  member list and people directory, people search (by name only), member profiles, room,
  group and team member lists, who is online, the MCP member, team and context tools, when
  they ask Defty to find someone, and in a member-scoped workspace export made for a guest.
  Defty's workspace-wide reports about people (team workload, activity, expertise, team
  performance, agent employees and their costs) are refused to a guest
  (`NOT_AVAILABLE_TO_GUESTS`).
- A guest cannot start a direct message with, add to a room, assign a task to, or share a
  note with someone they share no space with: that person is refused as if unknown. A
  guest can no longer generate a 1:1 prep for anyone (404, as for an unknown report); for
  everyone else, the report must be an active member of the workspace.
- **What still shows.** Names on content a guest can already read: the assignee, creator,
  commenters and watchers of a task they can see, the authors of messages they can read,
  and their own past collaborators in My Insights. The member counts in the group list and
  on teams still include people the guest cannot see (numbers only, no names); a group's
  own page counts only the members the guest can see.
- The rule follows the person's active role in the workspace, never their session or
  token. A person with no active membership gets the guest view. An agent employee follows
  the rule by its own workspace role, but one with no active membership row keeps the view
  it had before: to restrict an agent employee, give it the guest role. Owners, admins and
  members see what they saw before.
- For everyone: people search no longer lists removed members, or deleted or inactive
  agents.

Database memory on a small Postgres (#590), continued from `.150`. Read this one if Deft's
Postgres runs on a small machine (512 MB):

- **Approvals.** On `.150`, while a person had an open approval in their Inbox, each
  database connection that checked it grew about 80 MB and kept that memory until it
  closed. The approval review rule (the Inbox's, and the approve and reject routes') now
  plans each of its checks once. A connection grows 30 MB planning an Inbox approval item
  (was 79), 35 MB planning the whole Inbox rule (was 84), 23 MB loading a page's approvals
  (was 38) and 22 MB answering whether the viewer may approve (was 38). Who sees and who
  reviews an approval is unchanged: a test compares the rule with the previous one for
  every person, role and approval of a matrix (pending, approved, rejected and expired;
  requesters, assignees, owners, admins, guests, departed requesters; module writes,
  employee, capture and plan actions). Measured on Postgres 16 capped at 512 MB, with 14
  tabs polling an Inbox that held 11 pending approvals: before, four connections reached
  127 MB each and the kernel killed Postgres within 9 seconds; now the four peak at 119 MB
  together and the database at 168 MB.
- **Pooled connections retire.** Every database pool the API opens now closes a connection
  once it is `DEFT_DATABASE_POOL_MAX_LIFETIME_SECONDS` old (default 300; 30 to 86,400).
  A connection past that age is closed when it is next released, never while a request,
  transaction or advisory lock holds it, so the memory it took is given back soon after.
  The pools also close one idle for `DEFT_DATABASE_POOL_IDLE_TIMEOUT_SECONDS` (default
  10, as before; 1 to 3,600). No pool's size changes. The App run maintenance pool keeps its
  one standing connection past the lifetime (node-postgres would not reopen it).
- **Still open.** A chat room's pending-approvals poll (every 5 seconds) costs a connection
  36 MB to plan, and the whole Inbox rule 35 MB.

Also changed:

- **Fonts (#589).** The web app now serves its fonts (Inter and JetBrains Mono, the same
  weights) itself instead of loading them from Google Fonts, so no page makes a request to a
  third party for fonts. The signup page (with or without a setup link), setup, login,
  invite and password-reset pages make no request outside the app and its API at all; a
  browser test in CI checks this. The page policy (CSP) no longer allows
  `fonts.googleapis.com` or `fonts.gstatic.com`.
- **Calendar feeds (#586).** Adding a calendar (ICS) feed now checks the address before
  saving it and refuses, with 400 `ICS_URL_NOT_PUBLIC`, one that points to a private
  network or to the server itself, uses a port other than 80 or 443, carries credentials,
  or whose name does not resolve within 5 seconds. A sync allows the whole fetch 20
  seconds, so a public feed whose name was slow to resolve can be refused once and saved
  on a retry. In a hosted workspace at its outside-request limit, an address that passes
  the other checks is refused with 429 `WORKSPACE_OUTGOING_LIMIT` before its name is
  looked up. Before, an inward address was saved and then refused at every sync, so
  nothing was ever fetched from it; now it is not stored either. A self-hosted install's
  `DEFT_CALENDAR_PRIVATE_URL_ALLOWLIST` entries are still accepted. Feeds already saved are
  unchanged.
- **API keys (#585).** Creating or changing an API key with a malformed request body is now
  refused with 400 `VALIDATION_ERROR` instead of failing with 500. So is a value the
  database cannot store or that would leave the key unreachable: an expiry date that is not
  a date or falls outside the years 1 to 9999, a rate limit above 2,147,483,647, a NUL
  character in the text, an empty agent id, or a change request with no recognized field.
- **`pnpm db:push-full` (#588).** When it stops part-way it now says plainly that the
  database is incomplete and must not be used, and how to recover. When it can read the
  database's upgrade ledger, it also names the range of upgrades it did not apply and which
  of `ics_publish_tokens`, `seat_statements` and `user_two_step` are missing; when the
  server's Postgres or pgvector version is not one it recognizes, it shows the versions it
  found. Before, such a stop left a database that looked usable but lacked the tables of
  those upgrades. On the supported image (`pgvector/pgvector`, pinned in
  `docker-compose.yml`) push-full is unchanged. CI now checks that a fresh install and an
  upgraded one have the same tables.

## [0.3.0-preview.150] — 2026-11-25 (prerelease)

Changes since `v0.3.0-preview.149`: #583. Release scope `core` (no Hermes compatibility
claim).

Upgrade notes:

- No migration. Schema head stays `0.3.0-preview.149`; `pnpm db:upgrade --status` on an
  install already at `.144` to `.149` has nothing to apply. An install on an older release
  follows the earlier upgrade notes first (stop Deft, back up the database and the uploads
  volume, `pnpm db:upgrade`).
- No setting is added, changed or removed. Author Kit stays `0.1.0-alpha.43`.

Fix: a few chat messages could run a small database out of memory (#583). Read this one
first if Deft's Postgres runs on a small machine (512 MB).

- **What happened.** In `.149` and earlier (at least back to `.145`), after a chat message
  the server checked each recipient's attention (Inbox) item with one very large visibility
  query. It covered every kind of item, including the approval review rule, whatever the
  item was. Planning that query took each database connection to about 86 MB, and the
  connection kept that memory until it closed. The same query also ran on every Inbox
  count poll (every 15 seconds in each visible, online workspace tab). On a small
  database machine a few connections doing it at once ran it out of memory. On three
  test workspaces (512 MB database machines, Postgres's default settings), with messages
  in rooms that had members: one machine froze after 26 messages and 2 uploads; one froze
  during its fourth run of about 40 messages; on the third, after 14 messages, the
  kernel's out-of-memory killer killed a Postgres backend and the postmaster reset all
  backends.
- **What changed.** The check now plans only the rules for the item types it can meet: for
  a message item, a connection grows by a few MB. Lists, counts and lookups by id read the
  item types and the items in one snapshot. Marking items seen, changing an item's state
  and giving feedback lock the items first and change only those. Mark-all-seen now
  records its events in the same transaction, in batches: before, marking 8,192 or more
  items at once failed after the items were already marked.
- **Visibility is unchanged.** A new equivalence test checks the narrowed query against the
  whole one, item by item. It covers owners, admins, members, guests and removed members;
  private, public, archived and joined rooms; approvals, mentions and every item type. It
  also flags an item type named in the API code that is not listed (a direct insert into
  the table is not covered).
- **Self-hosters.** This matters most on a 512 MB database machine with the default
  `shared_buffers` of 128 MB: four such connections (about 86 MB each) plus shared buffers
  come to about 470 MB, leaving roughly 40 MB for the operating system and everything
  else. A larger machine has more headroom.

Not fixed yet (follow-ups):

- While a person has an open approval in their Inbox, their checks still plan the approval
  review rule, about 80 MB per connection. Making that rule smaller is a follow-up.
- Pool recycling: the app's database pools never close a connection that grew large while
  it stays busy. Giving connections a maximum lifetime is a follow-up.
- Pool total against `max_connections`: the app's pools can open up to 18 connections, and
  nothing checks that total against the database's `max_connections`.

## [0.3.0-preview.149] — 2026-11-24 (prerelease)

Changes since `v0.3.0-preview.148`: #577, #578, #579 and #580. Release scope `core` (no
Hermes compatibility claim).

Upgrade notes:

- No migration. Schema head stays `0.3.0-preview.149`; `pnpm db:upgrade --status` on an
  install already at `.144` to `.148` has nothing to apply. An install on an older release
  follows the earlier upgrade notes first (stop Deft, back up the database and the uploads
  volume, `pnpm db:upgrade`).
- No setting is added, changed or removed. Author Kit stays `0.1.0-alpha.43`.
- Two changes reach every install, hosted or self-hosted: the web pages now send four
  response headers, and the app's ordinary database connections turn Postgres JIT off.
  Both are described below. If a reverse proxy in front of Deft sets any of those four headers
  itself, check that its value still suits the pages listed below.

Security fix. Read this one first. On `.148` and every earlier release, a person who lost
access to a room could still see and act on the assistant's work from it. This was a live
gap, not a risk that needed an unusual setup:

- **Assistant actions (#578).** A member who lost read access to a room (left a space or
  DM, was removed from it, was made a guest, was removed from the workspace, or lost an
  archived public room they had not joined) kept their pending assistant actions from
  that room. Leaving an active public room does not by itself end a non-guest's read
  access, so it cancels nothing. The member could not see them after `.148`'s hiding change, but they
  were never cancelled. A self-approval that started just before the loss could still
  run. After a member left the workspace, any owner or admin who could read the room could
  approve such an action, and it ran under the departed member's name. Now, when a person
  loses a room, their pending assistant actions from it are cancelled in the same
  transaction as the loss: the audit row is kept, its `approval_status` becomes `expired`
  and it records the reason, and a governed module write's proposed values are scrubbed.
  A 15-minute sweep (at most 500 actions per workspace and 100 workspaces per pass) closes
  any the routes did not cover. Every approval re-checks the room when it is claimed, so
  while access is lost no approval runs such an action, whoever reviews it. An approval
  claimed before the loss committed can stand.
- **Defty plans (#579).** `.148` and earlier had no room check on Defty plans at all
  (plans exist since the first release). A member who lost a plan's room could still list
  and open the plan, whose steps carry that room's content, and could edit, approve, run
  and resume it. An owner or admin could approve and run a departed member's plan, and it
  ran as that member. Now a plan counts only while its creator can still read the plan's
  conversation room and the room of its source message, and is an active workspace
  member. A plan that fails this disappears from the plan list, and reading, editing,
  approving, running and resuming it by id answer 404 (pause and abort still work and
  return only the plan's id and status).
  A running plan pauses, with a reason, if its creator loses a room before a step starts.
  The same rule covers a plan's steps wherever they are read or approved: the pending
  list, Inbox, approval retries, history, an employee's activity and its queues.
  Creating a plan in a room its creator cannot read is refused. Two execution changes
  apply to every plan, including those whose creators keep their rooms: recovery after a
  failed step now returns a text recommendation without calling tools or saving a durable
  employee note, and execution pauses on a step whose id is `source_message_id`,
  `task_id` or `created_via`.
- **Plans bound to no room (#580).** A recovery step in `.148` could create a plan that
  named no room, so it stayed readable and runnable after its creator lost the room it
  came from. A plan that names no room of the workspace now counts only when its creator
  is an owner or admin, or when the person made it through the plan route (marked from `.149` on; plans
  such a plan creates inherit the mark). It is never treated as allowed by default. This
  narrows one thing: **a member may no longer see or run their own plans that have no
  room binding and carry no route mark**, that is, plans they made through the plan route
  before `.149` with no conversation, and any recovery draft from `.148`. An owner or
  admin can still open and run their own such plans; nobody else, including an owner or
  admin, can open or run another member's.
- Owners and admins keep the full history of assistant actions and plans, including rooms
  they have left. That is the action-history rows, plan steps included. It does not let
  them open or run a plan whose creator lost a room, and captures from a private room they
  are not in stay hidden from them as before.

KNOWN LIMITS:

- A plan's stored step results keep copies of what the assistant read when the step ran. A member who later loses access to a room still sees, in her own plans, copies of that room's content made while she had access. Tracking where each stored result came from is planned after launch.
- This includes copies made on `.148` of a no-room plan's activity.

Web pages send four isolation headers (#577). Every page response of the web app now carries
`Cross-Origin-Opener-Policy: same-origin`, `Origin-Agent-Cluster: ?1`,
`Cross-Origin-Resource-Policy: same-origin` and `X-DNS-Prefetch-Control: off`, matching what
the API already sent. A page on another address that opens a workspace page in a new
window no longer keeps a handle to it, and other addresses can no longer embed the app's
files. It applies to self-hosted installs as well. Exceptions, each found by a browser test:

- `/oauth/authorize`, `/login?from=oauth` and `/two-step-setup?from=oauth` send
  `Cross-Origin-Opener-Policy: unsafe-none` (the other three headers still apply), so an
  outside MCP client's sign-in pop-up keeps its window handle and the authorization code
  reaches the client, including after a reload of the sign-in step. Plain `/login` keeps
  `same-origin`.
- `/app-experience-bootstrap.js` sends `Cross-Origin-Resource-Policy: cross-origin`: the
  sandboxed App frame has an opaque origin and could not load it otherwise. The script is
  fixed and public and carries no user data.

Postgres JIT is off for the app's ordinary database connections (#579). The API's main query
pool sends `SET jit = off` when it opens a connection (an error from that statement is
ignored; the pool for session advisory locks is not changed), hosted and self-hosted
alike. With JIT on, Postgres spent seconds
compiling some Inbox approval-count statements that run in milliseconds (2 to 28 s against
5 ms, up to the 30 s statement timeout). Your database's own setting is unchanged for other
clients.

Named follow-ups:

- #578: a proposal committed while a loss is in flight can remain pending; approval is
  blocked while access is lost, and a later sweep expires it if access is still lost; route-level contention tests; make `lockRoomAccessForClaim`'s
  `actionId` required; a `lock_timeout` on waiting claims; record-mirror and App Run
  releases need the lock if their rows ever name a room; an approved action with no
  outcome whose requester lost the room stays approved (it cannot run); pending step rows
  of a BYOA employee's plan are not drained (they cannot run).
- #579: stored step results carry their source rooms; one central room check with an
  inventory test of every reader; Agent Channel can deliver a retained `approval.resolved`
  event for a step of an employee's own bound plan to that employee; an employee's direct
  module call can get a receipt replay of its own bound plan's step result; plan creation
  checks the room and inserts in two statements, so a removal in between stores a plan its
  creator cannot read (it stays hidden from them); an approved plan step with no recorded
  outcome stays approved after its requester loses the room (it cannot run); make the
  Inbox approval count cheaper, then revisit JIT.
- #580: an owner- or admin-made `.148` plan with no room stays visible to its own bound
  employee's queues and status route.
- #577: `deploy/demo/Caddyfile.example` sends `/oauth/authorize` to the API, which predates
  the headers change.

## [0.3.0-preview.148] — 2026-11-24 (prerelease)

Changes since `v0.3.0-preview.147`. Release scope `core` (no Hermes compatibility claim).

Upgrade notes:

- No migration. Schema head stays `0.3.0-preview.149`; `pnpm db:upgrade --status` on an
  install already at `.144` to `.147` has nothing to apply. An install on an older
  release follows the earlier upgrade notes first (stop Deft, back up the database and the
  uploads volume, `pnpm db:upgrade`).
- Six new settings for the hosted Deft service only: `DEFT_HOSTED_LIMIT_OUTGOING_PER_MINUTE`,
  `DEFT_HOSTED_LIMIT_OUTGOING_PER_HOUR`, `DEFT_HOSTED_LIMIT_SCHEDULED_MESSAGES`,
  `DEFT_HOSTED_LIMIT_REMINDERS`, `DEFT_HOSTED_LIMIT_STORAGE_PERCENT` and
  `DEFT_HOSTED_LIMIT_STORAGE_FREE_MB`. A self-hosted install must leave them unset: with
  any of them defined (even empty) and without `DEFT_HOSTED=true`, startup is refused,
  like the other hosted-only settings listed in `docs/self-hosting.md`. If you copied a
  hosted environment file, remove them. On a hosted cell each is optional and must be a
  whole number inside its range (listed in the settings table in `docs/self-hosting.md`),
  or startup stops. The numbers below are the defaults.
- `DEFT_PAUSED_REASON` accepts a third value, `emergency_stop`. Nothing else about a
  paused start changes. Nothing sets it on a self-hosted install unless you do.
- No other setting is changed or removed. Author Kit stays `0.1.0-alpha.43`; its source
  is unchanged since `v0.3.0-preview.143`.

Hosted service (limits apply only when `DEFT_HOSTED=true`; a self-hosted install has none):

- Per-workspace limits. A hosted cell serves one workspace, so each is that workspace's:
  - Outside requests (link previews and calendar feed previews and syncs; each redirect
    hop counts): at most 60 a minute (`DEFT_HOSTED_LIMIT_OUTGOING_PER_MINUTE`) and 1,000
    an hour (`DEFT_HOSTED_LIMIT_OUTGOING_PER_HOUR`). Past that, a link preview is skipped
    and a scheduled feed sync waits (the feed stays due and shows the reason); a calendar
    feed preview or manual sync answers 429 `WORKSPACE_OUTGOING_LIMIT` with a
    `Retry-After`. Adding a feed at the limit still saves it and answers 201: its first
    sync shows the reason and the next attempt waits for the feed's interval, so a
    client should not retry the creation. Chat and everything else work as usual.
  - Scheduled items: at most 500 scheduled messages
    (`DEFT_HOSTED_LIMIT_SCHEDULED_MESSAGES`) and 2,000 reminders
    (`DEFT_HOSTED_LIMIT_REMINDERS`) waiting at once. Past that, a new one is refused with
    409 `WORKSPACE_SCHEDULE_LIMIT` and a message saying why, until some have been sent,
    gone off, cancelled or removed. Reminders the assistant sets count too.
  - File storage: a file is refused with 413 `WORKSPACE_STORAGE_FULL` once files would use
    more than 90% of the uploads volume (`DEFT_HOSTED_LIMIT_STORAGE_PERCENT`) or leave
    under 200 MiB free (`DEFT_HOSTED_LIMIT_STORAGE_FREE_MB`, counted in MiB). It covers
    uploads, clips, custom emoji and files an App stages, and counts writes still in
    progress. A write the disk itself refuses (full or over quota) gets the same answer;
    uploads, clips and emoji then try to remove the partial file, but a failed App stage
    can leave an inaccessible partial file behind (its stage stays `uploading`). If the
    volume cannot be measured the file is refused with 503
    `WORKSPACE_STORAGE_UNAVAILABLE` (try again shortly).
  - The person sees the reason (the server's words) where they upload, set a reminder or
    sync a feed. Owners and admins (active people) also get an in-app notice when the
    outside-request limit is reached or the pre-write storage check refuses a file with
    413 `WORKSPACE_STORAGE_FULL`, at most one an hour per limit and API process; a refusal that
    only comes from the disk itself, a 503 `WORKSPACE_STORAGE_UNAVAILABLE`, and the two scheduled-item limits send none. The
    operator's log has at most one `workspace_limit_reached` line a minute per limit and
    process, with no values in it.
- Emergency-stop banner: a workspace the operator stops with `DEFT_PAUSED_START=true` and
  `DEFT_PAUSED_REASON=emergency_stop` shows signed-in people a banner that outgoing
  activity is stopped while a problem is looked into, that they can still sign in and read
  messages and tasks, that nothing can be changed, that link previews, notifications and
  AI are off, and that scheduled messages and reminders wait until the stop is lifted. It
  refuses exactly what any paused start refuses; the operator's stop is the only way a
  workspace gets into it.

Small changes that reach self-hosted installs too:

- A refused upload or reminder now shows the server's reason (for example a file that is
  too large): uploads in chat, threads, task attachments and note images; reminders in
  chat and the command palette. Files dropped or selected together in chat, and images
  pasted together in chat and threads, each report their own refusal.
- Each scheduled calendar feed scan selects up to 50 due subscriptions (as before), least
  recently updated first.
- Docs only (#575): the installation guides now pin the published `.147` image instead of
  `.144`, and this changelog records `.145` to `.147` as published.

## [0.3.0-preview.147] — 2026-11-23 (prerelease)

Changes since `v0.3.0-preview.146`. Release scope `core` (no Hermes compatibility claim).

Upgrade notes:

- No migration. Schema head stays `0.3.0-preview.149`; `pnpm db:upgrade --status` on an
  install already at `.144`, `.145` or `.146` has nothing to apply. An install on an
  older release follows the earlier upgrade notes first (stop Deft, back up the database
  and the uploads volume, `pnpm db:upgrade`).
- One new setting, `DEFT_TEST_FAILURE_SWITCHES`, for operators' test installs and test
  cells only. Never set it on a workspace people use. It is off unless it is defined in
  the process environment (no screen, route or table can set it). Self-hosted, the value
  must be exactly `on`; on a hosted cell it must be exactly `cell:<this cell's
  DEFT_CELL_ID>`. Any other value, even empty, stops the API at startup. On a hosted cell
  that means a value copied from another cell cannot turn it on; a self-hosted `on` works
  on any install it is copied to, so remove the variable from any environment file you
  copy. When it is on, startup logs a warning, and it affects only an approved assistant
  action or a message that carries a test marker. A marker in the action's proposed
  parameters (`deft-test-fail-final`, `deft-test-fail-retryable`) makes it fail without
  running, finally or once; a retryable one stays pending and runs normally the next time
  it is approved. This is tested for a posted-message action (`post_message`); other
  action kinds are not covered (a wiki page proposal may still run, and a task link
  fails finally even with the retryable marker). A message containing `deft-test-hang-reply` makes the assistant's reply
  wait until the worker's job timeout (120 seconds unless `DEFT_JOB_TIMEOUT_MS` says otherwise). Nothing else changes.
- No other setting is changed or removed. Author Kit stays `0.1.0-alpha.43`; its source
  is unchanged since `v0.3.0-preview.143`.
- Anything that relied on a member still seeing an assistant action from a room they
  can no longer read: see below.

Privacy fix (applies to self-hosted installs too):

- A member or guest who can no longer read a space or group message the assistant (Defty)
  proposed an action from (removed, or left a private space or group message) no longer
  sees that action. Before, the Action Log, which returns the action's proposed
  parameters including message text, could still list a pending action from such a space,
  and Settings, Agent showed the space's name. The rule now applies to the Action Log
  (Settings, Agent and its API), the recent and pending lists, the Inbox list and counts,
  an action's receipt and undo, the conversation and trace views, the dashboard feeds,
  agent activity, run details, and the status read a person makes with their own API key.
  A person who leaves a public space they can still read keeps seeing its actions.
- The rule covers every room the action came from: its conversation, the room of the
  message it is attached to, and the room of the message it was drafted from. Members of
  an archived space keep reading its history, but nothing in it can be approved.
- Approving was already refused with a plain 404 `NOT_FOUND` when the attached message's
  room was unreadable. It is now refused the same way when the conversation or the
  drafted-from message's room is unreadable.
- Owners and admins keep the assistant's action history in these views, as before. Other
  action kinds (for example records of what an agent captured from a source) keep their
  own source rules. Actions that are still pending stay pending: they are not cancelled
  when a person loses the room.

## [0.3.0-preview.146] — 2026-11-23 (prerelease)

Changes since `v0.3.0-preview.145`. Release scope `core` (no Hermes compatibility claim).

Upgrade notes:

- No migration. Schema head stays `0.3.0-preview.149`; `pnpm db:upgrade --status` on an
  install already at `.144` or `.145` has nothing to apply. An install on an older
  release follows the earlier upgrade notes first (stop Deft, back up the database and the
  uploads volume, `pnpm db:upgrade`).
- One new setting, `DEFT_HOSTED_SEATS_URL`, for the hosted Deft service only. A
  self-hosted install must leave it unset: with it defined (even empty) and without
  `DEFT_HOSTED=true`, startup is refused, like the other hosted-only settings listed
  in `docs/self-hosting.md`. If you copied a hosted environment file, remove it. On a
  hosted cell, unset or blank means no link; any other value must be an `https`
  address without a user name or password, or startup stops.
- No setting is changed or removed. Author Kit stays `0.1.0-alpha.43`; its source is
  unchanged since `v0.3.0-preview.143`.
- Anyone who has set up two-step verification (self-hosted installs included) and
  signs in with a recovery code must now set up a new authenticator before anything
  else works; see below. Tell the people who hold recovery codes.

Two-step verification (applies to self-hosted installs too):

- Signing in with a recovery code no longer opens a session. It returns a token that can
  only set up a new authenticator (`POST /api/auth/two-step/enrol/start` and
  `/enrol/confirm`); every other API call that sends it as a bearer token is refused
  with 401 `TWO_STEP_ENROLMENT_REQUIRED`, a paused start and public routes included. The sign-in
  page sends the person to a "Set up a new authenticator" screen. Using the code signs
  out every session the person has. When setup is confirmed, the new authenticator and
  a new set of recovery codes replace the old ones, any session opened since (for
  example with the old authenticator) is signed out, and the person is signed in. The
  token lasts 30 minutes and is kept in that browser tab only. If it is lost or
  expires, the person signs in again with the old authenticator, or with another
  unused recovery code to restart setup. The recovery codes are shown once, in the
  confirmation response; a client that gets them without a session token pair must
  show them and then sign in again.
- Until a new authenticator is confirmed, nothing is lost: the old authenticator and
  the recovery codes not yet used stay valid. The code that was spent stays spent.
- The account holder gets an in-app notification, whatever their notification
  preferences are, when a recovery code is used ("A recovery code was used on your
  account") and when the second step is set up again after one ("Two-step verification
  was reset"). Neither says anything about the address or time of the attempt.
- Scripts or clients that sign in with a recovery code and expected a session in the
  same response must handle the enrol-only token (`two_step.status`
  `enrolment_required`, `two_step.reason` `recovery_code`).

Hosted service:

- Owners of a hosted cell that sets `DEFT_HOSTED_SEATS_URL` see a "Buy more seats" link
  next to the seat count in Settings, Members, and on the answer to a refusal for want
  of seats (`buy_seats_url` on `SEAT_LIMIT_REACHED`). Admins, guests and members see no
  link, and there is none on a cell that does not set it, a cell whose growth is frozen
  (buying seats would not lift the freeze), or any self-hosted install.

## [0.3.0-preview.145] — 2026-11-23 (prerelease)

Changes since `v0.3.0-preview.144`. Release scope `core` (no Hermes compatibility claim).

Upgrade notes:

- No new migration. Schema head stays `0.3.0-preview.149`; `pnpm db:upgrade --status`
  on an install already at `.144` has nothing to apply. An install on an older
  release follows the `.144` upgrade notes first (stop Deft, back up the database and
  the uploads volume, `pnpm db:upgrade`).
- No new or changed settings and no setting is removed.
- Author Kit stays `0.1.0-alpha.43`; its source is unchanged since
  `v0.3.0-preview.143`.
- Anything that relied on the old behavior of the four fixes under "Hosted launch
  fixes" below: a member or guest no longer sees the workspace's AI provider, model
  or key (`GET /api/org/ai-config`), the wiki export, agent trace and calendar feed
  downloads are no longer cacheable, and clip audio is downloaded as an attachment.

Workspace export (new command):

- A new command exports one workspace's content as a portable archive a person can
  open without Deft. It reads the database and the uploads folder directly, so it
  works while the app is stopped. It is an operator tool run from `apps/api`
  (`node --import tsx src/scripts/export-workspace.ts`), not a screen, and not a
  backup: to restore a server, use the complete recovery set in
  `docs/self-hosting.md#backups` (database, uploads and your `.env`; objects in
  external storage such as R2 too). The guide and format specification are in
  `docs/workspace-export.md` in the source tree; the standalone `self-hosting.md`
  release asset links to it, but the release does not attach it as its own file.
- Exactly one scope is required: `--member <id|email>` for exactly what that active
  person can see, or `--whole-workspace` for everything, private spaces and direct
  messages included. The export reads one consistent read-only snapshot. Database
  rows are read in batches and attachment bytes are streamed, but the set of member
  ids and the list of archive paths are held in memory, so memory still grows with
  the size of the workspace. Packing the tar needs free disk space of about twice the
  archive size, and up to about three times on a file system that cannot make hard
  links.
- The archive is one tar, written only when complete (`--folder` writes a folder);
  on a file system without hard links the final file can be seen while it is still
  being copied, so use it only after the command exits 0.
  Inside: `manifest.json` (scope, snapshot time, counts, whether it is complete, what
  is not included), `omissions.jsonl`, `SHA256SUMS` (from the extracted archive's
  root, `sha256sum -c SHA256SUMS`), `README.html` and `README.txt`, one HTML
  transcript per space, JSON Lines data files, and attachment files. Attachment
  bytes are copied only with `--single-workspace-database`, which states that this
  database **and its uploads folder** serve exactly one workspace: the command
  cannot tell leftover files of a workspace that once shared the folder from this
  workspace's own, so use the flag only when that is true. Every copied file is
  checked against its recorded size, and against its SHA-256 when Deft stored one.
- Data included: members, agents, spaces and space members; messages, replies,
  reactions and canvases; projects, labels, tasks and their comments, watchers and
  relationships; notes, folders and shares; wiki pages and links; calendar events;
  attachments; and Contacts and any other installed module, with only the fields the
  module's manifest declares.
- Not included, and listed in the archive: mail, private-assistant conversations
  (listed without text; decrypting them with `--workspace-key-file` is not built
  yet, the manifest records `supplied_not_used`), and links from module records to
  other items. Deft's own credential stores (password hashes, sessions, API and
  invite tokens, AI keys, two-step secrets) and raw metadata are not exported, but
  content people typed or attached, such as messages, notes, module fields and
  files, is exported as written. If someone pasted a password into a message, it is
  in the archive. Treat the archive as sensitive data.
- A file whose name cannot be written (long non-Latin names are cut to 180 bytes at a
  whole character) is omitted with a reason and the export carries on, marked
  incomplete. A full disk or an unwritable output still stops it.
- Not verified here: running the command inside the release container. The guide's
  `docker compose` line uses the source checkout's Compose file; on a release-assets
  install use the same `-f docker-compose.yml -f compose.prod.yml -f
  compose.release.yml` set as the rest of `docs/self-hosting.md`. Try it on a copy
  first.

Hosted launch fixes (also apply to self-hosted installs):

- `GET /api/org/ai-config` answers people who cannot change the AI settings with only
  `has_provider`, `has_reason_provider`, `hosted` and `can_manage: false`: no
  provider, model or any part of a key. Owners and admins see what they saw before,
  plus `can_manage: true`. `/setup-ai` sends everyone else to the dashboard. A
  refused transcription no longer stores the provider's answer on the clip (it can
  quote the last characters of the key); only the status code is kept. Errors stored
  on clips before this release are not cleaned and can hold the provider's full
  answer: review older failed clips, whichever transcription provider you use.
- The wiki export (`md`, `csv`, `json`), the agent trace download and the calendar feed
  send `Cache-Control: private, no-store`. Clip audio is sent as an attachment with
  `nosniff`; the player fetches it into a blob so playback is unchanged.
- Hosted first-workspace setup: every refused setup link (incomplete, expired, already
  used or for another workspace) still gets the same answer, which now says to reply to
  the email the link came in. A setup link opened on a workspace that is already set
  up no longer shows the self-hosted wording.
- When wrong two-step or recovery codes lock an account, the account holder gets an
  in-app notification, at most one a day, whatever their notification preferences are.
  The guesser's response does not change.

Apps (developer preview):

- Once the Email App's connection profile has been admitted (still done outside the
  screens), a workspace owner can get from "Email App uploaded" to the mailbox
  **Connect account** button with the screens only. The activation review reads the server's
  `action_key`; a new owner with no account yet sees the "Set up account" screen
  instead of a dead end; the first account permission asks for an end date (the server
  refuses "Until revoked" for a first enrolment) and a missing `target_key` counts as
  `primary`. The server's rules are unchanged.

## [0.3.0-preview.144] — 2026-11-19 (prerelease)

Changes since `v0.3.0-preview.143`. Release scope `core` (no Hermes compatibility
claim).

Upgrade notes:

- Schema head moves to `0.3.0-preview.149`. Stop Deft, back up the database and the
  uploads volume, and run `pnpm db:upgrade` (check first with `pnpm db:upgrade --status`
  and `--dry-run`) before starting the new version. It records three new ledger
  entries, all add-only:
  - `.144` creates `seat_statements` (used only in hosted mode);
  - `.148` gives the helper functions behind the App connection and consent CHECK
    constraints their own `search_path`, so a dump holding those rows restores;
  - `.149` creates `user_two_step`, `user_two_step_recovery_codes`,
    `two_step_challenges` and `org_member_privilege_history`.

  Sign-in and refresh read `user_two_step` on every install, so the new version
  started on a database that has not been upgraded cannot sign anyone in.
- Behind a reverse proxy other than the bundled Caddy overlay, set
  `DEFT_INVITE_TRUSTED_PROXIES` to the exact peer IP addresses, or DNS names you
  control, of that proxy. Every address-based API rate limit now counts the client
  address from forwarding headers only when the socket peer is a trusted proxy.
  Without the setting, all visitors behind your proxy share one bucket, including the
  production limit of 10 requests a minute for sign-in and refresh. The bundled Caddy
  overlay already sets it, and an API reached directly needs nothing. Startup warns
  while it is unset.
- New optional settings, off unless set: `DEFT_PAUSED_START`, `DEFT_PAUSED_REASON`
  and `PUSH_MESSAGE_PREVIEWS_ENABLED` (API), and `NEXT_PUBLIC_FEATURE_WEB_APP_INSTALL`
  (web build). See `.env.example`.
- The API now refuses to start when `DEFT_HOSTED` or `DEFT_PAUSED_START` is set to
  anything but exactly `true` or `false`, or `DEFT_PAUSED_REASON` to anything but
  `restore_review` or `billing` (an empty value, `TRUE`, `1` or a trailing space all
  refuse). Unset `DEFT_HOSTED` means self-hosted, as before.
- The hosted-only settings `DEFT_SETUP_TOKEN_SHA256`, `DEFT_SETUP_TOKEN_EXPIRES_AT`,
  `DEFT_CELL_ID`, `DEFT_SEAT_PUBLIC_KEYS`, `DEFT_SEAT_STATEMENT_URL` and
  `DEFT_SEAT_FETCH_TOKEN` stop startup when they are defined, even empty, without
  `DEFT_HOSTED=true`. Remove them from a self-hosted environment.
- A pending admin invite that an admin (not the owner) made before this release stops
  working; the owner re-sends it. Recovery links made before this release are
  refused. Any older invite link stops working at the first change to that person's
  role or active state.
- Admins can no longer change, remove or recover a person or agent who is or was an
  owner or admin; the owner does that now (see "Members, admins and agents" below).
- Outside agents that read the heartbeat prompt: new prompts list recent messages by
  reference (author, space, message id) instead of copying their text. Read the text
  with the MCP tools `fetch_unread` or `thread_fetch`. Older stored heartbeat prompts
  lose their copied text when the workers start.
- Load balancers: send traffic on `/health/ready`, not on `/health` answering 200, and
  never to an install that reports `paused: true`.
- Log alerts that match raw exception text, stacks, SQL or request paths need
  updating: API and worker logs now carry fixed event text, status codes and error
  references instead (see "Logs" below).
- Browser push subscriptions and deliveries need a public HTTPS address on port 443
  with no credentials in the URL. A custom push service that does not meet this stops
  receiving notifications.
- If browser requests to the API fail after upgrading, check `NEXT_PUBLIC_API_URL` and
  `NEXT_PUBLIC_WS_URL`: the web app's `connect-src` now allows only the page itself and
  those two origins.
- After upgrading, take a new backup and rehearse restoring it. A dump taken before
  schema `.148` that holds App connection or consent rows needs the repair under
  "Dumps taken before schema `0.3.0-preview.148`" in `docs/self-hosting.md`.
- Author Kit stays `0.1.0-alpha.43`; its source is unchanged since
  `v0.3.0-preview.143`.

Sign-in and recovery:

- Two-step verification and recovery codes. Anyone can turn it on from Settings ->
  Profile -> Security: an authenticator app (time-based 6-digit codes, RFC 6238) plus
  ten single-use recovery codes, shown once and stored as hashes. With it on, signing
  in needs the password and then a code. A password reset or recovery link does not
  remove it, and signing in with a recovery code signs out every other session.
  Self-hosted installs require it of nobody. If someone loses both their
  authenticator and their recovery codes there is no way back into that account; the
  setup screen says so.
- Invite and password-recovery links carry their one-time secret after `#`, which the
  browser does not send to a server. The pages remove it from the address bar, send
  it in the request body, and answer with `Referrer-Policy: no-referrer`. Links in the
  old form are redirected to the new one; their first request still carries the
  secret to the server and to any proxy in front of it. Invite tokens are accepted
  only when signed with HS256. Public invite routes have their own production limit
  of 10 requests a minute.
- An owner who has forgotten their password gets a recovery link from the server:
  `node --import tsx src/scripts/make-recovery-url.ts <email>` in `apps/api` (see
  `docs/self-hosting.md`). The link sets a new password only.
- A database outage while a session is checked or refreshed answers 503
  `DATABASE_UNAVAILABLE` instead of treating the credentials as invalid, so people are
  not signed out by it.

Members, admins and agents:

- Admins can still make new admins: invite a new person as admin, promote a member or
  guest, or invite as admin someone who has never been an owner or admin. Everything
  else about someone who is or ever was an owner or admin, a pending admin invite
  included, is the owner's alone: demoting, removing or deactivating them,
  re-inviting or reactivating them, reissuing or revoking their invite, and making a
  recovery link. "Was" is recorded from this release on
  (`org_member_privilege_history`); someone demoted before it is treated like any
  member. Self-hosted installs included.
- The same holds for an agent employee whose membership is, or ever was, owner or
  admin. Admins can no longer, for such an agent: reset its MCP or channel key;
  create, change or revoke an API key bound to it; create or revoke its webhooks;
  pause, resume or mark it healthy (in Settings or through the MCP tool
  `agent_employee_update_state`); reset its action budget; reassign a trigger to or
  away from it; start, check or reset its certification; retry, cancel or send test
  deliveries; edit, clone or delete it; or demote, remove or make a recovery link for
  its membership. Those calls answer 403 `FORBIDDEN`, and the settings pages disable
  the controls. Agents that are and always were member-level are managed by admins as
  before. Keys and webhooks that already exist keep working; the owner can rotate or
  revoke them.
- Changing the agent configuration of an installed workspace skill needs the owner when
  any agent with that skill installed, paused ones included, is or was an admin. An
  admin's edit that changes the configuration is refused as a whole; an edit to the
  skill's other details follows the existing rules.
- Any change to a person's role or active state ends every invite and recovery link
  made for them before it, whoever made it, and removing someone deletes their pending
  invites. A link made by an admin who has since lost the authority to make it stops
  working. Removing an agent through Members also revokes its MCP tokens, API keys and
  channel tokens and pauses it.
- Creating an API key bound to an agent in another workspace answers 404.
- Defty no longer offers the unimplemented agent-management tool; manage agents from
  their settings pages.

Spaces, messages and privacy:

- Owners, admins and members can read an active public space before joining it.
  Posting needs membership, an archived public space needs membership to read, and
  guests still see only the spaces they belong to.
- A deleted message can still appear as a placeholder, but its text, attachments,
  reactions, content-bearing metadata and link previews are gone from every answer:
  edit history, pins, search, saved messages, notifications that point at it, audit
  previews, agent message reads and reply replays. Deletion is still a soft delete.
  Text already copied elsewhere (briefs, digests, wiki pages, approved tasks, explicit
  forwards) is not removed with it.
- Notifications, Inbox items and agent activity from a private space follow current
  read access, so leaving or being removed from the space takes them away. Leaving or
  being removed also cancels your pending scheduled messages in that space (public
  spaces too), and the send worker checks membership again before sending.
- Tag counts and tagged-item lists leave out what the caller cannot read, clips follow
  the access of their source, and only owners and admins can delete a workspace tag.
- Queued assistant replies and capture proposals that cite a message check that
  message again before they are published.

Assistant and approvals:

- `POST /api/agent/actions/:id/approve` no longer answers HTTP 500 when the approved
  action fails. A final failure answers 200 with
  `{ status: "failed", message: "approved, but it did not complete", error }` (plus
  `code` for a typed refusal). A failure that can be retried answers 200 with
  `{ status: "pending", retryable: true, message, error }`. The approval card shows
  both in plain words.
- Personal MCP `approval_approve`: a final failure is still an MCP error
  (`isError: true`), now with the structured outcome above as its content; typed wiki
  refusals, which were returned as a normal result, now do the same. A retryable
  failure is a normal result with `status: "pending"` and `retryable: true`.
- Error text from a failed action is no longer passed through when it is a database or
  driver error (which carries SQL and bound values): the answer, the stored action
  error and the MCP result carry a fixed message with a reference id. The server logs
  the same reference with a fixed failure message; database error details are not
  logged.
- One assistant reply per space at a time: the job queue no longer starts an
  `agent-reply` while another for the same workspace and space is running with a live
  lease, or is older and due. An expired lease never blocks. This assumes a single API
  process claims jobs. With general job timeouts disabled or invalid, assistant replies
  keep a 120-second timeout so a hung reply stops holding its space.
- Native actions the assistant runs directly now leave a signed receipt. Personal MCP
  and API-key calls name the user behind the credential; employee calls name the
  employee. Plan approve/resume records the reviewer in each step's
  `approved_by_user_id`, which its receipt names as approver.

Paused start:

- `DEFT_PAUSED_START=true` starts an install read-only, for example to review a
  restored copy: no scheduler, no background jobs, no startup recovery work, no
  outbound calls, the agent channel and calendar feeds closed, realtime connections
  refused, and every change except login, the sign-in second step, refresh, logout and
  private onboarding bookkeeping answered 503 `PAUSED`. Restart without it (or with
  `false`) to resume. Stopping a separately run Email helper is still the operator's
  job.
- While paused, signed-in people see a banner saying the workspace can be read but not
  changed, and why: `DEFT_PAUSED_REASON` is `restore_review` (the default) or
  `billing`. The reason only chooses the text; it does not pause anything. Refused
  changes and reads show one plain message pointing at the banner instead of a generic
  error (still 503 `PAUSED`), and the realtime client stops reconnecting; reload after
  the install is resumed.
- `/health` and `/health/ready` now always include `paused`. `/health` adds
  `schema_applied` (the newest version in the upgrade ledger, cached) and
  `schema_applied_state` (`ok`, `no_ledger` or `unavailable`) beside the unchanged
  `schema_head`.

Reliability and health:

- Losing the PostgreSQL connection no longer stops the API. Idle and checked-out
  connection errors are handled, a failed connection is discarded, and the next
  checkout reconnects once PostgreSQL is reachable. A transaction that was interrupted
  still fails its caller; it is not retried for it.
- The ordinary database pool has fixed limits: 5 seconds to get a connection, 30-second
  statement timeout, 60-second idle-in-transaction timeout, and TCP keepalive.
- When job workers or the scheduler fail to start, the API keeps retrying (after 1, 2,
  4, then every 8 seconds) until they start or shutdown begins, instead of giving up
  after five attempts.
- `/health` and `/health/ready` now report `paused` (`true` under a paused start:
  `/health` still answers 200, and `/health/ready` answers 200 once its normal checks
  pass). Unchanged from 143: `/health` is a liveness check, and
  `/health/ready` answers 503 until the database and the job workers are ready. See
  "Health checks and a paused start" in `docs/self-hosting.md`.

Logs:

- API and worker logs no longer carry customer content or raw errors: no exception
  messages, causes or stacks, chat text, task or note content, prompts, provider
  replies or SQL parameters. They keep fixed event text and checked metadata (job
  names, ids, counts, status, timings).
- Request logs keep method, status and duration; paths and query strings are shown as
  `<redacted>`.
- An unhandled request error still answers 500 `INTERNAL_ERROR`, now with a
  `X-Deft-Error-Reference` header; search the logs for that value. A failed action's
  `Reference: <8 hex>` matches a `[client-safe-error]` log line.
- Fatal errors still exit with code 1 but log a fixed line
  (`[process] Uncaught exception; exiting` or `[process] Unhandled rejection; exiting`)
  instead of the raw exception. `ANTHROPIC_LOG=debug` no longer turns on SDK request
  logging, and `DEBUG` no longer prints Socket.IO or engine packet traces.

Notifications and the web app:

- Deft can be installed from a phone or desktop browser as a web app when the web image
  is built with `NEXT_PUBLIC_FEATURE_WEB_APP_INSTALL=true`: a manifest with square and
  maskable icons, and on iPhone Safari a dismissible "Share, then Add to Home Screen"
  hint. Without it the manifest is empty.
- With `PUSH_MESSAGE_PREVIEWS_ENABLED=true` at API start, chat push notifications show
  the sender, the space and up to 100 characters of plain text, rebuilt at send time
  from what the recipient can still read. Turning it on changes the text existing
  subscribers see too. Private assistant conversations, other kinds of item and
  anything that cannot be shown safely keep "Open Deft to review."
- Enabling notifications on a phone waits for the notification worker to be ready and
  recognises this browser's own subscription, so a subscription on another device no
  longer hides the Enable button.
- Queued chat notifications are delivered even when an Inbox check found them first,
  and access and preferences are checked again before sending.

Hosted mode (`DEFT_HOSTED=true` only; self-hosted installs are unaffected):

- The first signup on an empty hosted install needs a one-time setup link
  (`/signup#setup=<token>`). The install holds only the token's SHA-256 hash and an
  expiry (`DEFT_SETUP_TOKEN_SHA256`, `DEFT_SETUP_TOKEN_EXPIRES_AT`); a missing, wrong,
  expired or used token answers 403 `SETUP_TOKEN_INVALID`. Signup creates the user,
  workspace, owner membership, #general and onboarding state in one locked
  transaction on every install.
- A setup link works once, even if the database is later replaced by an empty one: a
  successful signup leaves a marker at `.setup-token-used/<hash>` on the uploads
  volume. If the marker cannot be checked or written, signup answers 503
  `SETUP_UNAVAILABLE` and creates nothing. Keep the uploads volume, including that
  directory, when recovering a database; a link whose marker was lost or that is
  marked without an owner needs a new token. A failed first signup request keeps the
  token in the page so it can be retried.
- Owners and admins must set up two-step verification before they get a session and
  cannot turn it off; making someone an admin is refused until they have turned it on.
- People added past the seat limit are refused. The install fetches a signed seat
  statement (`DEFT_CELL_ID`, `DEFT_SEAT_PUBLIC_KEYS`, `DEFT_SEAT_STATEMENT_URL`,
  `DEFT_SEAT_FETCH_TOKEN`, all required in hosted mode) and stores the newest in
  `seat_statements`. Active human owners, admins and members count, pending invites
  included; guests and agents do not. Without a valid statement nobody new can be
  added and nobody is removed. The Members page shows seats in use.
- Custom AI provider addresses, Ollama and local transcription are refused; named
  providers use their standard hosts. Push subscriptions must use a known browser push
  service. Browser origins for the API, realtime and MCP come from
  `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_API_URL` and `DEFT_PUBLIC_URL` without local
  development defaults.
- The App connections file (`DEFT_APP_CONNECTION_HTTP_CONFIG`) may carry up to four
  `hosted_templates` for `credential_form.v1` connection profiles, matched by profile
  and the caller's own authority; an exact entry always wins. A self-hosted install
  refuses a file that contains `hosted_templates`, even an empty list.

Security and dependencies:

- Apps rate limits (the App runtime channel, public App routes, resource sync, App
  connection forms and sessions, App data, integration tools, local jobs and resource
  observations) now count the trusted client address instead of the raw socket peer,
  like every other address-based limit. An IPv4-mapped IPv6 peer counts as its IPv4
  address. `X-Real-IP` is ignored everywhere.
- The web app's Content-Security-Policy narrows `connect-src` to the page itself and
  the configured API and realtime origins, and adds `form-action 'self'` and
  `base-uri 'self'`.
- Next.js 16.4.6 (advisory GHSA-mfr8-8qww-v76h).
- The dependency audit configuration carries a temporary ignore for picomatch advisory
  GHSA-fc5q-39xc-vjpf, which GitHub withdrew on 18 November 2026; the exception is
  reviewed by 2 December 2026.

Database and restore:

- `docs/self-hosting.md` lists the two supported restore commands: `psql -v
  ON_ERROR_STOP=1` for a plain SQL dump, and `pg_restore --no-owner --no-privileges
  --exit-on-error` for a custom-format dump, plus what a restore does not cover.
- Pull requests now fail when a new upgrade file is not add-only:
  `pnpm --filter @deft/db check:add-only-upgrades` refuses drops, renames, type
  changes, narrowing constraints, data rewrites, function defaults on existing tables,
  and any statement it cannot classify, and requires released upgrade files to stay
  unchanged.

## [0.3.0-preview.143] — 2026-11-14 (prerelease)

Changes since `v0.3.0-preview.142`.

Upgrade notes:

- Schema head moves to `0.3.0-preview.137`. `pnpm db:upgrade` applies one migration,
  `.137`, which creates `ics_publish_tokens` and keeps the existing calendar feed
  link of each person who has exactly one active workspace membership.
- People who belong to more than one workspace create their calendar feed link again
  from the workspace they want (Settings -> Calendar -> Share Deft calendar).
- Spaces created as Public are findable and joinable by owners, admins and members
  of the workspace through **Browse spaces**.
- Workspace audit browsing (`GET /api/audit`) is for owners and admins.
- Author Kit stays `0.1.0-alpha.43`; its code and archive are unchanged since
  `v0.3.0-preview.142`.

Calendar:

- The calendar feed link from Settings -> Calendar -> Share Deft calendar belongs to
  one person in one workspace (table `ics_publish_tokens`). People in several
  workspaces have one feed link per workspace, and creating a new link in one
  leaves the others unchanged. `GET /api/ics/feed/:token` serves only the workspace
  its link was issued in, while the person is an active member there.
- A published feed (`GET /api/ics/feed/:token`) lists live tasks only: deleted
  tasks, template tasks and tasks in archived or deleted projects are left out, and
  tasks the person may not see stay out. The feed path is shown as
  `/api/ics/feed/<redacted>` in request logs.

Chat:

- Members can find and join public spaces, the way channels work in Slack.
  **Browse spaces** in the sidebar lists the workspace's public spaces with
  search, member counts and a Join button; joining opens the space. Owners,
  admins and members can browse and join; guests see the spaces they are added
  to, and agents are added by a member. In the web app and the space REST routes,
  a space's messages, members and pins are visible after joining. API:
  `GET /api/spaces/browse` and `POST /api/spaces/:id/join`.
- **Leave space** in a space's member list removes you from a public or
  private space (`DELETE /api/spaces/:id/members/me`).
- The create-space dialog explains Public and Private in one line each.

Spaces and access:

- Guests see only the spaces they are members of in every tool and in the
  assistant's context. Owners, admins, members and agents see the public spaces of
  their workspace and the spaces they belong to.
- Message routes, bookmark saving and listing, and tag apply, remove and entity
  lists check the caller's workspace and access to the entity's space. Messages
  need access to their space; tasks, notes, daily notes and clips follow their own
  visibility. Tasks created from a message, and the tag entity list (which scans
  in bounded batches with a row cursor), apply the same rule; an entity the caller
  cannot read answers as a missing one. Checking and removing a bookmark act on the
  caller's own bookmarks in the active workspace.
- Workspace audit browsing (`GET /api/audit`) is for active owners and admins of the
  workspace. A message entry shows its text only when the viewer can read the
  message's space; otherwise it shows actor, time, action and ids with
  `content_omitted: true`.

Apps:

- A connection-session status check whose runtime request gets no answer (runtime
  unreachable, transport error, unparseable body or timeout) leaves the session's
  state and account unchanged and answers `503 APP_PROVIDER_UNAVAILABLE`. A
  definite answer keeps its outcome. The write-back happens only while the
  caller's authority and deadlines hold.

Docs and checks:

- `docs/AGENT-VISION.md` states what counts toward `max_daily_actions`: write tool
  calls, approved actions when they run, and employee chat posts.
- The v0.3.0-preview.142 notes are filed as published and the install pins point at
  that release. The Email references in `RELEASING.md` and `docs/app-boundaries.md`
  name Email release `v1.9.0-preview.32` (App `1.9.1-preview.12`, Runtime
  `0.4.0-preview.29`, Kit alpha.42, minimum Host `0.3.0-preview.138`).

## [0.3.0-preview.142] — 2026-11-13 (prerelease)

Changes since `v0.3.0-preview.141`.

Upgrade notes:

- Schema head moves to `0.3.0-preview.136`. `pnpm db:upgrade` applies five
  migrations: `.132` integration capture retirement, `.133` runtime grace resume,
  `.134` restore-access reviews, `.135` connection restore marker and `.136` an
  index on pending agent actions per workspace. The `.136` index build briefly
  holds writes to `agent_actions` while it runs.
- Scheduled GitHub sync is on by default: each connected GitHub account is synced
  every `DEFT_GITHUB_SYNC_INTERVAL_MIN` minutes (default `10`); `0` or `off` turns
  the schedule off, and manual sync still works.
- Calendar feeds and link previews are fetched only from public internet
  addresses. A self-hosted install (`DEFT_SELF_HOSTED=true`) can list exact
  internal feed URLs in `DEFT_CALENDAR_PRIVATE_URL_ALLOWLIST`.
- Plain-text `@` mentions resolve only on an exact, unique handle or one-word
  name.
- `POST /api/webhooks/github` needs `GITHUB_WEBHOOK_SECRET` (see below).
- Author Kit stays `0.1.0-alpha.43`. Its code is unchanged since
  `v0.3.0-preview.141`; the archive attached to this release differs from the one
  attached to `v0.3.0-preview.141` only in `README.md`, which carries the alpha.44
  removal notice. Consumers that pin the `v0.3.0-preview.141` archive by checksum
  keep it.

Agents and approvals:

- No trust level auto-runs a call classed as destructive; Conservative,
  Standard and Autonomous all queue those calls for approval. This
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
  target, can undo it. The action lists, receipts, dashboard activity and inbox show a Defty action only to its requester and to owners and admins; guests see only their own.
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
  messages" control, and an open thread rereads and merges its replies. "Ask Defty" reports a failure to the user. Presence snapshots replace the online list. Members see an employee's
  trust level read-only; owners and admins can lower it.
- Apps developer preview: the runtime authority check for a resource observation
  is decided in one transaction.
- Agent actions: task creation from an approved action is idempotent per action,
  and a retry notifies each assigned agent once per assignment. Undo applies
  only while the task still has the value the action set and answers with a
  conflict otherwise; it refuses action types it cannot reverse, removes the
  subtasks when a task creation is undone, and covers closing and reopening a
  task. When approve and reject race, the recorded decision is the one that was
  applied. The completion message lists succeeded and failed actions separately,
  and an approved action that failed shows as failed with its error. Task-update
  approval cards list the patched fields, including cleared values, and reminder
  previews include the date, time and time zone. A replayed App Run
  approval keeps its original approver and time. The dashboard agent widget links to the Inbox for
  review.
- Defty chat messages: tool inputs and results, proposed action parameters and
  drafts attached to a Defty message are delivered only to the person who asked,
  and owners and admins, in the message list, threads, live
  updates, the agent conversation endpoints, the trace export and the MCP read
  tools. Other members of the space see the reply text and tool names. Attention
  approval items go to the action's reviewers. The employee turn list shows
  the input, tool calls, reply text and error of a Defty turn to the person who
  triggered it and to owners and admins; other members see that the turn
  happened. The space message list pages
  toward older messages, and one plain failure reply is posted when a Defty reply
  job fails for good.
- Web: the Autonomous confirmation for an agent employee says owners and admins
  can lower the level again from the employee panel. The heartbeats page does not
  show a cost-against-budget figure, and shows the 24h cost tile only when a cost
  is recorded. "Load earlier messages" is disabled while a load or catch-up is in
  flight.
- Approvals: an approval whose request ended after it was claimed is settled. The request that executes an approval holds a
  database lock for as long as it runs; a later approve attempt or the maintenance
  job acts only when that lock is free. A task creation is run again safely
  (it is idempotent per action), and a retried action is not run twice. An approved
  action with a recorded outcome goes through one finishing step that records
  the approver decision, resolves the Attention item, issues the receipt and
  posts the completion message, and running it twice changes nothing. A native write executed through web approval gets a signed receipt.
- Run text goes to the people who may read it. Employee activity entries, employee
  diagnostics and task progress updates show their text to those people; other
  members see the entry or status without the text. Presence
  reports whether an employee has an error as a flag. A later Defty reply reads
  earlier replies as the current requester may receive them. Plan step text goes to
  the plan's requester and to owners and admins, and live plan progress carries the
  step position and status only. Heartbeat summaries and reasons are returned to
  owners and admins.
- Chat: message history pages by creation time and message id, so messages that
  share a timestamp are each returned once (a plain timestamp cursor is still
  accepted). An open thread shows reply edits and deletes live. Posting to an
  archived space through the web route answers `409` `SPACE_ARCHIVED`, as the
  other posting paths do. The @ and # popups ignore keys pressed during IME
  composition, and Enter without Shift or Tab selects while Escape closes.
- Chat: an open thread shows live edits, deletes and reactions on its parent
  message. Inserting a new line (Shift+Enter) closes an open @ or # popup, so a
  popup query never spans lines.
- Mentions: a plain `@token` becomes a mention of an agent employee only when the
  whole token equals, ignoring case, that agent's slug or its one-word display
  name, and no other agent or active human member of the workspace has that
  token. Any other token stays plain text and the post is accepted. Explicit
  mention markers and `@defty`, `@deft` and `@agent` still reach their target.
- Docs: the Apps flags section of `docs/self-hosting.md` documents flag
  dependencies and the developer preview profile.

- An agent action is reviewed by the member who requested it. Owners and admins
  review when there is no active human requester; they read another active
  member's request in activity and history. An approver assignment makes a member
  a reviewer only when this rule does. The approve and reject
  routes, the approval resolver, the personal MCP approval tools (`approval_list`,
  `approval_get`, `approval_approve`, `approval_reject`), Attention approval items
  and push delivery use this rule, and the reviewer also needs to see the
  action's room. A reviewer whose role or room access has changed is refused when
  the decision is applied.
- Approval cards and Inbox and Attention approval rows carry `viewer_can_approve`
  and `viewer_can_reject`. The card shows its buttons according to those flags and
  "Waiting for review" when neither applies. The Inbox approval list and its
  counts, the team dashboard "Approvals" count, an agent employee's pending
  count and the task handoff count cover approvals the viewer can review. The dashboard
  Agent widget shows "Review in Inbox" only on rows the viewer can review. The
  activity feeds keep their read audience.
- A stored approval result is tied to its action, so reusing an idempotency key on
  another action runs that action afresh.
- Document sends and plan imports proposed by an employee record the source
  message they were checked against, and their review follows that message's
  audience. Ordinary approve and reject check the reviewer's current role again
  when the decision is applied.
- Approved agent employee actions on tasks, task links and decisions run only when the action's
  requester can see every task they name and the decision page. A missing, deleted,
  other-workspace or hidden target gives one "not found" answer. Defty capture
  actions act for the author of the source message, who must still be able to read
  that message and see the target.
- Wiki proposals: a proposed page update is applied only while the fields it writes are
  unchanged since it was proposed and the employee can still reach the page; otherwise
  the approval ends with a message and the page is left as it is. A proposed page
  creation is made at the slug fixed when it was proposed, or not at all. A
  proposal for a space or page the employee cannot reach is refused with
  `WIKI_TARGET_UNAVAILABLE`. A failed knowledge-update capture can be retried
  only when its original proposal can be found (`409 RETRY_UNAVAILABLE`
  otherwise). Approving a wiki proposal that can no longer be applied answers
  `200` with `{ status: 'failed', message, error, code }` and one of
  `WIKI_PAGE_CHANGED`, `WIKI_PAGE_UNAVAILABLE`, `WIKI_PAGE_NOT_CREATED` or
  `WIKI_PROPOSAL_UNVERIFIABLE`, the same on every replay; the page is not written.
- Approval counts (Inbox `count_only`, the dashboard "Approvals" count, an
  employee's pending count) and the Attention approval backfill check review
  access only for each viewer's candidate actions; the counted set is the same.
  `GET /api/inbox?count_only=1` counts approvals in one aggregate query. Pending
  approval reads use an index on pending agent actions per workspace (migration
  `.136`).
- A plan created with an agent employee id (`POST /api/agent-plans`) binds only to an active agent employee of the
  caller's workspace (`400 INVALID_AGENT_EMPLOYEE` otherwise). Approve, execute,
  resume and abort are available to the plan's creator and to owners and admins;
  a plan runs for its creator. Connected (`mcp__*`) tools are available to
  workspace members, admins and owners, not to guests; a refused call makes no
  provider call and settles its action as failed.
- The daily standup and the meeting-prep brief are written from prepared evidence
  with no tools offered to the model. A draft that contains a link, approval or
  sign-off wording, or a task key or `[[deft:...]]` reference that is not in the
  evidence uses the evidence-only form, and items without `source_ids` are
  dropped. The brief is still delivered. In those cases the standup or brief appears in its evidence-only form.
- Meeting briefs are generated for, delivered to and listed for active members of
  the workspace the meeting belongs to; no brief is created for a person who is not
  active, and a stored brief is shown again if the person is reactivated.
  `GET /api/calendar/briefs` lists briefs of the session's workspace only.
- Action and work-intent reads follow their audience: an action with no source
  message or channel event is readable by its requester and by owners and admins. A workflow run
  stores a bounded error message with the code `WORKFLOW_ACTION_FAILED`. A work
  intent's status changes only through its own capture action.
- The `space:created` event carries only the space id; clients load the space
  through `GET /api/spaces`.

Workspace isolation:

- Realtime rooms and presence are per workspace. A person who belongs to two
  workspaces shows as online only in the workspace where their session is
  connected, and per-user events reach only that workspace's sockets.
- Note folders, note shares and space actions check the caller's current
  workspace. Note shares are limited to active members of the workspace. Guests
  do not receive the workspace standup, recent activity follows task
  visibility, and the unread notification count is per workspace.

- Task events sent to the whole workspace (`task:created`, `task:updated`,
  `task:deleted`, `task:bulk_updated`, `task:reaction_changed`) carry identifiers
  and the names of changed fields. The task list, calendar and module views read
  the task through the access-checked endpoints when an event arrives, with
  reloads coalesced. The shared daily standup is returned to members when it was
  built for all members; owners and admins can always read it.

Requests, triggers and outbound fetches:

- Every request under `/api` needs a valid web session unless its path is
  exempt (CORS preflight is answered by the CORS policy): auth, MCP, Agent
  Channel, metrics, webhooks, invites, App developer pairing, App Runtime
  channels, public App ingress, the App runtime operator routes,
  `POST /api/agent-webhooks/:slug` and `GET`/`HEAD /api/ics/feed/:token`, which
  use their own authentication or are intentionally public. A path containing a control character, DEL or a
  backslash, literal or percent-encoded, is refused with `400 INVALID_PATH`.
- API key and MCP connection management check the caller's owner or admin role in
  each handler (`403 FORBIDDEN` for members and guests). `POST /api/upload`
  refuses a caller with no user with `401` before reading the file.
- `POST /api/webhooks/github` needs `GITHUB_WEBHOOK_SECRET`; without it the
  endpoint answers `503 GITHUB_WEBHOOK_NOT_CONFIGURED`. With it, requests need a
  matching `x-hub-signature-256`. A signed merged-PR delivery is acknowledged and
  dispatches nothing; merged PRs close their `PREFIX-N` tasks through the
  per-workspace GitHub sync, which stores and updates its events within the
  syncing workspace.
- The per-workspace GitHub sync runs on a schedule: a `github-sync-scan` job every
  minute queues connected GitHub accounts that are due (at most 10 per minute),
  each synced every `DEFT_GITHUB_SYNC_INTERVAL_MIN` minutes (default `10`; `0` or
  `off` disables the schedule). Failures back off and rate limits wait for
  GitHub's reset. Manual sync is unchanged.
- Trigger jobs for an event (`trigger-dispatch`, `employee-trigger`,
  `agent-employee-trigger`) and `workflow-execute` jobs carry their workspace and
  reach only that workspace's
  employees, stored triggers, spaces and workflow rules. Workflow `assign_to` and
  `notify` actions address only active members of the rule's workspace, and
  `unblock_dependents` notifies only active members. Agent webhooks are managed
  (`POST` and `GET /api/agent-webhooks`, `DELETE /api/agent-webhooks/:id`) by owners and admins.
- An agent employee's queued proposals can cite the chat message they answer:
  `task_create`, `task_update`, `send_message`, `message_post`, `wiki_create`,
  `wiki_update` and the module record write tools take an optional
  `source_message_id`, and `request_human_approval` takes it in `params`. The
  message must be live, in the workspace and in a room the employee belongs to.
  While the employee is handling the delivery of a message, a call citing a
  different message is refused (`cited message is not the delivery being
  handled`). A citation does not change whether a call needs approval. When the
  server recorded that the message's author, then a non-guest member, addressed
  that employee with it, the proposal is not tied to another delivery or room and
  was made within 24 hours, and the author is now an active human member, not a
  guest, who can read the room, the author reviews the proposal; the proposal is also
  reviewed only by people who can read that room. A wiki proposal whose cited
  message the write could not use as its source is refused with
  `WIKI_SOURCE_MESSAGE_ROOM`. The bundled `deft-mcp-client` skill and the Hermes
  bridge prompt tell agents to cite the message they answer.
- The personal MCP approval tools (`approval_approve`, `approval_reject`) run the
  same decision functions as the web routes.
- Approval rows in the Inbox, Attention and the dashboard carry
  `viewer_can_approve` and `viewer_can_reject` for App Run approvals that follow
  the App Run release rules; at most 10 rows per response get the live approve
  check, and later rows leave `viewer_can_approve` out.
- Calendar feeds (preview, create and sync) and link previews fetch only from
  public internet addresses: `http` or `https` URLs (`webcal` for feeds) on ports 80 and 443
  without userinfo, every DNS answer public, the connection pinned to the
  validated address, at most three redirects each re-checked, and a body size and
  time limit (5 MB and 20 seconds for feeds, 512 KB and 5 seconds for previews).
  A feed that cannot be reached answers `Could not reach the feed URL.`.
- Self-hosted operators can list exact internal calendar feed URLs in
  `DEFT_CALENDAR_PRIVATE_URL_ALLOWLIST` (a JSON array; honoured only when
  `DEFT_SELF_HOSTED=true`). A listed URL may use its own port and resolve to
  loopback, RFC 1918 or IPv6 unique-local addresses; cloud metadata addresses are
  always refused. Matching is by the whole URL, redirects are followed only to
  another listed URL, and a malformed value disables the list. See
  "Internal calendar feeds" in `docs/self-hosting.md`.
- Calendar feed routes answer an unexpected failure with a fixed `{ error, code }`
  that carries no feed URL or id, and the logged message does not include feed URLs
  or tokens.
- IPv4-mapped IPv6 addresses (dotted or hex form) are classified by their IPv4
  address in connector URL validation and the public-only fetch, so a mapped cloud
  metadata address is always refused.
- Link preview metadata is extracted on a worker thread, one page at a time with
  at most 16 waiting; a page whose extraction does not finish within 2 seconds
  gets no preview.

CI and security checks:

- The API tests run as four parallel shards (`Test API (shard n/4)`), each on its
  own runner and database. `DEFT_API_TEST_SHARD=i/n` selects a shard in
  `scripts/email-preview-api-tests.mjs` and defaults to `1/1`, which runs the whole
  suite. A `Test API` job passes only when every shard passed, so the required
  check name and Build's dependency are unchanged. The shards start alongside Type
  Check once the release-scope and app-boundary jobs finish; Build still needs Type
  Check and every shard.
- CodeQL reviewed findings use manifest v2 (`deft.codeql_false_positives.v2` in
  `.github/codeql-reviewed-false-positives.json`). An entry matches on rule, path
  and a fingerprint of the code on the flagged path, so edits that only move the
  finding do not need a new review, while a change to the code on the path, a new
  finding, a duplicate or an unused entry fails the check. See
  `docs/security/codeql-reviewed-findings.md`.
- Pull requests that change only Markdown files under `docs/superpowers/` skip
  Type Check, the API test shards, Build, Versioned Upgrade, Production Image +
  Browser Smoke and the Hermes gate; every required check name still reports. A
  `Changed Paths` job classifies the pull request, and any other change runs every
  job.

- API tests: the affected tests create their own fixture rows, the recovery
  sweep tests wait out a busy advisory pool, and the restore-access fixture
  computes its timestamps once, so the sharded run does not depend on file order.

Dependencies:

- `@hono/node-server` 2.1.5 to 2.1.7 (GHSA-qv5m-9pm6-hqp3, GHSA-jpvv-r467-5p4w).
- `hono` 4.13.18 (GHSA-4m76-xfj5-7975, GHSA-h7mg-cq63-vhpq, GHSA-3gg2-335m-rxc6).

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

- Space membership checks apply within the caller's current workspace.

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

[Unreleased]: https://github.com/Maneek21/Deft/compare/v0.3.0-preview.147...HEAD
[0.3.0-preview.147]: https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.147
[0.3.0-preview.146]: https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.146
[0.3.0-preview.145]: https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.145
[0.3.0-preview.144]: https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.144
[0.3.0-preview.143]: https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.143
[0.3.0-preview.142]: https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.142
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
