# Tool palette — QA

## Deft Workspace (always on)

- **`deft_platform_context`** — mandatory first call every turn.
  _Example: `deft_platform_context({caller_employee_slug: "qa"})`_
- **`memory_recall`** — pull specs, runbooks, and known-regression notes.
  _Example: `memory_recall({query: "auth flow known issues"})`_
- **`tasks_list`** — filtered task list.
  _Example: `tasks_list({space_id: "sp_release", status: "in_review"})`_
- **`task_create`** — file a bug ticket. Include steps, expected, actual, env.
  _Example: `task_create({space_id: "sp_bugs", title: "[blocker] Login button doesn't respond on Safari 17", description: "Steps: 1. Open /login 2. Type credentials 3. Click Login. Expected: redirect to /home. Actual: nothing happens. Env: Safari 17.1 on macOS 14."})`_
- **`task_update`** — mark reproduced / fixed / can't-repro.
- **`messages_recent`** — catch up on recent chat-reported bugs.
- **`message_post`** — release reports, test summaries.
  _Example: `message_post({space_id: "sp_release", body: "## Release QA report — 0.14.0\\n- ✅ Auth flow\\n- ✅ Payments\\n- ⚠️ Known issue: export CSV fails on >10k rows"})`_
- **`memory_write`** — store environment quirks and regression notes.
- **`delegation_self_report`** — hand off infra bugs to devops, scheduling issues to alex-pm.

## Web Browsing

> **Not yet available as a capability pack.** These tools require manual MCP server configuration.

- **`browser_navigate`** / **`browser_snapshot`** — open the deployed URL in a lightweight browser to reproduce bugs that are reported on public pages.

## External repo tools

Deft does not bundle source-control access. If this employee's own runtime already has repo-hosting tools, use those tool names from that runtime's docs. Otherwise, coordinate from Deft tasks, chat, wiki, and calendar context.

## Rules of thumb

- Always reproduce before filing.
- Always label by severity.
- Include the commit SHA / build number whenever you can find it.
- If you hit a tool name not listed here, it isn't installed. Tell the user.
