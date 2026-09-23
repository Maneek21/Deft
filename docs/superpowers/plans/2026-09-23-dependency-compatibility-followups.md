# Dependency compatibility follow-ups

Reviewed against GitHub master `9e6fca0a2ea400822bcb3c8380415025a1382d1c` on 2026-09-23.

## Zod 4.6.5: separate from PR #335

The original 19-update batch changes Zod 4.4.3 to 4.6.5. The focused App Kit
test `preserves direct v0 rejection issues instead of wrapping them in a v1
union error` fails: verification now adds a custom issue at
`manifest.navigation[0].module_id` alongside the existing `too_small` and
`unrecognized_keys` issues. The protocol explicitly freezes rejection issue
shapes. Do not weaken that assertion as part of routine maintenance.

Keep the direct API, shared and App Kit Zod versions at their master baseline
and exclude Zod from Dependabot's patch/minor group so it receives separate
review. Tooling may retain its own transitive Zod version. This is not a
security exception: the dependency audit reports no known vulnerabilities.

Re-entry criteria:

1. Reproduce with `pnpm --filter @deft/app-kit exec tsx --test
   --test-name-pattern 'preserves direct v0 rejection' test/app-kit.test.ts`.
2. Compare old/new diagnostics for all frozen v0/v1/v2 malformed manifests and
   packages, including unknown keys, missing modules, duplicate identities and
   invalid navigation. Confirm accepted/rejected inputs remain unchanged.
3. Preserve the existing public error contract with a reviewed compatibility
   adapter, or explicitly version any intended contract change. Do not filter
   away validation errors or alter authority checks merely to pass the test.
4. Pass App Kit contracts, API/shared tests, workspace typecheck, web lint,
   build, audit and required CI before merging the independent update.

## ESLint 10: PR #322 remains draft

The existing React plugin crashes loading `react/display-name` with
`contextOrFilename.getFilename is not a function`. Keep the update deferred
until the Next/React plugin and configuration stack supports ESLint 10.
Upgrade compatible pieces together, retaining enabled rules, and require
full web lint, typecheck, build and CI. See the failing run:
https://github.com/Maneek21/Deft/actions/runs/35465294161.
