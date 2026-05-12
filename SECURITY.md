# Security Policy

## Supported Versions

Deft is in private alpha. We provide security updates for the latest tagged release only.

| Version | Supported |
| ------- | --------- |
| Latest `main` | ✅ |
| Older tags    | ❌ |

## Reporting a Vulnerability

If you've found a security issue, please report it **privately** rather than opening a public GitHub issue.

**Preferred:** [GitHub Security Advisories](https://github.com/Maneek21/Deft/security/advisories/new) (private to maintainers).

**Or email:** security@deft.ing

Please include:
- A description of the issue and its impact
- Steps to reproduce
- Affected version / commit SHA
- Any proof-of-concept code

We aim to acknowledge within **3 business days** and provide a triage update within **7 business days**.

## Disclosure Timeline

We follow a **90-day disclosure window** from initial report. If we can't fix in 90 days we'll coordinate publication with you. Severe issues affecting production self-hosters may move faster.

## Scope

In scope:
- The Deft API (`apps/api`), web app (`apps/web`), database schema (`packages/db`)
- The docker-compose self-host stack
- Authentication, authorization, multi-tenant isolation (`org_id` enforcement)
- The agent action surface and approval flow

Out of scope:
- Third-party MCP servers connecting BYOA agents — report those to the MCP server's maintainer
- Vulnerabilities in dependencies (report to upstream, then ping us so we can bump)
- Issues only reproducible against modified forks

Thanks for helping keep Deft secure.
