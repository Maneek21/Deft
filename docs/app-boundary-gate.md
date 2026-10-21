# Host and core Kit app boundary

`Check App Boundary` runs on every PR and master push, before Type Check and the
expensive build/test jobs. It needs no secrets. The checker itself has no network
access or subprocesses; dependency installation is the ordinary frozen CI setup.

Run locally:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test:app-boundary
pnpm --filter @deft/app-kit build
pnpm check:app-boundary
```

The full-tree check covers API/web source (including colocated tests), shared
contracts, retained DB schemas/migrations, every non-optional Kit export and CLI,
`runtime-authoring` and `experience-capabilities`, plus generated JS/declarations.
AST traversal follows imports, re-exports, type imports, `require()` and literal
dynamic imports across relative paths, workspace package exports and TS path
aliases. Neutral barrels/wrappers do not stop traversal. Tests, scripts and
workflows are also checked for Host import references. Auxiliary code is not a
second full-text domain scan. Standalone optional examples are separate; importing
one from core brings its complete dependency graph into scope.

Rules flag Email-prefixed path segments, mailbox identifiers (including camel
case), IMAP/SMTP identifiers, specific legacy storage/route tokens, sandbox send
schemas, mail-provider IDs and native/safe-compose/mailbox-list module names.
Token rules apply to paths as well as content, including otherwise empty files.
Ordinary login/contact email fields, `z.email()`, `mailto:` and transactional
notification delivery are allowed. Content rules ignore address spans, including
provider-named domains, while still checking other tokens on the same line.
This vocabulary check supplements behavior
and security tests; it cannot prove semantic neutrality.

Computed imports require explicit review. Their digest covers the enclosing
function, or file for a top-level import. In particular, the approved generic
external adapter loader is pinned with its hash and authority checks, not just
its import expression. Local imports that cannot be resolved fail for review.

## Adding a justified exception

Prefer removing the coupling or moving app code to its owner. If compatibility
or retained data requires an exception:

1. Build Kit and run `node scripts/check-app-boundary.mjs --findings` to inspect
   exact findings and context. This command only reports; there is no update or
   automatically bless command.
2. Add only the reviewed finding to `scripts/app-boundary-allowlist.json`, with
   `path`, `rule`, `token`, `digest`, `occurrences`, `reason`, `owner`, `issue` and
   `milestone`. Copy the SHA-256 digest from the report. Paths/tokens are exact,
   not patterns; the occurrence count prevents copying an approved line to add
   another unchecked occurrence. CRLF/LF are normalized. Non-import text context
   is the trimmed source line; import context is its AST declaration/expression.
3. Explain why the match is necessary, name an accountable owner and a real
   tracking issue, and specify a removal/review milestone. Historical migrations
   may say `permanent historical`; temporary Knowledge/Calendar/key-reference
   and Kit mail compatibility must say `to be removed by plan C/D`.
4. Include before/after findings in the PR review. Run the fixtures and checker
   again. Use `--verbose` to see file/line/rule/token and the applicable reason.

Missing, stale, duplicate, changed-context/count, malformed and wildcard-path
exceptions fail. Delete records when deleting or migrating code; do not retain
stale records or regenerate the baseline. After a Kit change, rebuild before
removing both source and generated-artifact entries. Tracking issue
[#382](https://github.com/Maneek21/Deft/issues/382) records the initial baseline.
Retained schemas are not authorization to drop data, edit historical migrations,
or retire custody keys. Those require the plan's migration gates.

## Host134 / Kit alpha.42 review

This gate is stacked on Kit extraction PR #407 and must land last, after #393,
#394, the Kit release and deft-email #12. The final endpoint has 1,274 exact
findings: 1,005 old records unchanged, 264 obsolete records removed, and 269
reviewed replacements/additions. The exact before/after identities and review
categories are in `docs/reports/2026-10-21-app-boundary-exception-review.json`.

The delta covers moved deprecated facades/optional examples (source and built
declarations), existing serialized field/triage spellings, the byte-preserved
Host128 lineage manifest, and test-only parity/loaders. It does not certify
completion of the deferred native Knowledge/Calendar caller migration.

The compatibility-facade-import rule has no exceptions: an allowlisted legacy
export graph cannot authorize a Host/core root, /experience, internal facade,
dynamic/require/type import or a neutral wrapper to re-enter it. All 18 positive
and negative fixtures must pass. There is no baseline-update command.
