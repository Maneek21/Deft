# Connect an AI assistant to CRM

Deft exposes CRM modules through its standard streamable HTTP MCP endpoint. Use a
personal MCP connection for an assistant acting as you, or an agent employee token for
a governed shared worker. Create personal connections in **Settings → Personal AI connections**;
shared workers use **Settings → Agent employees**. Choose the smallest scopes
needed, and keep the token in the client environment rather than
in a prompt or checked-in file.

The Module's **Agent access** setting controls Defty and agent employees.
The existing personal Codex connection acts as its authorizing user with the
connection's explicit scopes; that setting does not revoke its access.
Revoke or restrict a personal connection in **Personal AI connections**. CRM
records currently have workspace-level access: the Owner field assigns responsibility and does
not restrict who can read a record. Linked native tasks retain their own
visibility rules.

## Endpoint and client setup

For this CRM development workspace (web on port 3040, API on 3041), use:

```text
http://localhost:3041/api/mcp/v1
```

For a hosted deployment use the public HTTPS URL:

```text
https://your-domain.example/api/mcp/v1
```

Codex CLI/IDE can use a TOML server entry. The bearer value is read from the
environment, so start Codex with `DEFT_MCP_TOKEN` set:

```toml
[mcp_servers.deft]
url = "http://localhost:3041/api/mcp/v1"
bearer_token_env_var = "DEFT_MCP_TOKEN"
```

For hosted clients that support OAuth, use the endpoint in the client’s remote
MCP connector flow and authorize through Deft. A hosted client must be able to
reach the deployment over HTTPS; `localhost` is only for a client on the same
machine. See the [Codex MCP documentation](https://developers.openai.com/codex/mcp).

## CRM workflow

Start with `module_list`, then `module_schema_get` for the selected module. Use
`module_record_search` or `module_record_query` to find records and
`module_record_get` to retrieve one. `module_record_incoming` and
`module_record_latest_related` help traverse declared relationships.

For changes, use `module_record_create`, `module_record_update`, or
`module_record_archive`; use `module_record_bulk_create` only for an intentional
bulk operation. Use `module_record_task_links` to inspect linked tasks and
`module_record_task_link` or `module_record_task_unlink` to change those links.
Task-link reads require `read:modules` plus `read:tasks`; writes require
`write:modules` plus `write:tasks`.

Use stable record and task IDs. Supply a new, stable `idempotency_key` for each
intent and reuse that same key only when retrying the same request. Treat a
pending approval or queued action as pending, not completed; confirm the
returned mutation/result and revision before reporting success.

## Installed App actions

With the App scopes, call `capability_list` and `capability_get` for the exact
module resource, then invoke an available binding with `app_binding_invoke` and
inspect the resulting run with `app_run_get`. App approval and the returned
receipt remain authoritative; an assistant should not infer success from its own
message or a provider response alone.

The current connected-App contract supports the reviewed sandbox-email
capability. Declaring another MCP tool does not make it an executable App
action; Deft must support the corresponding capability contract first.

Choose **Work with installed Apps** in Personal AI connections for `read:modules`,
`write:modules`, `read:tasks`, `write:tasks`, `read:apps`, `invoke:apps`, and
`read:app-runs`. Use individual permissions when other workspace context is
needed. Existing connections keep their original scopes; create a new scoped
connection if additional access is required.

Follow `next_cursor` or `next_offset` until null before claiming a complete list.
Use the manifest digest from schema discovery and the latest record revision for
updates. If an operation creates a task but linking fails, retain that task and
retry only the link. Sandbox acceptance is not evidence of delivery.
