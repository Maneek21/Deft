# Contacts CRM operator and demo guide

This guide is the short path for an operator or reviewer of the sideloaded
Contacts CRM candidate. The CRM is a declarative Module (`com.deft.contacts`)
rendered by Deft's generic Module surfaces. Deft owns identity, tenant scope,
tasks, approvals and receipts; App Kit owns portable package validation; the
CRM artifact owns its collections, relationships, views and reviewed outreach
declaration.

## Candidate identity

Use the canonical files in `modules/bundled/contacts/` and the exporter in
`scripts/export-crm-author-project.mts`. The current exact versions are:

| Artifact | Identity |
| --- | --- |
| App Kit | `@deft/app-kit@0.1.0-alpha.3` |
| Module | `com.deft.contacts@1.8.0` |
| Connector-free CRM App | `org.deft.contacts-crm-app@1.8.0`, App Protocol v0 |
| Connected CRM App | same App ID at `1.9.0`, App Protocol v1 |
| Sandbox email provider | `@deft/app-platform-sandbox-email-provider@0.1.0-alpha.2` |

The connected App requests the lineage-private `sandbox_email_send` capability,
an MCP provider connector and one single-recipient action. These are requests;
the host creates effective grants and bindings only after owner/admin review.
The sandbox accepts messages in process memory and never delivers email.

## Install and author check

For a fresh disposable Deft schema use `pnpm db:push-full`; use
`pnpm db:upgrade` for a supported release upgrade. Follow the repository's
[Local development](../README.md#local-development) runbook (or the
[self-hosting guide](self-hosting.md) for Docker/production operations), then
use the API endpoint on 3041 and web app on 3040. Do not reset an existing demo
database.

To validate the public author path without a database or runtime, run:

```sh
pnpm test:crm-author
pnpm exec tsx --test scripts/crm-demo-data.test.mts
```

To export an independent author project into an empty directory, optionally
provide a packed Kit tarball of the exact version:

```sh
pnpm exec tsx scripts/export-crm-author-project.mts C:/tmp/contacts-crm-author C:/tmp/artifacts/deft-app-kit-0.1.0-alpha.3.tgz
cd C:/tmp/contacts-crm-author
pnpm install
pnpm run build
pnpm run buildConnected
```

Use `pnpm install --offline` only when the complete dependency graph is already
in the local pnpm store; the Kit tarball alone does not provide transitive
dependencies. The generated README is the detailed author contract. `build`
and `buildConnected` write `contacts-crm.deftapp.json` in turn; copy or rename
the base and connected outputs if both are needed for review. `build` creates
the connector-free base; `buildConnected` creates the separately reviewed
upgrade.
The exporter records the supplied tarball's package identity and SHA-256 and
rejects a wrong Kit before creating output. Keep the generated project and
vendor archive outside the repository when sharing a review bundle.

Use the supported package-upload route for the current exported CRM artifact:
open **Settings → Apps**, choose **Add or build an App**, select **Inspect
package**, and upload the generated `contacts-crm.deftapp.json` (base or
connected). Review the identity, dependencies, resource reads, connector
candidate and authority diff, then choose **Stage with no rights** and
**Activate**. Artifact upload does not require developer pairing. A base v0
installation exposes **Stage connected upgrade**; an already connected
installation exposes **Stage upgrade**. Staging grants no effective authority
until the reviewed activation.

Disabling preserves data; re-enable is a new review against current
authorization and bindings.

The generic `deft app install-local` command is for projects that contain the
CLI manifest `deft.app.json`; the CRM exporter emits `contacts-crm.deftapp.json`
and therefore does not use that command. Do not rename the artifact to make the
CLI accept it or bypass the Settings review surface.

## Assistant connection

Use the existing Streamable HTTP endpoint:

```text
http://localhost:3041/api/mcp/v1
```

Create a personal connection in **Settings → Personal AI connections** and select
the smallest needed scopes. The **Work with installed Apps** preset includes
`read:modules`, `write:modules`, `read:tasks`, `write:tasks`, `read:apps`,
`invoke:apps` and `read:app-runs`. The existing personal Codex connection acts
as its authorizing user. Agent employees are a separate governed token
path. Module Agent access controls Defty and employees; it does not revoke a
personal MCP connection.

Codex can use the documented TOML entry with `DEFT_MCP_TOKEN`. The complete
snippet and hosted HTTPS guidance are in [CRM AI assistant setup](crm-ai-assistants.md).
Never put a token in a prompt, README, fixture, or committed file.

Start an assistant journey with `module_list` and `module_schema_get`, then use
search/get and the declared create/update/archive and task-link tools. Reuse a
canonical ID returned by a mutation, provide a fresh idempotency key per intent,
and treat queued or pending approval as incomplete until the returned result,
revision and receipt are visible. Sandbox acceptance proves local connector
acceptance only. The existing Codex OAuth connection is available for the
bounded acceptance run; no temporary token was created or revoked. Hosted
human review remains an open gate.

## Five-minute fictional walkthrough

Use the compact [flagship demo fixture](../modules/bundled/contacts/examples/flagship-demo/README.md)
in a disposable workspace, or use the retained Human QA record when the
candidate runtime is already prepared. Keep all imported rows labeled
`crm-demo`; the fixtures use `.test` addresses. The larger CSV set under
`modules/bundled/contacts/examples/` remains available for regression and
repair practice.

1. Open Contacts and find **Avery Chen**, then link Avery to **Northstar
   Studio**. Open **Northstar Studio — Pilot**, set the deal to Qualified and
   give it a close date.
2. Add or open **Northstar discovery call** as a completed activity. Create a
   native follow-up task for the next customer step and open the linked task
   from the record. Use the status menu and follow the project's allowed
   intermediate statuses (for example, **Backlog → To Do → In Progress →
   Done**); **Close task** only dismisses the task drawer. Return through the
   record link.
3. Open **Northstar pilot invitation** in Outreach. Keep it Draft, verify the
   recipient, subject and exact body, and choose the reviewed outreach action.
   The action must show the Sandbox label and require exact-message review.
4. Approve the bounded sandbox action only when the recipient and message are
   correct. Inspect the App Run and safe receipt metadata. Report “sandbox
   accepted” rather than “sent”.
5. Demonstrate recovery with `repair-practice.csv`: one invalid email is
   rejected and one `.test` row is valid. For a disposable duplicate, import
   the valid row, merge it with deliberate conflict choices, then archive and
   restore the disposable record. Confirm relationships and the task link after
   restore.

The retained Human QA evidence uses **Human QA — Casey Vale**, **Acorn Labs**,
and a 500 USD repair-verification deal. It also records a synthetic sandbox
outreach approval. Treat that data as QA evidence, not a clean-demo guarantee;
the fictional CSV set is the reproducible demo input.

## Evidence and open gates

The repo-local [CRM final acceptance ledger](crm-final-acceptance.md) records
the evidence scope, historical checkpoint identities and remaining checks.
It distinguishes agent-operated UI rehearsal from human acceptance.
Claude is excluded by scope. Do not present the candidate as release-ready or
human-approved until the ledger’s remaining Defty and human-review items are
closed.

Related records: [CRM final acceptance ledger](crm-final-acceptance.md), [CRM AI assistant setup](crm-ai-assistants.md), [connected App
author guide](connected-app-author-guide.md), [assistant completion evidence](superpowers/audits/2026-09-15-crm-assistant-completion.md),
[boundary resolution](superpowers/audits/2026-09-15-crm-boundary-resolution.md),
and [Human QA repair verification](superpowers/audits/2026-09-15-crm-human-qa-repair-verification.md).
