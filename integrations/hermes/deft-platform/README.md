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

## Employee Connection Contract

The plugin has five responsibilities:

1. Negotiate the versioned Agent Channel contract and poll as the bound Deft
   employee.
2. Journal only an event identity before acknowledging transport acceptance.
3. Map Deft chat, task, assistance, cancellation, and approval events into
   Hermes's normal `MessageEvent` interface.
4. Return one source-bound, idempotent platform reply while substantive Deft
   state changes continue through employee-scoped MCP.
5. Resume accepted work after restart and clear the journal only when the
   platform lifecycle or final task reply proves delivery is complete.

The journal is the only durable adapter-owned state. It contains an opaque
binding digest, the accepted cursor, event IDs, and transport-acceptance flags
for deliveries that have not yet produced their required outward delivery. The
digest binds state to the normalized channel endpoint, employee slug, and
Hermes owner profile without including either token, so credential rotation is
safe while endpoint, employee, or profile reuse fails before any recovery
request. Version 1 or 2 development journals migrate only when empty; pending
unbound work must first be recovered with its original configuration. After a
restart, the employee-authenticated adapter rehydrates an accepted source event
from Deft; it never persists source payloads, model state, plans, tool calls,
prompts, business outcomes, claim tokens, or credentials in the journal.

Everything else remains outside the connection contract: model/provider
selection, reasoning, skills, browser and research tools, external MCPs,
private memory, execution budgets, and process supervision belong to Hermes
and its operator. Tenant authorization, approvals, receipts, shared Knowledge,
module policy, and durable workplace state remain authoritative in Deft.

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
- `display.busy_input_mode: queue` and `display.busy_ack_enabled: false`, so a
  new workplace event waits for the active run without posting Hermes transport
  acknowledgements into Deft;
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
    enabled: true
    home_channel:
      platform: deft
      chat_id: <organization-id>:<space-id>
      name: Deft home
    extra:
      channel_url: https://deft.example/api/agent-channel/v1
      token: <employee Agent Channel token>
      employee_slug: <employee slug>

mcp_servers:
  deft:
    url: https://deft.example/api/mcp/hermes/v1
    headers:
      Authorization: Bearer <employee MCP token>
    enabled: true

display:
  busy_input_mode: queue
  busy_ack_enabled: false
```

The direct HTTP MCP configuration is intentional. Hermes supports it natively,
so no Deft-owned stdio shim or sidecar process is required.

For the present internal pilot, authenticate the profile with Hermes's native
Codex provider and pin the tested model profile before starting the gateway:

```powershell
hermes auth status openai-codex
hermes config set model.provider openai-codex
hermes config set model.default gpt-5.6-sol
hermes config set agent.reasoning_effort medium
```

The first command must report a valid credential. Authentication, model access,
and provider limits remain operator-owned; Deft does not proxy them.

The home channel suppresses Hermes's first-message setup notice and gives the
runtime a default Deft conversation for operational notices. Pick an existing
space the employee may access. Proactive delivery to that home conversation is
not part of the current source-bound reply proof.

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
- Chat and task initiation are intentionally distinct. A chat message may drive
  Knowledge reads, external research, governed MCP writes, and a source-bound
  reply without silently creating a Deft task. `record_progress` remains
  available only for an accepted task assignment, where its milestone has an
  explicit task owner and lifecycle.
- Hermes reports real task milestones or blockers with `record_progress` and
  changes other Deft state through the appropriate governed MCP tools.
- Hermes tool-boundary commentary remains transient for task assignments;
  Deft persists the final channel reply and the substantive MCP task report,
  rather than turning every model preamble into a durable task comment.
- Certification consumes its one final reply slot only when Hermes supplies the
  exact current event anchor and its final `notify` marker. Unknown or stale
  explicit anchors never fall through to a newer route in the same scope.
- Human comments, cancellation, and approval results return through the same
  channel and task/chat context.
- Hermes treats inbound Deft actors as authorized upstream because the
  employee-scoped Agent Channel token and Deft tenant policy determine which
  server-generated events reach the runtime; no duplicate local user allowlist
  is required.
- The adapter journals only transport metadata before handing accepted work to
  Hermes. A restart rehydrates that employee-scoped event from Deft, and stable
  outbound idempotency prevents duplicate visible replies. If acceptance never
  committed, the stale local identity is discarded and Deft reacquires the
  delivery through its normal lease path.
- Adapter replacements inside one live Hermes gateway reuse a process-lifetime
  worker identity. Only a new gateway process rotates it for restart proof.
- A task route is retired after its first final platform reply, so later runtime
  continuations cannot add duplicate task comments. Chat routes remain available
  only in the current bounded process cache for conversational follow-ups; after
  restart, output without a newly accepted source event is rejected rather than
  guessed onto a conversation.
- Deft permissions, approvals, tenant isolation, receipts, and module policy
  remain authoritative for Deft writes.

## Rollback

Stop Hermes, disable `deft-platform`, and revoke its two employee credentials in
Deft. This does not modify or migrate another employee, Rita, Defty, or the
legacy supervised bridge.
