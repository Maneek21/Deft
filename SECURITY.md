# Security policy

## Supported versions

Deft is an alpha. Security fixes land on the latest commit of `master` and are included in the next preview release. The project does not maintain long-lived security branches yet.

| Version | Support |
|---|---|
| `master` | Actively maintained |
| Latest GitHub preview release | Best effort until the next preview is published |
| Older commits, releases, and forks | Not maintained by the Deft project |

Production operators should pin a commit, review release notes before updating, and maintain tested backups. See [current limitations](docs/current-limitations.md).

## Report a vulnerability privately

Do not open a public GitHub issue for a suspected vulnerability.

Preferred channel: [GitHub Security Advisories](https://github.com/Maneek21/Deft/security/advisories/new).

Alternative: email `security@deft.ing`.

Include, when possible:

- A clear description of the issue and its impact
- Affected commit SHA, release, and deployment shape
- Reproduction steps or proof-of-concept code
- Whether the issue can cross an org, user, space, or agent boundary
- Any suggested mitigation

We aim to acknowledge reports within three business days and provide an initial triage update within seven business days. These are targets, not a contractual SLA.

## Disclosure

We generally coordinate around a 90-day disclosure window. Critical issues affecting active self-hosters may be handled faster. Please allow maintainers time to ship a fix and notify operators before publishing technical details.

## In scope

- Authentication, authorization, session, invitation, and role handling
- Multi-tenant and `org_id` isolation
- Private space and direct-message access
- Agent, approval, MCP, OAuth, webhook, and token boundaries
- Task, message, wiki, note, calendar, people, and team APIs
- WebSocket room authorization and event delivery
- Upload, file path, rich-content, and rendering security
- Docker Compose, bootstrap, backup, and self-host configuration supplied by this repository
- Supply-chain issues in project-owned build and release automation

## Out of scope

- Vulnerabilities in third-party MCP servers, AI clients, model providers, or customer-owned agent runtimes
- Unsupported forks or local modifications
- Social engineering, credential reuse, or exposed secrets not caused by Deft
- Dependency vulnerabilities without a demonstrated impact on Deft; report those upstream and notify us if Deft needs a coordinated upgrade
- Availability testing that could disrupt a public demo or another operator's deployment

Thank you for helping keep Deft and its self-hosters safe.
