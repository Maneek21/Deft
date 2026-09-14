# Create a task through MCP

For Deft v0.3.0-preview.15.

## Connection and scopes

Use an authenticated personal MCP client connected to `/api/mcp/v1`, with `read:workspace`, `read:tasks`, and `write:tasks`. These examples are the JSON-RPC request bodies sent by an initialized MCP client, not standalone HTTP setup instructions.

Call `tools/list` first. The live catalog for your release defines the exact accepted arguments. Personal writes act as the connected human and do not wait in the employee approval queue.

## 1. Resolve the project

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"resolve_project","arguments":{"query":"Launch pilot"}}}
```

Read the tool's content. Continue only when it identifies one resolved project. If it returns `ambiguous`, choose from the candidates; if `not_found`, check the project name and your access. Use the returned project id below.

## 2. Create one task

Replace `PROJECT_ID_FROM_RESOLVER` before sending:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"task_create","arguments":{"project_id":"PROJECT_ID_FROM_RESOLVER","title":"Review the launch announcement","description":"Check the date, demo link, and support contact.","priority":"p2","idempotency_key":"launch-pilot-announcement-001"}}}
```

The request leaves the task unassigned. To assign it, resolve a member first and pass the returned `assignee_id`.

The successful result includes the saved task fields, an `id`, and `task_key`. Keep those actual values; do not infer an id from the title. The JSON-RPC request id only matches a response to a request. `idempotency_key` identifies the write you may need to retry.

## 3. Read it back

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"task_get","arguments":{"task_id":"TASK_ID_FROM_CREATE"}}}
```

The tool's text content contains JSON with a `task` object, `recent_comments`, and `recent_activity`. Compare `task.title`, `task.description`, and `task.project_id` with the request. Open `task.task_key` in Deft to check the same record in the UI.

## Arguments used here

| Tool | Required arguments | Scope |
|---|---|---|
| `resolve_project` | `query` | `read:workspace` |
| `task_create` | `title`; pass the resolved `project_id` explicitly | `write:tasks` |
| `task_get` | `task_id` | `read:tasks` |

For `task_create`, the example also uses `description`, `priority`, and `idempotency_key`. Priorities are lowercase `p0`, `p1`, `p2`, or `p3`. Optional `due_date` and `start_date` accept date strings; use an explicit ISO date or timestamp when dates matter.

## Handle failures without duplicating work

| Result | Next step |
|---|---|
| Authentication rejected | Reauthorize or replace the revoked/expired token. |
| Missing scope | Update the grant; retry only after it includes the required scope. |
| Tool result has `isError: true` | Read its message; an HTTP or JSON-RPC success alone does not mean the task was created. |
| Ambiguous project or member | Resolve the target before a write. |
| Connection drops after creation | Read the result if known; otherwise retry the same arguments with the same idempotency key. |
| Different task requested | Use a new idempotency key for the new intent. |

Employee-token clients have a different catalog and approval behavior. Read [MCP tools](https://deft.ing/docs/mcp-tools/) before adapting this example to an employee runtime.
