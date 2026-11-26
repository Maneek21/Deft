# Workspace export

A workspace export is a copy of one workspace's content that a person can open
on an ordinary computer and a program can load, without Deft. It is written by
a command that reads the database and the uploads folder directly, so it works
while the app is stopped: a workspace that is read-only, suspended or shut
down can still be exported.

It is not a backup. To restore a server, use the Postgres, uploads and
configuration backups described in [self-hosting](self-hosting.md#backups).

## Running it

The command needs a database connection, the uploads folder, the workspace
(its id or slug), one scope, and where to write.

```bash
cd apps/api
DATABASE_URL=postgres://... node --import tsx src/scripts/export-workspace.ts \
  --workspace acme \
  --uploads /app/uploads \
  --member owner@example.com \
  --single-workspace-database \
  --out /exports/acme-2026-12-01.tar
```

With Docker Compose, the database must be running; the app need not be:

```bash
docker compose up -d postgres
docker compose run --rm --no-deps --entrypoint sh -v "$PWD/exports:/exports" deft -c \
  "cd /app/apps/api && node --import tsx src/scripts/export-workspace.ts \
   --workspace acme --uploads /app/uploads --member owner@example.com --single-workspace-database --out /exports/acme.tar"
```

| Option | Meaning |
|---|---|
| `--workspace <id or slug>` | The one workspace to export. |
| `--uploads <folder>` | Deft's uploads folder (`/app/uploads` in the container). |
| `--member <user id or email>` | Export exactly what this active person can see in Deft. |
| `--whole-workspace` | Export everything, including every private space and direct message. It must be given explicitly. |
| `--out <file.tar>` | The tar file to write: an ordinary file name ending in `.tar`, which also names the folder inside it. It must not exist, and the command never replaces a file that appears while it runs. Add `--folder` to write a folder instead. |
| `--single-workspace-database` | States that this database holds exactly one workspace. Only then are attachment files copied, and the export stops if the database shows any other workspace. Without it, attachments are listed without their bytes. |
| `--database-schema <name>` | The schema Deft's tables are in (default `public`). The export reads that schema alone and refuses to run unless every table it reads is a plain table there. |
| `--workspace-key-file <path>` | Optional. Says that the workspace's key is available. This version records that fact in the manifest but does not decrypt. |
| `--database-url <url>` | Instead of `DATABASE_URL`. A URL on the command line is visible to other users of the machine. |

Exactly one of `--member` and `--whole-workspace` is required. The command
reads one consistent snapshot of the database. It needs free disk space for
the archive twice over while it packs the tar. It exits 2 for a usage error and
1 for a failed export, and leaves no partial tar behind. Error messages never repeat a URL, so a database password passed by mistake is not printed.

### Attachment files

Attachment bytes are copied only with `--single-workspace-database`: the
operator states that this database, and its uploads folder, serve exactly one
workspace. A hosted workspace always does, so the hosted export always passes
it. With the flag, the export first checks every table of the schema for any
trace of another workspace and stops, before copying anything, if it finds
one. That check cannot tell who wrote bytes on disk that no row describes, so
the statement is the operator's: use the flag only when the uploads folder
serves this database alone.

What you assert with the flag, and what can go wrong if it is false: you say
that every file in the uploads folder belongs to this database's one
workspace. If another workspace once shared the folder and its rows were
removed from the database, its leftover files cannot be told apart. A file
this workspace's rows name would then be copied even if another workspace
wrote it. If another workspace still has rows in the database, the export
stops instead of copying. Without the flag, every attachment is listed in
`files.jsonl` and `omissions.jsonl` with the reason, and the README says so.
A database holding several workspaces is exported without attachment files.

Run it against a stopped app when you can. Against a running app the database
rows still describe one moment, but a file deleted or replaced while the
export runs is reported as not included rather than copied.

## What is in the archive

```
<name>/
  README.html, README.txt   what this is: scope, time, counts, what is not included, what could not be
  manifest.json             the machine-readable index
  data/                     the content, as JSON Lines (one JSON object per line, UTF-8)
  attachments/<file-id>/<original file name>
  conversations/            one readable page per space, and an index
  documents/<document-id>.md  each document as Markdown, its title as the first heading
  mail/README.txt           reserved for mail; this command does not export mail
  omissions.jsonl           every item in scope that could not be included, and why
  SHA256SUMS                checksums of every other file: `sha256sum -c SHA256SUMS`
```

The format is `deft.workspace_export.v1`. Times are ISO 8601 in UTC. Ids are
Deft's own, so records refer to each other by id. An attachment's file name in
`attachments/` is its original name, with characters no file system accepts
replaced and, past 180 bytes, cut at a whole character with its extension
kept; if the file system still refuses it, `file` and the extension are used.
`files.jsonl` keeps the original name in `filename` and the name used in
`archive_path`. Text is exactly as it was
written: message text in Markdown, note bodies in the editor's HTML, wiki
pages in Markdown, documents and their versions in the editor's JSON. In a
document's Markdown copy, an image of a Deft file is written as
`![alt](deft-file:<file id>)`; the file is listed in `files.jsonl`.

### Data files

| File | One line per | Fields |
|---|---|---|
| `workspace.json` | (one object) | `id`, `name`, `slug`, `timezone`, `created_at` |
| `members.jsonl` | person, guest or agent | `user_id`, `name`, `email`, `kind` (`human`/`agent`/`system`), `role`, `is_active`; whole workspace also `title`, `joined_at` |
| `agents.jsonl` (whole workspace) | agent employee | `id`, `user_id`, `name`, `job_title`, `expertise_description`, `is_active`, `created_at` |
| `spaces.jsonl` | space | `id`, `name`, `description`, `topic`, `type` (`public`, `private`, `dm`, `group_dm`, `agent_conversation`), `is_default`, `is_archived`, `created_by`, `created_at`, `updated_at` |
| `space_members.jsonl` | membership | `space_id`, `user_id`, `joined_at` |
| `messages.jsonl` | message or reply | `id`, `space_id`, `parent_id`, `parent_missing`, `user_id`, `content`, `content_omitted`, `is_pinned`, `edited_at`, `created_at`, `updated_at` |
| `reactions.jsonl` | reaction | `message_id`, `user_id`, `emoji`, `created_at` |
| `canvases.jsonl` | space canvas | `space_id`, `title`, `content` (editor JSON), `last_edited_by`, `last_edited_at`, `created_at`, `updated_at` |
| `projects.jsonl` | project | `id`, `name`, `description`, `prefix`, `icon`, `color`, `lead_id`, `is_archived`, `is_deleted`, `created_at`, `updated_at` |
| `labels.jsonl` | label | `id`, `name`, `color`, `created_at` |
| `tasks.jsonl` | task | `id`, `project_id`, `reference` (such as `ENG-12`), `number`, `title`, `description`, `status`, `priority`, `assignee_id`, `created_by`, `due_date`, `start_date`, `estimation`, `recurrence`, `is_template`, `parent_task_id`, `visibility`, `created_at`, `updated_at` |
| `task_assignees.jsonl`, `task_watchers.jsonl` | link | `task_id`, `user_id`, `created_at` |
| `task_labels.jsonl` | link | `task_id`, `label_id` |
| `task_relationships.jsonl` | link | `id`, `source_task_id`, `target_task_id`, `type`, `created_at` |
| `task_reactions.jsonl` | reaction | `task_id`, `user_id`, `emoji`, `created_at` |
| `task_comments.jsonl` | comment | `id`, `task_id`, `user_id`, `content`, `created_at`, `updated_at` |
| `note_folders.jsonl` | folder | `id`, `user_id`, `name`, `icon`, `parent_folder_id`, `sort_order`, `created_at`, `updated_at` |
| `notes.jsonl` | note | `id`, `user_id`, `folder_id`, `title`, `content` (HTML), `icon`, `is_pinned`, `is_template`, `visibility`, `visibility_space_id`, `created_at`, `updated_at` |
| `note_shares.jsonl` | share | `note_id`, `shared_with_user_id`, `permission`, `created_at` |
| `wiki_pages.jsonl` | page | `id`, `scope`, `space_id`, `type`, `title`, `slug`, `summary`, `content`, `tags`, `user_id`, `created_via`, `version`, `created_at`, `updated_at` |
| `wiki_links.jsonl` | link | `source_page_id`, `target_page_id`, `context`, `created_at` |
| `events.jsonl` | event | `id`, `source`, `event_type`, `title`, `body`, `url`, `actor`, `timestamp`, `user_id`, `start`, `end`, `all_day`, `location`, `status`, `attendees` (`email`, `name`), `recurrence` (`start`, `end`, `rrule`, `recurrence_id`, `exdates`), `created_at`, `updated_at` |
| `drives.jsonl` | drive | `id`, `name`, `icon`, `kind` (`open`, `private`, `personal`), `owner_user_id` (a personal drive's owner), `default_role` (an open drive's), `agent_suggest_only`, `knowledge_default`, `frozen_at`, `created_by`, `created_at`, `updated_at` |
| `drive_members.jsonl` | drive member | `drive_id`, `principal_type` (`user` or `space`), `principal_id`, `role` (`full`, `edit`, `comment`, `view`), `is_link`, `added_by`, `created_at` |
| `doc_folders.jsonl` | folder in a drive | `id`, `drive_id`, `parent_folder_id`, `name`, `position`, `created_by`, `created_at`, `updated_at` |
| `documents.jsonl` | document | `id`, `drive_id`, `folder_id`, `parent_document_id` (a sub-page's page), `title`, `icon`, `position`, `content_json` (editor JSON), `is_template`, `created_by`, `last_edited_by`, `last_edited_at`, `created_at`, `updated_at` |
| `document_shares.jsonl` | share | `document_id`, `principal_type`, `principal_id`, `role` (`edit`, `comment`, `view`), `shared_by`, `created_at` |
| `document_versions.jsonl` | saved version | `id`, `document_id`, `kind` (`auto`, `named`, `agent`, `restore`, `import`, `moved`), `name`, `title`, `content_json` (null when its content was removed from history), `size_bytes`, `created_by`, `agent_user_id`, `content_removed_at`, `created_at` |
| `document_attachments.jsonl` | file a document uses | `document_id`, `file_id`, `in_current` (false for a file only older versions show), `added_by`, `created_at` |
| `files.jsonl` | attachment | `id`, `filename`, `mime_type`, `size_bytes`, `sha256` (of the bytes in this archive, or null), `recorded_sha256` (Deft's own, may be null), `uploaded_by`, `created_at`, `attached_to` (`{message_id}`, `{task_id}` or null), `included`, `archive_path` |
| `modules.jsonl` | installed module (such as Contacts) | `id`, `module_id`, `slug`, `source`, `is_enabled`, `version`, `folder`, `created_at` |
| `modules/<slug>/schema.json` | (one object) | the module's collections and their fields: `key`, `label`, `type`, `required`, `multiple`, `options`, `target_collection` |
| `modules/<slug>/collections/<collection>.jsonl` | record | `id`, `collection`, `revision`, `fields` (only fields the module declares), `created_at`, `updated_at` |
| `modules/<slug>/relations.jsonl` | link between records | `field`, `source_record_id`, `target_record_id`, `position`, `created_at` |

A user id names someone in the workspace; an id that would name anyone else is
written as `null`. `parent_missing` is true when a reply's message was deleted
or is outside the scope.

### manifest.json

`format`, `format_version`, `generator`, `workspace`, `scope` (`{kind:
"workspace"}` or `{kind: "member", user_id, role}`), `as_of` (the start of the
database snapshot), `database_schema` (the one schema read), `workspace_key`
(`not_supplied` or `supplied_not_used`), `attachments`
(`single_workspace_declared`, `files_copied`), `complete` (false when anything
in scope was left out), `omissions` (how many), `datasets` (each file and its
record count) and `not_included`.

## What is not in it

- Mail. A separate mail export fills the `mail/` folder.
- Anything that was deleted, unsent scheduled messages, and reminders. A
  document in a drive's trash, or in a deleted drive, is deleted; so is the
  note it was moved from, once the document is deleted.
- Notifications, agent actions and approvals, agent run history, AI memory,
  generated briefings and standups.
- Every credential and secret Deft stores: passwords, sessions, tokens, API
  keys, invite and recovery links, two-step secrets, integration settings and
  connected accounts. Text that people typed into messages, notes or other
  content is exported as written, even if it contains a password.
- Personal preferences and version history, except the saved versions of
  documents.
- A document's live-editing state. Its content is in `documents.jsonl` and
  `documents/`.
- Links from module records to other Deft items, such as tasks.
- The records of a module that has no active version, or whose stored
  manifests fail their integrity check, as Deft would not show them either.
  Such a module is listed in `omissions.jsonl`.
- The text of private assistant conversations, which is encrypted with the
  workspace's key. They are listed in `omissions.jsonl`.

An attachment is left out, with its reason in `omissions.jsonl` and
`included: false` in `files.jsonl`, when:
- the export was run without `--single-workspace-database`;
- the safety check blocked it;
- it is missing from the uploads folder;
- its bytes do not match the recorded size or checksum;
- it is not a regular file inside the uploads folder;
- the stored file cannot be read (for example, its permissions forbid it);
- the file system the export is written to refuses the characters of its name, even as a plain `file` name. An output path too long to hold attachment files stops the export instead;
- its stored name is also used by another workspace;
- it is linked to more than one item.

## Scope

`--member` uses the same rules Deft uses for that person:
- spaces they belong to, and public spaces (not for guests);
- tasks they may see;
- notes they own, notes shared with them or with their spaces, and notes
  visible to the whole workspace;
- wiki pages they may read;
- the documents they can open, the drives they can view and those drives'
  folders. A document's folder or parent page is named only when they can see
  it. Of drive members and shares, only the rows that name them;
- the saved versions of the documents they can edit, and files that only
  older versions show. Never for a guest, whatever their role;
- their own calendar;
- installed modules, which guests do not see and which nobody sees while
  disabled.

`--whole-workspace` includes everything regardless of who could see it. The
manifest and README record which scope was used.
