# Deft Attachment System Decision

**Date:** 2026-08-28
**Status:** Accepted for staged implementation
**Baseline:** `7a20e4fcd4316690f7ee91a00b10f3406429cf70` on `codex/hermes-native-certification`
**Revisit:** After the full sender/recipient matrix passes on `demo.deft.ing`

## Problem and outcome

Deft persists uploaded files and authorizes their message or task, but the
browser renders protected file URLs directly. Browser image and link elements
cannot attach Deft's bearer token, so a user can see attachment metadata while
the bytes fail to load. Defty reads only bounded text-like attachments, Agent
Channel and employee MCP omit attachment manifests, and agents cannot create
or attach files.

Deft will own one attachment system for people, Defty, and external employees.
People and agents will cross the same organization-, space-, project-, and
resource-visibility boundary. Stock Hermes will use Deft tools and a bundled
Deft skill; Hermes core, a Hermes fork, and a Hermes pull request are outside
the solution.

## Invariants

- Every persisted file and attachment link is organization-scoped.
- Access is derived from current message, task, or future resource visibility;
  a permanent storage URL is never authorization.
- The browser and every agent reauthorize each file read through Deft.
- File names, MIME declarations, extracted text, workbook cells, and image
  descriptions are untrusted external input.
- Agent-created files and mutations retain trust levels, approvals, action
  budgets, idempotency, receipts, and project boundaries.
- Agent-authored messages do not automatically wake another agent. A later
  handoff interface must be explicit, recipient-bound, and budgeted.
- Existing self-hosted files remain readable throughout migration and rollback.

## Current data and trust flow

```text
authenticated upload
  -> local ./uploads write
  -> files row owned by uploader
  -> message transaction claims files.message_id
  -> message response exposes /api/files/:id
  -> protected file route rechecks current message/task visibility
```

The database claim and visibility checks are the sound part. The broken seam is
the final browser request: the web session stores bearer credentials in
`localStorage`, while ordinary `<img src>` and `<a href>` navigation cannot send
the Authorization header expected by `/api/files/:id`.

## Options considered

### Patch direct URLs with long-lived signed links

This is visually simple but turns possession of a URL into authorization,
weakens immediate revocation, and creates different behavior for local and
object storage. It is rejected as the default.

### Fetch protected bytes through the existing authenticated API

The web client fetches the current protected URL through `ApiClient`, creates a
short-lived browser object URL, and revokes that URL when it is no longer used.
Downloads use the same authenticated fetch and a temporary download anchor.
This is the smallest adequate Loop 1 fix and preserves current authorization.

### Replace attachments with a separate file service immediately

This could centralize storage, processing, and delivery, but adds deployment,
credential, observability, and consistency work before fixing the current user
failure. It is rejected. The needed behavior belongs behind a deep Deft module,
not another independently deployed service.

## Decision

Use authenticated browser fetches for the immediate human path. Then evolve
the existing `files` row into the immutable blob record behind a small Deft
attachment module:

1. `FileStore` owns byte put, get, stat, and delete operations. Local disk is
   the self-hosted adapter; S3-compatible storage is the hosted adapter.
2. Typed attachment junctions associate a file with messages and tasks. Typed
   links preserve foreign keys and tenant-aware query paths better than one
   unconstrained polymorphic target column.
3. `AttachmentAccess` is the only read seam for web, Defty, Agent Channel, and
   MCP callers. It resolves current visibility before returning bytes or a safe
   derivative.
4. `AttachmentProcessor` owns detected type, checksum, quarantine/scan state,
   bounded extraction, and derivative lifecycle.

Callers keep the existing attachment response fields during the compatibility
window. A later manifest adds processing state and read capability without
exposing storage keys or credentials.

## Processing and agent contract

The processing state is explicit: `pending`, `ready`, `blocked`, or `failed`.
The original file remains immutable. Derived text, tables, thumbnails, OCR, and
image answers inherit the original file's access and retention rules.

Agent-facing message events and reads will carry a bounded manifest containing
the attachment ID, safe name, detected type, size, kind, processing state, and
available read modes. They will not carry a permanent URL. Employee tools will
provide permission-checked attachment listing and reading. Image questions may
use a Deft-side vision/OCR provider so the standard Hermes runtime can consume
bounded text even if its transport does not accept image content blocks.

The bundled Deft employee skill will teach stock Hermes to inspect manifests,
call the read tool, treat contents as untrusted evidence, cite the source file,
ask for clarification, and never claim an unsupported read succeeded.

Spreadsheet imports produce one bounded, reviewed workspace-plan action whose
preview keeps proposed projects and tasks as separate typed entries with stable
identities. Approval executes the whole batch transactionally and replay uses
those same identities, avoiding partially approved project/task graphs. No
project or task row is written before the required approval.

Agent output will first support Markdown, plain text, and CSV. A governed
document-send action holds only reviewed draft data before approval, then
stores the protected file and links it in the same transaction as the chat
message. Server-side PDF or DOCX export is additive after the core path is
proven.

## Migration and rollback

The structural migration is expand-and-contract:

1. Add storage and typed attachment records without removing
   `files.message_id` or `files.task_id`.
2. Backfill links with organization and target consistency checks.
3. Dual-read and dual-write behind a compatibility flag.
4. Certify fresh install, supported upgrade, rollback reads, and file counts.
5. Switch reads to the new attachment module after demo proof.
6. Remove legacy columns only in a separate post-pilot release.

Rollback disables new writes and resumes legacy reads. File bytes are never
moved destructively during the compatibility window. A failed processing job
does not make the original record disappear; it leaves a visible terminal
state and a retryable operator path.

## Execution gates

1. **Human access:** protected previews and downloads work on desktop and
   mobile while unauthorized, private-space, deleted-message, and cross-org
   requests fail closed.
2. **Storage and links:** fresh schema and supported upgrade preserve existing
   files, attachment counts, ordering, and visibility; rollback remains usable.
3. **Processing:** misleading types, oversized files, unsafe files, extraction
   failures, abandoned uploads, deletion, and retention have deterministic
   outcomes.
4. **Agent reads:** Defty and two stock-Hermes profiles read permitted files;
   unavailable formats and cross-project reads are truthful failures.
5. **Spreadsheet actions:** the preview matches the workbook, approval creates
   the expected records exactly once, and replay or restart creates no duplicate.
6. **Agent output:** an agent-created file opens for the intended recipient,
   carries a receipt, and becomes inaccessible when its source access is revoked.
7. **Handoff:** one explicit agent-to-agent transfer completes within its hop
   and action budget without triggering an automatic reply loop.
8. **Release:** the full sender/recipient and file-type matrix, typecheck,
   clean-state certificate, demo evidence, required checks, and supervised soak
   pass for one exact Deft commit and stock Hermes revision.

## Out of scope

- Editing or forking Hermes core.
- Public or permanent file links.
- Executing spreadsheet formulas, macros, or embedded instructions.
- A generic external file-service framework.
- Dropping legacy file columns in the first attachment release.
- Automatic agent-to-agent mention delivery.
