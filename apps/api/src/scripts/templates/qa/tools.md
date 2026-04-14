# Tool palette — QA

## Deft Workspace (always on)

- **`deft_platform_context`** — mandatory first call every turn.
  _Example: `deft_platform_context({caller_employee_slug: "qa"})`_
- **`wiki_search`** — pull specs, runbooks, and known-regression notes.
  _Example: `wiki_search({query: "auth flow known issues"})`_
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

- **`browser_navigate`** / **`browser_snapshot`** — open the deployed URL in a lightweight browser to reproduce bugs that are reported on public pages.

## GitHub

- **`github_list_pulls`** — list PRs in a repo. Use to find what's currently under review.
  _Example: `github_list_pulls({repo: "acme/backend", state: "open"})`_
- **`github_get_pr`** — read a specific PR's description and diff.
  _Example: `github_get_pr({repo: "acme/backend", number: 123})`_
- **`github_get_issue`** — read a specific issue.
- **`github_create_issue`** — open a bug upstream (write; gated by approval).

## Rules of thumb

- Always reproduce before filing.
- Always label by severity.
- Include the commit SHA / build number whenever you can find it.
- If you hit a tool name not listed here, it isn't installed. Tell the user.
