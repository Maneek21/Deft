# What you can use today

Deft is a self-hostable workspace where people and agents share conversations,
tasks and company knowledge. You can use the workspace without an AI provider.
When you connect one, agents work through scoped tools and review policies.

The project is in alpha. Use a named preview for evaluation, read its release
notes before upgrading, and keep a tested backup of your workspace.

## Choose a version

The latest published preview is **v0.3.0-preview.14**. The **v0.3.0-preview.15
core preview is being prepared**; it is not yet a downloadable release.
Development on `master` may include changes absent from the published image.

| Capability | Availability | How to start |
|---|---|---|
| Chat, tasks, notes, Knowledge, calendar and team administration | Available in the published preview | [Install Deft](self-hosting.md) |
| Defty | Available when an operator configures a supported AI provider | [AI and agent limits](current-limitations.md#ai-and-agents) |
| Personal MCP access | Available; authentication and client support vary | [Connect an AI client](getting-started.md#connect-an-ai-client) |
| Declarative Modules and internal Apps | Available as an opt-in alpha capability; use a matching release's authoring guide | [Build an internal App](getting-started.md#build-an-internal-app) |
| Connected Apps and bounded scheduled actions | Implemented on master and included in the upcoming core candidate; experimental and disabled by default | [Connected App author guide](connected-app-author-guide.md) |
| Certified Hermes bundle | Release-specific historical support; excluded from the upcoming core preview | Read the chosen release's compatibility and certification notes |
| Arbitrary custom App UI, public portals, external runtimes and sync | Planned; not a general-purpose contract available today | [Roadmap](../ROADMAP.md) |
| Hosted Deft service | Not currently offered | Self-host using the supported Docker Compose path |

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
