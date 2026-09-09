# Settings implementation loops

The Settings exploration identified a structural problem: personal clients, shared
workspace tools, operator credentials and employee operations are presented as
overlapping destinations. The implementation should make the owner and purpose of
each setting clear while retaining existing permissions, API payloads and routes.

## Loop 1: navigation and focused management surfaces

- Group navigation into Your account, Workspace, Agents & AI, Work management,
  and Developer & operator. Derive overview cards from the same role-filtered
  navigation definitions. Keep all existing URLs.
- Open Apps on a searchable installed list. Give each App a detail URL at
  `/settings/apps/[id]`, retaining its existing review and lifecycle controls.
  Keep package inspection and developer pairing under Add or build an App.
- Put active personal connections before an expandable Add connection flow.
  Keep token scopes, grants, revocation and archived activity unchanged.
- Separate Calendar into Connected calendars and Share Deft calendar; AI into
  Providers, Model routing, Search and Voice; Profile into Identity,
  Availability & notifications, and Security.
- Keep section contents mounted to retain unsaved drafts. Profile and preferences
  still share their existing save request; password changes keep their independent
  handler. No permission model, database or runtime changes belong in this loop.

Acceptance: role/navigation tests, web typecheck and lint, rendered desktop/mobile
inspection, search and detail navigation, and draft retention across section
changes. Local UI checks use synthetic data and do not certify production writes.

Validation on 2026-09-09: all three navigation tests passed; web typecheck and full
web lint passed, followed by focused lint after final edits. The local Next.js
renderer was inspected at 1440×900 and 390×844, in light and dark themes.
Connection inventory/setup, App search (including no matches), App detail refresh
and return navigation, and Profile/Calendar/model-routing draft retention were
exercised. Password changes, token issuance, App activation and real connector
calls were not executed. The fixture intentionally omitted realtime and dashboard
data; this is UI evidence, not a database-backed integration run or release gate.

## Next loops

1. **Module ownership.** The API rejects enable/disable and manifest changes to
   App-owned Modules, but the module installation view currently omits ownership.
   Add an explicit organization-scoped ownership field to the read contract and
   route lifecycle management to the owning App. Preserve collection agent-access
   policy controls and standalone Module management. Do not infer ownership from
   manifest declarations: a staged App can request a Module it does not own.
2. **Canonical employee management.** Governance currently owns clone, save as
   template, trust escalation and turn/receipt inspection that the employee list
   does not expose. Move these into employee detail before removing the duplicate
   roster. Retain developer/runtime setup links, confirmations and receipt checks.
3. **Foundation evidence.** Mandatory current-candidate boundary checks, public
   App Kit distribution and explicit worker restart/restore evidence remain open.
   A locally packed kit is not public distribution. A Settings PR is not Track A
   recertification or Gate G clearance.
4. **Track B isolation.** The hostile static UI experiment blocked parent DOM,
   cookie/storage access and fetch, but sandboxed frame self-navigation still
   reached a local sink. Resolve that no-egress gap before freezing the manifest
   and bridge contract or claiming an isolated Email Lite shell.

Each implementation loop should produce a reviewable PR with fresh evidence.
PRs must remain unmerged until the user has reviewed them. Tracks B, C, D and
Gate G are not complete as a result of these Settings changes.
