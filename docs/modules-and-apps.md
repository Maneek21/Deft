# Modules and Apps: choose a starting point

For Deft v0.3.0-preview.15.

A **Module** defines records, relationships, and native views. An **App** packages Module resources for installation and may request supported connected actions. They use different manifests and installation flows.

## Choose what you need

| You want to… | Start with | Install through |
|---|---|---|
| Track vendors, contacts, or other internal records | A standalone Module: `deft.module.json` | **Settings → Modules → Install local** |
| Package declarative resources as an App | An internal App: `deft.app.json` with referenced Module files, built with App Kit | Developer pairing, then **Settings → Apps** |
| Add a supported provider action | A connected App with declared resources and capability requests | App Kit staging, then operator review and activation |

For a small tracker, follow [Build your first Module](tutorials/first-module.md). It uses the Module CLI and does not need App Kit or the experimental Apps flags.

For an App package, follow [Build an internal App](getting-started.md#build-an-internal-app). Protocol v0 packages declarative resources. Protocol v1 adds the supported connected-action contract; Protocol v2 adds bounded scheduling requests. App Protocol numbers and Module schema versions describe different contracts.

## What is available

Standalone Modules and the bundled Contacts Module are available in the preview. Apps are experimental and disabled by default. Enabling Apps does not grant a package authority to call a provider.

The current connected scaffold demonstrates a sandbox-email capability. It is not a general connector marketplace or a promise of Gmail, Slack, or arbitrary API support. A connected package is staged first; an operator reviews it, binds an eligible provider, and activates it. Bounded schedules require further configuration and host approval.

Use the release-matched [App author guide](connected-app-author-guide.md) and [App Run operations guide](app-run-operations.md). Custom App interfaces, public portals, arbitrary hosted code, and general synchronization remain planned.

## Know who can access the records

Standalone Module v1 records are shared with workspace owners, admins, and members. Guests cannot access them. There are no private rows, collections, or fields in that contract.

New Module installations give Defty and agent employees no access until an administrator enables it. Personal MCP clients act as the connected user and need the appropriate Module scopes; the employee access switch does not control those clients.

Human edits and personal MCP writes use their normal permissions. Agent writes follow the approval policy; agent archive requests require human review. An App's requested permissions are review input, not an effective grant.

“AI client” elsewhere in the docs means an external tool such as Claude or Codex connected through MCP. It is separate from an installed Deft App package.
