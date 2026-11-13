# What you can use today

Deft is a self-hostable workspace where people and agents share conversations,
tasks and company knowledge. You can use the workspace without an AI provider.
When you connect one, agents work through scoped tools and review policies.

The project is in alpha. Use a named preview for evaluation, read its release
notes before upgrading, and keep a tested backup of your workspace.

## Choose a version

The latest published prerelease is **v0.3.0-preview.141**, a **core** release built with the Apps-enabled browser profile and Author Kit `0.1.0-alpha.43`. The standalone Email App and its Runtime are released separately; the `compatibility.json` attached to each Email release names the Host version it requires. See [App release boundaries](app-release-boundaries.md) for scope. The Apps-enabled browser profile differs from the general default-off configuration.
Development on `master` may include changes absent from the published image; the [changelog](../CHANGELOG.md) lists them under Unreleased.

| Capability | Availability | How to start |
|---|---|---|
| Chat, tasks, notes, Knowledge, calendar and team administration | Available in the published preview | [Install Deft](self-hosting.md) |
| Defty | Available when an operator configures a supported AI provider. Its chat writes always wait for approval | [AI and agent limits](current-limitations.md#ai-and-agents) |
| Personal MCP access | Available; authentication and client support vary | [Connect an AI client](getting-started.md#connect-an-ai-client) |
| Standalone Modules | Available; install a manifest in Settings → Modules | [Build your first Module](tutorials/first-module.md) |
| Internal App packages | Experimental and disabled by default; package declarative resources with App Kit | [Build an internal App](getting-started.md#build-an-internal-app) |
| Connected Apps and bounded scheduled actions | Included in the published preview; experimental; the runtime flags below are off unless an operator sets them | [Connected App author guide](connected-app-author-guide.md) |
| Certified Hermes bundle | Release-specific historical support; not part of the preview.141 core release | Read the chosen release's compatibility and certification notes |
| External Runtime, governed source sync and trusted App UI | Available in the scoped Apps developer preview; requires reviewed setup and compatible artifacts | [Connected App author guide](connected-app-author-guide.md) |
| Arbitrary custom App UI and public portals | Planned; outside the trusted renderer contract | [Roadmap](../ROADMAP.md) |
| Hosted Deft service | Not currently offered | Self-host using the supported Docker Compose path |

Standalone Modules do not need the experimental Apps flags. See [Modules and Apps](modules-and-apps.md) for the two installation paths.

Apps require `DEFT_APPS_ENABLED=true` on the API and
`NEXT_PUBLIC_FEATURE_APPS=true` in the web build. Connected execution needs
`DEFT_APP_RUNS_ENABLED=true`, `DEFT_APP_RUN_APP_ORIGIN_ENABLED=true` and a valid
`DEFT_APP_RUN_KEYRINGS` secret. Bounded automations also need
`DEFT_APP_AUTOMATIONS_ENABLED=true`. Follow the [operator guide](app-run-operations.md)
when enabling these together. Flags do not grant an App permission: its package
and requested access still need operator review.
The example configuration leaves these features off. See the author and operator
guides before enabling them; do not assume an image was built with an opt-in UI.

## What Deft controls

Deft is authoritative for the shared workplace record and access to it. Its
supported tools enforce workspace permissions; governed actions follow approval
policies and produce attributable receipts. Ordinary workspace edits retain the
history provided by that feature. Personal MCP access acts with the permissions
of the person who authorized it.

Approvals follow these rules. Defty's chat writes always wait for approval, at every trust level; the workspace trust level governs only Defty's approved plans and background work. An agent employee's own chat messages (post, reply, direct message) run without approval at every trust level, within guard rails: space membership and visibility, the reply-storm detector, the daily action cap and the unhealthy (circuit breaker) state. Everything else an employee writes follows that employee's own trust level. Tool inputs and results and proposed parameters on a Defty message are delivered only to the person who asked and to owners and admins. No trust level auto-runs a call classed as destructive, and each step of a Defty plan carries a destructive flag and needs its own approval when destructive. The action lists, receipts, dashboard activity and inbox show a Defty action only to its requester and to owners and admins. Employee activity text, diagnostics and plan step text are limited to the people who may read them; other members see the status without the text. Deft does not record what an employee's own runtime spends, so the per-employee daily cost budget never triggers. The daily action cap (`max_daily_actions`) is enforced; use it and your runtime's own limits to bound cost. Passive task-candidate extraction from chat is disabled by default; operators can enable it with `DEFT_ENABLE_BACKGROUND_TASK_CAPTURE=1`. An agent action is reviewed by the member who requested it. Owners and admins review when there is no active human requester; they read another active member's request in activity and history. An approver assignment makes a member a reviewer only when this rule does. The Inbox approval list and its counts, Attention and the personal MCP approval tools use this rule for the approvals they list and count. An employee's wiki page update is applied only while the fields it writes are unchanged since it was proposed, and a page creation only at the slug fixed when proposed; otherwise the approval ends and nothing is written. A plan created for an agent employee binds to an active employee of the same workspace. Connected tools are available to members, admins and owners, not to guests. The daily standup and the meeting brief are written from prepared evidence with no tools, so they appear in their evidence-only form when the draft contains a link, approval or sign-off wording, or a task key that is not in the evidence. Meeting briefs go only to active members of the workspace the meeting belongs to. Defty does not manage agent employees, connections or triggers.

An external agent can also have private memory, its own skills, model settings and
tools. Its operator owns those choices and the costs they incur outside Deft.
Deft-side limits are not a cap on every action or model call that runtime makes.
Shared Knowledge and private runtime memory serve different purposes; connecting
an agent does not give Deft control over the agent's entire execution environment.

## Apps and Modules

A Module describes domain records, relationships and native views. An App packages
supported extensions for review and installation in a workspace. Connected Apps
can request additional supported capabilities, subject to a separate review.

Start with an internal workflow, such as tracking vendors and linking their records
to tasks. A public vendor portal also needs external-user access and custom
experiences that the current general App contract does not provide.

## Three ways to try Deft

Follow [Getting started](getting-started.md) to create a small workspace, connect a
personal AI client, or build a supported internal App. Each route identifies the
prerequisites and the result you should see. For operating limits, read
[Current limitations](current-limitations.md); for changes between versions, read
the [Changelog](../CHANGELOG.md).
