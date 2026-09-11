# Current limitations

Last reviewed September 8, 2026. The latest published preview is `v0.3.0-preview.15`, a core release.

Installation and agent boundary notes updated September 11, 2026.

Deft is an alpha. It is suitable for technical evaluation, internal use, and controlled pilots where an operator can tolerate breaking changes and investigate failures.

## Installation and upgrades

- Fresh installs use `pnpm db:push-full` to apply the Drizzle schema plus supplemental search and index SQL.
- Supported release-to-release upgrades use `pnpm db:upgrade` and begin at the `v0.2.0-preview.1` schema baseline.
- Named GHCR preview images are currently amd64-only.
- Historical databases created before `v0.2.0-preview.1` are not automatically adopted. The upgrader refuses unknown or incomplete schemas rather than mutating them.
- Raw `pnpm db:migrate` remains unsupported; the release upgrader owns the checksum ledger and compatibility checks.
- Schema migrations are forward-only; successful upgrades do not have an
  automatic downgrade. Operators should pin an image digest, back up Postgres
  and uploads, and rehearse restoring both with the previous image digest
  before updating.
- Content exports are partial (wiki, notes, calendar); recovery requires database, uploads, and configuration backups.

## Deployment contract

- One workspace per self-hosted deployment is the supported v1 contract.
- Docker Compose is the primary documented deployment path.
- The API requires a long-running container host with WebSocket support; it is not suited to a request-only serverless runtime.
- Self-hosters operate DNS, HTTPS, reverse proxy, backups, storage, monitoring, and incident response.
- No uptime SLA or managed support contract is included with the repository.

## AI and agents

- Core workspace features run without a Deft AI provider. Defty reasoning needs one; personal MCP clients can use their own AI provider.
- Personal MCP clients act as the authorizing user; their writes do not automatically enter the Agent Employee approval queue. See [identity and approval boundaries](self-hosting.md#identity-approvals-and-action-history).
- Knowledge summaries can be wrong or outlive a correction to their source; review and correct durable knowledge and resulting tasks.
- Self-hosted storage does not imply local AI processing: configured providers and permitted external clients can receive workspace content. See [AI data flow](self-hosting.md#ai-data-flow).
- Model output is probabilistic. Deft validates structured drafts and applies permission and approval rules, but cannot guarantee perfect interpretation.
- Agent employees require a separately operated compatible runtime. Deft does not host every external runtime or tool.
- A seeded demo identity is not proof of a live Hermes integration. Preview.15 is a core release without new Hermes certification.
- A healthy token or connection does not guarantee that an external runtime is online, subscribed, or able to finish assigned work.
- Autonomous behavior remains bounded by scopes, trust, approvals, action caps, provider availability, and customer configuration.

## MCP and external tools

- Deft supports streamable HTTP MCP with OAuth or personal bearer-token access, depending on the client.
- Client support varies by vendor, application, account tier, and connector policy.
- Native Slack, Gmail, GitHub, Google Calendar OAuth, Linear, and Notion connectors are not part of the current self-hosted v1 promise.
- External tools should be connected through a customer-owned agent runtime or MCP server.
- Calendar subscriptions through ICS are read-only; native Deft calendar events are writable inside Deft.

## Apps and Modules

- Apps are disabled by default. The API requires `DEFT_APPS_ENABLED=true`, and the web build requires `NEXT_PUBLIC_FEATURE_APPS=true`.
- Connected App execution and bounded automations add further flags and operator review. They are included in preview.15, experimental, and disabled by default.
- App Protocol v0 provides declarative internal records and native views. Current protocols do not provide arbitrary custom UI, public portals, general external runtimes, or synchronization.
- A package's requested permissions are review input. The host owns installation, grants, connector binding, activation, and execution authority.

## Scale and performance

- The project includes synthetic 60-person certification and substantial local/public-demo dogfooding.
- That evidence is not a production benchmark, capacity guarantee, or substitute for load testing on the operator's hardware.
- Sustained concurrency, large file volume, long retention, WebSocket fanout, notification bursts, and job backlog should be tested for each deployment.

## Security and compliance

- Deft has ongoing auth, org-isolation, space-membership, MCP, upload, and rich-content security tests.
- Deft has not completed an independent security audit.
- Deft does not claim SOC 2, ISO 27001, HIPAA, GDPR certification, DLP, eDiscovery, or an uptime SLA.
- Operators remain responsible for regional privacy, retention, backup, access, and compliance obligations.

## Product boundaries

- Web application only; no native desktop or mobile app.
- No offline-first mode.
- Huddles are browser-based and are not a substitute for a dedicated large-group meeting platform.
- Knowledge is link- and graph-oriented, not a full Notion-style block database system.
- Task management does not currently target portfolio planning, sprint analytics, OKRs, billing, or a custom report builder.
- Some lower-frequency settings and administrative flows have less dogfood depth than chat, tasks, knowledge, MCP, and agent workflows.

These limitations should shrink over time. Track direction in [ROADMAP.md](../ROADMAP.md) and release-specific changes in [CHANGELOG.md](../CHANGELOG.md).
