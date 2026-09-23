# Dependency compatibility follow-ups

Reviewed against GitHub master `9e6fca0a2ea400822bcb3c8380415025a1382d1c` on 2026-09-23.

## Zod 4.6.5: compatibility fix in PR #341

The original upgrade changed frozen unknown-key and union diagnostics. The
reviewed adapter restores abort behavior at the App/Module refinement
boundaries, retaining every error and preserving semantic rejection. The
workspace override is removed; Zod remains outside the routine update group.

See [the compatibility decision](2026-09-23-zod-contract-compatibility.md) for
the options, trust boundaries, rollback and validation. Future updates must
pass the committed diagnostics, package and packed-consumer regression tests.

## ESLint 10: PR #322 remains draft

The existing React plugin crashes loading `react/display-name` with
`contextOrFilename.getFilename is not a function`. Keep the update deferred
until the Next/React plugin and configuration stack supports ESLint 10.
Upgrade compatible pieces together, retaining enabled rules, and require
full web lint, typecheck, build and CI. See the failing run:
https://github.com/Maneek21/Deft/actions/runs/35465294161.
