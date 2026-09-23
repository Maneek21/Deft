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

## ESLint 10: compatibility adapter in PR #339

The React plugin crashes loading `react/display-name` with
`contextOrFilename.getFilename is not a function`; this was reproduced on
ESLint 10.11.0 after the original #322 was superseded by #339.

Use the official `@eslint/compat` adapter around the imported Next configs to
restore removed rule-context APIs. Keep all existing rules and severities.
The lint command first checks that React display-name and JSX-key, hooks,
Next script, and TypeScript unused-variable rules still report violations,
and that a valid typed component passes. Full lint, typecheck, build and
required CI remain merge gates.

Remove the adapter and its dependency once the upstream plugin stack supports
ESLint 10 directly and the same regression check passes without the adapter.
No production dependency or application behavior changes are required.
