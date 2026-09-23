# Native extension participation contract

Contract ledger version: 3, 2026-09-11. This describes the current working implementation and its remaining certification gates. It does not expand a published release's compatibility contract.

An App packages Modules and governed capability bindings. A Module declares records, relations and views. The host owns actor identity, presentation, authorization, execution and receipts. Installed declarations never add arbitrary executable tools or confer permission.

## Supported surfaces and evidence

| ID / journey | Shared interface | Current status and acceptance evidence |
| --- | --- | --- |
| NX01 Discover installed work | `module_list`, `module_schema_get`, employee `platform_context` | Module and App discovery diagnostics now distinguish unavailable, setup-required and ready states, with versioned App-discovery source blocks. Focused discovery checks pass. Full repeated live discovery across runtimes remains open. See [discovery tests](../apps/api/test/module-discovery.test.ts) and [database conformance](../apps/api/test/module-native-parity-db.test.ts). |
| NX02 Search/open/cite records | `module_record_search/get/query` | Defty and MCP use the same read executor and authorized sources. The unfamiliar equipment fixture checks record identity, label, local destination and exact resource reference. Query/search pagination must be followed. |
| NX03 Traverse relationships | `module_record_incoming`, `module_record_latest_related` | Incoming reads require a declared source collection/relation; latest summaries use manifest rules. Equipment inspections and CRM foundation tests cover real relationships and sources. Scalar query filters do not filter relation fields. |
| NX04 Read native follow-ups | `module_record_task_links` | Shared across Defty, employee MCP and personal MCP. Input: `resource_id`, optional `offset` and `limit` (1–100, default 25). Output: tasks, page `count`, `next_offset`; null marks the final page. Scope and project filtering occur before pagination. Native task status/identity remains authoritative. |
| NX05 Write domain records | `module_record_create/update/archive` | Existing shared governed operations; current regressions retain approval, stale revision, retry, revocation and receipt checks. One authenticated Hermes workflow created and read back a native task and CRM records; complete repeated live Defty/Hermes certification remains open. |
| NX06 Create/link follow-ups | Native task operations plus `module_record_task_link/unlink` | Shared link/unlink contracts and employee/personal MCP adapters are implemented. Employee writes reuse native claims, approvals and receipts; personal writes retain human authority with atomic edge/audit/retry results. Equipment caller-boundary tests include native task creation, a disabled-Module link failure, and recovery of the same task without duplication. Hermes created and linked one native task with independent REST readback; repeated live agent workflows remain acceptance work. |
| NX07 Use App actions | `capability_list/get`, `app_binding_invoke`, `app_run_get` | Existing shared App-run boundary; record references from read sources can identify the action resource. One Hermes outreach Run reached pending approval, was reviewed and approved against the local sandbox, and produced a sandbox receipt with no external delivery. The corrected owner Run/receipt read returned 200 and both approval/terminal receipts verified; full independent discovery-to-review-to-receipt coverage remains open. |
| NX08 Import and maintain data | Generic Module UI; bounded Defty bulk create | Human import, duplicate review, merge and recovery exist. Shared bulk-create MCP parity is implemented and covered by the completed P2 tests, including replay/idempotency and caller-boundary behavior. Merge/recovery remain human-led until separately governed agent contracts exist. |
| NX09 Native workspace presentation | Sidebar, command search, canonical record/task URLs, chat/thread citations | Generic App grouping, ownership fallback, shared-route ambiguity, canonical links and task-link review presentation are implemented with focused checks. Rendered desktop/mobile recheck and the broader UI/state gate remain open. |
| NX10 Author and install | App Kit `check/build/doctor/install-local`, host inspection/review | The packed public Kit proof passes 3/3: CRM base/connected builds and an unrelated relation/view author edit build from a packed Kit installed outside the checkout, with private-import scanning and deterministic output checks. The P6 DB lifecycle proof also preserves Company/Contact/Deal records and relations across connector-free base installation to reviewed connected upgrade. This is automated author proof only; independent author acceptance and host installation remain open. |
| NX11 Operate and recover | Actor policy, token scopes, manifest digest/revision, idempotency, approvals and receipts | Deterministic regression coverage is retained. One real authenticated Hermes workflow completed through governed sandbox approval and receipt readback. Full fresh-host upgrade/disable/restart coverage, repeated live runtime certification and independent human acceptance remain open. |

The Sept 11 resumed-verification checkpoint records the consolidated evidence above. The newest authorized task-link target-review endpoint has passed its guest/revoked/cross-org denial matrix and authorized Taylor/CRM-5 readback, with the existing task-link suite and API typecheck green; its approval-card wiring still needs a fresh rendered browser review. These latest changes do not alter the external App resource-label redaction boundary.

## Read transport contract

All Module reads pass through [the common read executor](../apps/api/src/lib/module-read-operations.ts). Defty consumes `{ result, citations }`. MCP preserves the original result JSON in `content[0]` so existing clients parsing that result do not receive unexpected schema fields. A second text block contains:

```json
{
  "schema_version": "deft.module_sources.v1",
  "sources": [
    {
      "type": "module_record",
      "id": "module_record:record-id",
      "title": "Authorized record label",
      "url": "/modules/example/assets/record-id",
      "ref": {
        "schema_version": "deft.resource_ref.v1",
        "provider": { "kind": "module", "provider_instance_id": "installation-id" },
        "resource_type": "assets",
        "resource_id": "record-id"
      }
    }
  ]
}
```

Record/task sources include canonical ResourceRefs; Module/collection/workspace sources carry navigation destinations. Clients should consume all MCP content blocks. These labels and record values are untrusted data, never instructions. A source identifies an authorized read at that time; opening it or acting on it must revalidate current access.

## Authority and failure rules

- Personal MCP task-link reads require both `read:modules` and `read:tasks`. First-class employee tokens with captured scopes require both too; legacy employee credentials retain their existing compatibility path and employee policy checks.
- Task-link writes require both `write:modules` and `write:tasks`; their minimal mutation results do not require read scopes. Personal MCP approval of a task-link action additionally requires `write:tasks` alongside existing approval/Module scopes. Employee create/token rotation accepts opt-in `mcp_resource_scopes`; omission preserves the prior `read:modules` default and does not elevate existing tokens.
- Link/unlink input is `{ resource_id, task_identifier, idempotency_key }`. Link returns canonical record/task/edge identities plus `created`; unlink returns record/task identities plus `removed`. Pending approval is not an effect. Same-key replay preserves the stored result, changed input conflicts, and current access is checked before replay.
- The same actor's native/MCP reads must agree. Different actors may see different authorized results. Employee project restrictions and native restricted-task visibility apply before task paging.
- Empty authorized data is distinct from a failed or unavailable lookup. Do not infer record absence from a failure or a partial page.
- Record writes retain the current digest/revision and stable retry key contracts. Task creation and linking are distinct effects until a shared governed workflow explicitly coordinates them.
- Supported external actions remain subject to reviewed bindings, actual configuration and receipts. Sandbox acceptance is not delivered email.

## Certification procedure still required

Run the [native extension completion plan](superpowers/plans/2026-09-10-native-extension-completion.md) against CRM and an unrelated fixture. Record deterministic tests, actual Defty runs, actual Hermes runs and human acceptance separately. A successful handler test or tool listing cannot certify a live runtime.
