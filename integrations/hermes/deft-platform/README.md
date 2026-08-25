# Independent Hermes employee profile for Deft

This plugin makes Deft a native Hermes messaging platform. Hermes runs wherever
the operator installs it, owns its model loop and external tools, and connects
to Deft through two narrow interfaces:

- Agent Channel for chat, assignments, human replies, cancellations, and
  approval results.
- Deft MCP for identity-bound workplace reads and governed writes.

Deft does not start Hermes runs, construct its prompts, inspect its chain of
thought, manage its skills, or promise that an operator's model and external
providers are capable.

## Compatibility profile

Required:

1. A currently supported Hermes installation with third-party platform plugins.
2. One Deft employee identity, Agent Channel token, and MCP token from the same
   organization and employee.
3. Network reachability from the Hermes host to both Deft endpoints.
4. The nine core workplace tools checked by `readiness.py`; the current Deft
   contract exposes at least 44 MCP tools.

Recommended for the internal pilot:

- a strong tool-using model (the present Rita pilot uses gpt-5.6-sol with
  medium reasoning);
- at least one working Hermes-native web research path;
- operator-installed skills/connectors appropriate to the employee's role;
- sufficient local action and provider budgets; and
- Hermes private memory enabled for personal continuity.

Model, browser/search, skills, universal MCPs, and external credentials remain
Hermes/operator responsibilities. Deft Knowledge is shared company memory: use
`memory_recall`, `memory_write`, and the wiki tools to read or promote knowledge
that should be visible to the organization.

## Install into a fresh Hermes profile

1. Copy this directory to `$HERMES_HOME/plugins/deft-platform`.
2. Add the following shape to `$HERMES_HOME/config.yaml`. Keep real credentials
   in a secret manager or a locally protected profile; do not commit them.

```yaml
plugins:
  enabled:
    - deft-platform

platforms:
  deft:
    channel_url: https://deft.example/api/agent-channel/v1
    token: <employee Agent Channel token>
    employee_slug: <employee slug>

mcp_servers:
  deft:
    url: https://deft.example/api/mcp/v1
    headers:
      Authorization: Bearer <employee MCP token>
    enabled: true
```

The direct HTTP MCP configuration is intentional. Hermes supports it natively,
so no Deft-owned stdio shim or sidecar process is required.

3. Before starting the gateway, run the non-mutating probe:

```powershell
python "$env:HERMES_HOME/plugins/deft-platform/readiness.py"
```

Supply `DEFT_CHANNEL_URL`, `DEFT_CHANNEL_TOKEN`, `DEFT_EMPLOYEE_SLUG`,
`DEFT_MCP_URL`, and `DEFT_MCP_TOKEN` as environment variables. A successful
probe reports the bound employee and MCP catalog, then marks its temporary
connection offline.

4. For a disposable onboarding task already assigned and delivered to the
employee, add `--task-id <uuid> --task-key <PREFIX-NUMBER>`. This performs one
authorized task read and one idempotent `record_progress` write. Never use a
production task as a readiness fixture.

5. Start Hermes normally. Deft is one channel and one MCP server among the
runtime's own channels, tools, skills, memory, browser, and research providers.

## Operating contract

- Accepting a channel event means transport delivery only; it does not claim
  that business work is complete.
- Hermes reports real milestones or blockers with `record_progress` and changes
  Deft state through MCP.
- Human comments, cancellation, and approval results return through the same
  channel and task/chat context.
- The adapter journals accepted work before handing it to Hermes. A restart
  resumes the accepted event and stable outbound idempotency prevents duplicate
  visible replies.
- Deft permissions, approvals, tenant isolation, receipts, and module policy
  remain authoritative for Deft writes.

## Rollback

Stop Hermes, disable `deft-platform`, and revoke its two employee credentials in
Deft. This does not modify or migrate another employee, Rita, Defty, or the
legacy supervised bridge.
