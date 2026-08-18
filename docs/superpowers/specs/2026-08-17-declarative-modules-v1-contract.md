# Declarative Modules v1 Contract and Threat Model

**Status:** Accepted for the Phase 0–2 module vertical slice  
**Date:** 2026-08-17  
**Contract implementation:** `packages/shared/src/modules.ts`

## Decision

Deft modules v1 are portable, declarative JSON artifacts named
`deft.module.json`. A manifest describes one module and between one and eight
record collections. Deft owns storage, rendering, validation, search, access
control, audit, approval, and realtime behavior.

A module is not an agent Skill. It cannot execute code or grant an agent a new
external capability. The same parsed manifest and the same actor-aware module
service must drive the native UI, Defty, human MCP, employee MCP, REST, and
universal search. An adapter must not implement its own record validation,
authorization, search projection, or mutation semantics.

The contract is strict and closed. Unknown properties are errors. This keeps
the first public format deterministic and prevents an accidental feature from
becoming a permanent compatibility promise.

## V1 manifest

```json
{
  "schema_version": "1",
  "id": "community.deft.contacts",
  "slug": "contacts",
  "version": "1.0.0",
  "name": "Contacts Directory",
  "description": "A shared directory of people and companies.",
  "icon": "contact-round",
  "collections": [
    {
      "key": "contacts",
      "name": "Contacts",
      "singular_name": "Contact",
      "fields": [
        {
          "key": "name",
          "label": "Name",
          "type": "text",
          "required": true
        },
        {
          "key": "company",
          "label": "Company",
          "type": "text"
        },
        {
          "key": "email",
          "label": "Email",
          "type": "email"
        },
        {
          "key": "status",
          "label": "Status",
          "type": "single_select",
          "options": [
            { "value": "lead", "label": "Lead" },
            { "value": "customer", "label": "Customer" }
          ],
          "default": "lead"
        }
      ],
      "search": {
        "title_field": "name",
        "subtitle_fields": ["company", "email"],
        "fields": ["name", "company", "email", "status"]
      },
      "views": [
        {
          "key": "all_contacts",
          "name": "All contacts",
          "type": "table",
          "fields": ["name", "company", "email", "status"]
        }
      ]
    }
  ]
}
```

`id` is a stable reverse-DNS identifier. `slug` is a user-facing routing token.
Changing either creates a different installation identity; labels may change in
a later immutable version.

V1 field types are:

- `text`, `long_text`
- `number`, `boolean`
- `date`, `datetime`
- `email`, `url`
- `single_select`, `multi_select`

Dates use `YYYY-MM-DD`. Datetimes must be ISO 8601 with an explicit timezone.
URLs must be absolute HTTP or HTTPS URLs. Select records store stable option
values, while the UI and search projection show their labels.

Views are presentation hints for Deft's generic renderer. They do not contain
queries, code, permissions, components, or routes. If views are omitted, the
runtime may derive a default table, form, and detail surface from the fields.

The exported JSON Schema is an authoring aid. The shared Zod parser remains
authoritative because JSON Schema does not completely express cross-field
references, uniqueness, valid select defaults, or the search-title invariant.

## Limits

The shared `MODULE_LIMITS` object is normative. Important limits are:

- Manifest: 128 KiB UTF-8 JSON.
- Collections: 1–8 per module.
- Fields: 1–64 per collection.
- Select options: at most 50 per field.
- Views: at most 8 per collection and 32 fields per view.
- Search: at most 16 projected fields and 3 subtitle fields.
- Record: 256 KiB after defaults are applied.
- Search projection: 200-character title, 300-character subtitle, and 10,000-character text.

Record values are rejected when they exceed their declared limit; they are
never silently truncated. The derived search projection is deliberately
bounded without modifying the source record.

## Search contract

Search is opt-in for each collection. A collection without a `search` block is
not placed in universal search or automatic Defty retrieval.

`title_field`, every subtitle field, every indexed field, and every view field
must reference a declared field. The title field must be required or have a
default. Title and subtitle fields must also appear in `search.fields`.

Only the declared `search.fields` enter the search projection. Deft must not
serialize the entire record JSON into an index. `projectModuleRecordSearch` is
the shared implementation for projection semantics, including select labels
and bounds. Search snippets are plain text and must be escaped by renderers.

The canonical cross-surface record identifier is
`module_record:<record_id>`. Universal search, MCP fetch, Defty citations, audit
events, deep links, and receipts must refer to the same record identity.

## Record validation

`validateModuleRecordData(manifest, collectionKey, data)` is the canonical pure
validator. It:

- rejects undeclared fields;
- rejects missing required fields;
- applies manifest defaults without mutating the caller's object;
- validates primitive types, finite numbers, option membership, email, URL,
  date, and datetime values; and
- enforces the record byte limit.

It returns a discriminated success/failure result. `parseModuleRecordData`
provides a throwing variant.

Record data does not use `null` to clear optional fields. An update has a
`patch` and an explicit `unset_fields` array. At least one must be non-empty,
the unset list must be unique, and a field cannot be patched and unset in the
same operation. Runtime validation must also reject attempts to unset a
required field unless applying its declared default produces a valid record.

## Version and concurrency invariants

Every installed manifest version is immutable. Its identity is the canonical
manifest JSON hashed as `sha256:<lowercase hex>`. Canonicalization sorts object
keys, preserves array order, emits normalized Unicode strings, and materializes
schema defaults before hashing. Reusing the same `(module_id, version)` with a
different digest is a conflict, not an update.

All writes carry `expected_manifest_digest`. The runtime must compare it with
the installation's active version immediately before mutation. A proposal made
against a stale schema fails safely instead of being reinterpreted.

Updates and archives also carry `expected_revision`. A mismatch is an
optimistic-concurrency conflict. Records start at revision 1, and each accepted
mutation increments the revision once.

Create always requires an idempotency key. MCP and other remote adapters must
also require idempotency keys for update and archive, even though the
transport-neutral schemas leave those two keys optional for local UI actions.
Replaying a completed key returns the original result and must not create a
second audit event, receipt, revision, or socket notification.

The minimal mutation receipt is an immutable audit anchor and retains a
restricting reference to its `agent_actions` row. Generic action-history
pruning must therefore retain actions referenced by module mutation receipts
(or archive both records together under a future explicit retention policy);
it must never silently break the mutation-to-approval trace.

Archive is the v1 delete operation. It is a soft delete, is classified as
destructive, and requires full review for agents. Permanent purge is not a v1
operation.

## Generic operation vocabulary

All adapters expose or invoke the same eight operations:

| Operation | Mode | Default approval | Destructive |
|---|---|---:|---:|
| `module_list` | read | auto | no |
| `module_schema_get` | read | auto | no |
| `module_record_search` | read | auto | no |
| `module_record_query` | read | auto | no |
| `module_record_get` | read | auto | no |
| `module_record_create` | write | quick | no |
| `module_record_update` | write | quick | no |
| `module_record_archive` | write | full | yes |

There are no per-module tool definitions. The shared request/result schemas
are used to generate tool input contracts for Defty and MCP and to validate
the corresponding service results.

Mutation tool results and durable receipts are deliberately minimal. They
contain record/resource identity, installation and collection identity, the
manifest digest, resulting revision, archive state, changed field names, and
whether the request was replayed. They never contain the record `data` object.
The native UI may receive a full record from an authenticated REST mutation,
but agent actions, idempotency receipts, and broad audit stores must not copy
CRM or other future sensitive values merely to report success.

`module_record_query` accepts only the typed filter operators in the shared
contract. The API compiles these to parameterized Drizzle expressions. Neither
manifests nor callers can supply SQL, JSON paths, sort expressions, or search
configuration directly.

## Actor and authorization boundary

The manifest contains no read/write capabilities, permission flags, roles,
trust levels, approval tiers, secrets, or scopes. A manifest therefore cannot
grant itself access.

The runtime constructs a validated `ModuleActor` from an authenticated
principal:

- a human using the UI, REST, or human MCP;
- Defty acting for an authenticated human;
- an agent employee using MCP or its runtime; or
- a narrow system job.

Parsing an actor does not authorize it. The module service applies installation
policy, membership, MCP scopes, employee trust, disabled tools, approvals,
budgets, and audit rules after authentication.

V1 module records are organisation-wide for owners, admins, and members.
Guests are denied. There are no private collections, rows, or fields in v1.
This is an explicit product boundary: payroll, medical, disciplinary, secret,
and other restricted datasets must not be shipped as v1 modules.

Installation, enable, disable, and future version switching are owner/admin
actions. Ordinary members may read and mutate records in enabled installations
through governed surfaces. A disabled installation's records and data are
inaccessible through native record UI, search, Defty, MCP, and record REST
routes while retaining their storage. Owners and admins may still see the
minimal installation metadata in the lifecycle control plane so they can audit
or re-enable it; that surface never returns module records.

## Threat model

### Untrusted manifest text and prompt injection

Module names, descriptions, labels, option labels, and record values are
author-controlled untrusted data. The parser bounds manifest text and rejects
markup delimiters, control characters, invisible bidi controls, and multiline
display metadata. This reduces spoofing and rendering hazards; it does not make
natural language trustworthy.

Agent context must quote module metadata as data, identify its source, and
explicitly state that it is not instruction text. Manifest descriptions must
never be appended to a system prompt as instructions, used to generate tool
policy, or allowed to alter approval tiers. Defty receives compact schemas and
retrieved records, never an unconditional dump of every module record.

### Code and network execution

V1 accepts JSON only. It contains no JavaScript, TypeScript, React, HTML, CSS,
SQL, templates, expressions, workers, webhooks, URLs for assets, package names,
commands, imports, secrets, or outbound network destinations. Sideloading is a
local JSON upload; it must not fetch an author-provided URL.

### Tenant isolation and confused deputy attacks

Every service query includes the actor's `org_id`; record, installation, and
version relations use same-organisation constraints. Caller-supplied org IDs
are ignored. Cross-organisation identifiers return not-found rather than
revealing existence.

Human MCP requires explicit `read:modules` and `write:modules` scopes. Existing
tokens are not silently expanded. Employee writes remain subject to trust,
approval, disabled-tool, budget, receipt, and health rules. Conservative agents
may discover write operations and propose them, but cannot bypass approval.

### Integrity, replay, and audit

Record mutation, record revision, search projection, and mandatory audit data
commit atomically. Socket notification occurs after commit. Audit metadata may
include changed field names and resource IDs, but broad audit views must not
copy potentially sensitive record values. Agent mutations also retain their
normal action and receipt linkage.

The active manifest digest prevents time-of-check/time-of-use schema changes;
the record revision prevents lost updates; idempotency prevents remote retries
from duplicating writes.

### Rendering and search

All manifest strings and record values render as escaped text. `icon` is a
bounded token resolved through a Deft-owned allowlist, never a URL or markup.
URL values open only after HTTP/HTTPS validation and with the normal external
link protections. Search indexes only explicit fields and search results are
filtered against enabled, non-archived, same-organisation records before
returning them.

## Explicitly deferred

The following are intentionally outside v1:

- relations between records or modules;
- files, member references, rich text, formulas, computed fields, and custom
  field types;
- row-, collection-, or field-level permissions;
- module-provided code, UI components, themes, routes, prompts, tools, SQL,
  migrations, workers, triggers, network calls, OAuth, or secrets;
- user-authored filters, formulas, arbitrary sort expressions, or raw JSON-path
  queries;
- automatic upgrades, author migrations, rollback UI, and permanent purge;
- remote install-by-URL;
- registry signing, moderation, reviews, payments, and hosted marketplace
  mechanics; and
- an in-Deft module builder.

External coding assistants can produce the strict JSON artifact using the
published contract. Deft validates and runs that artifact; it does not execute
the assistant's generated application code.

## Phase 0–2 acceptance gate

The first Contacts Directory vertical slice is complete only when one record
can be created through Defty, found through universal search, fetched through
human MCP, updated through an employee MCP approval, observed in the native UI,
and traced through audit and receipt records. Disabling the installation must
hide its records from every data surface (while preserving admin lifecycle
metadata), and re-enabling must restore the unchanged data.

Before public sideloading, Equipment Register and Content Calendar must be
implemented as manifests without module-specific backend, Defty, MCP, search,
or UI code. Requiring such code means the shared contract is incomplete and is
a stop-and-repair signal, not permission to add an adapter-local exception.
