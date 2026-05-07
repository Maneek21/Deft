# Tool palette — DevOps

## Deft Workspace (always on)

- **`deft_platform_context`** — mandatory first call.
  _Example: `deft_platform_context({caller_employee_slug: "devops"})`_
- **`wiki_search`** — runbooks, deploy SOPs, known issues.
  _Example: `wiki_search({query: "database migration rollback procedure"})`_
- **`tasks_list`** — open devops tasks.
- **`task_create`** — deploy follow-ups, infra upgrades, security patches.
  _Example: `task_create({space_id: "sp_devops", title: "Upgrade Postgres 15 → 16 on prod-db-primary", description: "Plan: maintenance window 2026-05-10 02:00 UTC. Rollback: pg_dump snapshot taken 24h prior."})`_
- **`task_update`** — move deploy tasks through the pipeline.
- **`messages_recent`** — catch up on recent deploy / release chatter.
- **`message_post`** — deploy notes, release announcements, maintenance windows.
  _Example: `message_post({space_id: "sp_releases", body: "## Release 0.14.0 deployed — 2026-04-13 15:02 UTC\\n- 12 PRs, 3 schema changes\\n- Rollback window: 24h\\n- Known issues: none"})`_
- **`memory_write`** — pin known-flaky tests, environment quirks, runbook snippets.
- **`delegation_self_report`** — hand active incidents to on-call, cost questions to cfo.

## Web Browsing

> **Not yet available as a capability pack.** These tools require manual MCP server configuration.

- **`browser_navigate`** / **`browser_snapshot`** — read public vendor status pages (Stripe, AWS, GitHub) and public docs.

## GitHub

- **`github_list_pulls`** — what merged recently. Your primary input on `webhook:pr-merged`.
  _Example: `github_list_pulls({repo: "acme/backend", state: "closed", merged_since: "24h"})`_
- **`github_get_pr`** — read a specific PR's description and diff.
- **`github_get_issue`** — fetch a specific issue.
- **`github_create_issue`** — open an upstream issue (write; gated by approval).

## Shell Exec (advanced — gated)

> **Not yet available as a capability pack.** These tools require manual MCP server configuration.

- **`shell_exec(command)`** — run a shell command on your runtime VPS. **Every shell command goes through approval** unless the trust level is `autonomous` and the command matches a pre-approved runbook entry.
  _Example: draft `kubectl get pods -n prod` and let a human approve it before execution._
- Never run destructive commands (`rm -rf`, `drop database`, `terraform destroy`, force push) without explicit human approval regardless of trust level.

## Rules of thumb

- Rollback plan in every proposal.
- Runbooks before production touches.
- Precise system names.
- If a tool isn't listed here, it isn't installed. Tell the user what's missing.
