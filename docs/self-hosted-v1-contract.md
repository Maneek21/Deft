# Self-hosted v1 product contract

This is the current promise for self-hosted Deft. Use this as the source of truth
when updating README, docs, website copy, setup flows, and pilot reports.

## What self-hosted v1 promises

- One Deft workspace per deployment.
- Email/password auth with invite links after the first owner account.
- Native chat, tasks, wiki, calendar, dashboard, notifications, and approvals.
- Defty, the built-in workspace superintendent, when an AI provider is configured.
- Bring-your-own agent employees over Deft MCP.
- Calendar context through native Deft events and ICS feed import/export.
- External tools through MCP/BYOA agents, not managed provider OAuth.
- Provider-neutral AI configuration: Anthropic, OpenAI, OpenRouter, or Ollama.
- Core product operation without AI keys. Chat, tasks, wiki, calendar, and auth still work.

## What self-hosted v1 does not promise

- Managed hosting or multi-tenant SaaS operation.
- Native Slack or Gmail integrations.
- Native Google Calendar OAuth.
- Native GitHub OAuth or a managed GitHub connector as a buyer-facing feature.
- A hosted plugin/agent marketplace.
- A guarantee that Deft provisions or controls third-party agent runtimes.

## Recommended integration story

- Calendar: connect ICS feeds in Settings -> Calendar.
- GitHub, Slack, Gmail, Linear, Notion, and other tools: connect them inside the
  user's own agent runtime or MCP server, then onboard that agent as a Deft employee.
- Local/private AI: configure Ollama or an OpenAI-compatible local server where supported.
- Managed AI: configure the provider key the workspace owner chooses.

## Legacy compatibility rule

Some source files and database enums may still contain old provider names such as
`github`, `google_calendar`, `slack`, or `linear` for compatibility with existing
rows, historical audits, and older experiments. These names must not appear as
self-hosted v1 product promises unless the integration is intentionally supported,
documented, and tested.
