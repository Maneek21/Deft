# Contributing to Deft

Deft welcomes focused bug fixes, tests, documentation, accessibility improvements, and product changes that fit the current self-hosted workspace scope.

## Before you start

- Search existing issues and pull requests.
- Open an issue before a large architectural or product change.
- Keep pull requests narrow enough to review and revert safely.
- Do not include secrets, customer data, generated reports, local databases, or unrelated formatting churn.
- Read [current limitations](docs/current-limitations.md) and the [roadmap](ROADMAP.md) before building around a deferred capability.

## Development setup

### Requirements

- Node.js 20 or newer (22 recommended)
- pnpm 9 or newer
- PostgreSQL 16 with pgvector
- Redis 7

```bash
git clone https://github.com/Maneek21/Deft.git
cd Deft
pnpm install
cp .env.example .env

createdb deft
pnpm db:push-full
pnpm db:seed
pnpm dev
```

The web app runs at `http://localhost:3000`; the API runs at `http://localhost:3001`.

Use `pnpm db:seed` for the production-safe platform bundle. The following development seeds reset the database and must never be used against production data:

```bash
pnpm db:seed:demo
pnpm db:seed:pilot
```

Demo users use the password `tomato123`. Start with `diego@testers-tomatoes.com`.

## Repository structure

```text
deft/
|-- apps/
|   |-- web/               Next.js App Router application
|   `-- api/               Hono API, WebSocket, jobs, agents, and MCP
|-- packages/
|   |-- db/                Drizzle schema, migrations, and seeds
|   `-- shared/            Shared schemas, types, and constants
|-- scripts/               Bootstrap, smoke, pilot, and certification tools
|-- docs/                  User docs and engineering records
|-- docker-compose.yml
`-- pnpm-workspace.yaml
```

## Code standards

- TypeScript strict mode
- Zod validation at request and external-data boundaries
- Drizzle ORM for application data access
- `org_id` and permission checks on every workspace query
- Functional React components and existing local component patterns
- Tailwind CSS and shared tokens from `apps/web/src/app/globals.css`
- Kebab-case files and PascalCase React components
- Error responses shaped as `{ error: string, code: string }`
- Succinct comments only where the implementation is not self-explanatory

## Tests and gates

Choose tests based on the change. CI runs the required repository gates, but local focused tests should pass before a pull request is opened.

| Change | Minimum local validation |
|---|---|
| Documentation only | `git diff --check` and local-link review |
| Web UI | `pnpm --filter @deft/web lint`, `pnpm --filter @deft/web typecheck`, and browser verification at relevant desktop/mobile breakpoints |
| API or agent behavior | Focused API test files plus `pnpm --filter @deft/api typecheck` |
| Database schema | Fresh `pnpm db:push-full`, seed, focused API tests, and an explicit upgrade/rollback note |
| Self-host or Docker | `pnpm selfhost:doctor`, `pnpm selfhost:smoke`, and the affected Compose flow |
| MCP | Focused protocol tests and one real client-style workflow when behavior changes |

Before requesting review:

```bash
pnpm typecheck
pnpm --filter @deft/web lint
pnpm --filter @deft/api test
pnpm build
```

If a broad command cannot run in your environment, say so in the pull request and include the focused evidence you did collect.

## API and database changes

1. Validate requests and responses with Zod.
2. Resolve the authenticated user and org before querying workspace data.
3. Enforce space, role, and entity ownership explicitly.
4. Add or update focused tests for success, permission denial, cross-org denial, and malformed input.
5. Register new routes in the existing router structure.
6. Document migrations, fresh-install behavior, and upgrade behavior.

## Agent and MCP changes

- Treat model output as an untrusted proposal.
- Keep resolver and executor validation authoritative.
- Route risky writes through the established approval tiers.
- Preserve actor identity and produce an audit receipt.
- Add idempotency for externally retried writes.
- Test ambiguous references, revoked credentials, stale state, private resources, duplicate commands, and partial failure.

## Pull requests

- Use a short descriptive branch name.
- Use conventional commit prefixes such as `feat:`, `fix:`, `docs:`, `test:`, or `chore:`.
- Explain the user-visible behavior, implementation boundary, validation, and residual risk.
- Include before/after screenshots for UI work.
- Link an issue when one exists.
- Keep generated certification artifacts out of the repository unless maintainers explicitly request them.

By contributing, you agree that your contribution is licensed under the repository's [Business Source License 1.1](LICENSE) terms and retains the required project attribution.
