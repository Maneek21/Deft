# Support

Deft is an alpha, source-available self-hosted project. Community support is best effort and does not include an uptime or response-time SLA.

## Where to ask

- **Bug:** open a GitHub issue with reproduction steps.
- **Feature or product proposal:** start a GitHub Discussion before a large implementation.
- **Installation or usage question:** use GitHub Discussions.
- **Security issue:** follow [SECURITY.md](SECURITY.md) and report privately.
- **Contribution:** read [CONTRIBUTING.md](CONTRIBUTING.md).

## A useful support request includes

- Deft commit SHA or release
- Deployment shape: Docker Compose, local development, or another container host
- Operating system and architecture
- Redacted environment details relevant to the failure
- Exact command or user workflow
- Expected and actual behavior
- Browser console, API, worker, Postgres, or Redis errors where relevant
- Whether the issue reproduces on a fresh workspace

Never post API keys, passwords, MCP tokens, OAuth credentials, database dumps, or private workspace content in an issue.

## Operator responsibility

Self-hosters are responsible for infrastructure, HTTPS, DNS, backups, restore drills, provider credentials, email delivery, storage, monitoring, and upgrades. Review [docs/self-hosting.md](docs/self-hosting.md) and [current limitations](docs/current-limitations.md) before piloting with important data.

## What maintainers may close

Maintainers may close requests that cannot be reproduced, omit required context after follow-up, depend on unsupported forks, request prohibited hosted-service use, disclose secrets, or fall outside the current product contract.
