# AGENTS.md — Deft

## Product

Deft is an AGPL-3.0-only, self-hostable workspace where people and AI agents share chat, tasks, knowledge, calendar context, approvals, and action receipts. The monorepo contains the web app, API and workers, database package, MCP package, and shared contracts.

## Sources of truth

- Current code, schemas, migrations, tests, and package scripts override prose when they disagree.
- Read `README.md` for the product and repository overview, `CONTRIBUTING.md` for contributor expectations, `RELEASING.md` for releases, and `docs/self-hosting.md` plus `docs/self-hosted-v1-contract.md` for operations.
- Historical plans, specifications, audits, and decisions live under `docs/superpowers/`. Search that tree for the concept or path involved and read only the relevant documents; do not load the full history.
- Frontend work must also follow `apps/web/AGENTS.md`, including its requirement to consult the installed Next.js documentation before relying on remembered framework behavior.

## Invariants

- Preserve tenant isolation. Scope persisted resources and authorization checks to the organization and, where applicable, membership or ownership.
- Treat authentication, approvals, trust levels, receipts, external writes, and agent-supplied content as security boundaries. Inspect the current implementation before changing one.
- Validate external inputs with the existing Zod and TypeScript contracts. Preserve the established structured error shapes and avoid exposing raw stack traces or secrets.
- Keep Deft core generic. Domain-specific records and behavior belong in declarative modules or governed capabilities rather than bespoke CRM logic in core.
- Agent conversations use the shared spaces/messages model and structured message metadata. Do not recreate parallel agent-only conversation tables or reintroduce obsolete agent-kind architecture.
- Use `pnpm db:push-full` for fresh local schemas and `pnpm db:upgrade` for supported release upgrades. Do not use raw migration commands against important data without an explicit, reviewed migration plan.

## Working method

- Preserve pre-existing and unrelated worktree changes. Inspect `git status` and the relevant diff before editing.
- For non-trivial work, establish the requested outcome, completion evidence, allowed scope, and exclusions before implementation. Do not turn a review or diagnosis into a change unless the user asks for the change.
- Search with `rg`, inspect relevant symbols or file slices, and bound command output. Let the repository reveal discoverable facts instead of copying them into instructions.
- For bugs and regressions, reproduce the exact user-visible symptom with one focused command before fixing it. Prefer the smallest evidence-supported change.
- For consequential architecture changes, compare the smallest adequate options, including trust and data flow, migration and rollback, failure modes, and the interface used by callers and tests.
- Run focused checks during development and one consolidated relevant validation pass at the end. UI completion requires inspecting the rendered behavior at representative desktop and mobile sizes; a successful build alone is not visual proof.
- Before claiming completion, inspect the final diff and untracked files and report any unverified requirement explicitly.

## Code conventions

- Keep TypeScript strict and follow the established package-local patterns.
- Prefer existing repository scripts and dependencies. Add production dependencies or new infrastructure only when the task requires them and the tradeoff is explicit.
- Keep changes focused. Separate structural and behavioral work when doing so materially improves review, migration, or rollback safety.
