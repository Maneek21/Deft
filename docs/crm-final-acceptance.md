# CRM final acceptance ledger

Status: **closure review in progress** (September 17, 2026). This ledger is a
historical evidence checkpoint for the current review; it is not a release,
deployment, final score, or live-success declaration. Its partial and covered
rows remain subject to source reconciliation, final integrated acceptance, and
human review. The walkthrough video remains cancelled.

The runtime identifiers below refer to an immutable deployed checkpoint. They
do not identify the final candidate while closure review is still changing
shipped source or documentation. This ledger and the linked review documents
are supplemental documentation updated after that build; their text must not
be treated as contents of the deployed archive.

| Gate / required outcome | Evidence and artifact | Candidate status | Review action |
| --- | --- | --- | --- |
| G1 — candidate identity and scope | Immutable runtime image digest `c0ba185a24194f4e3d53542b112a879b56ad1b1e4673897e839ac86720a1782f`; source tree `f30532fbafd37a8772500d3c898f24a157f0ff09`; archive `fa1fff5eb774ba5ad878a0403d701e66f3b8518375eec94453d7cc2093c0ad9a`; post-update baseline snapshot `sha0d6fa274d43b5c67b88a1d9aaa2effd3b3dfb8bca7095f452945e520ba8dfb69`; backup `/opt/deft/backups/crm-final-20260916T210645Z` | **Candidate identity evidenced** | Root records final hosted package/app/module digests and confirms the review docs are supplemental to the immutable build. |
| G2 — hosted upgrade and preservation | `docs/superpowers/audits/2026-09-16-crm-resumed-acceptance.md`; latest hosted lifecycle evidence; exact baseline unchanged after adoption and controlled restart; backup `/opt/deft/backups/crm-final-20260916T210645Z` | **Covered by agent-operated hosted evidence; human sign-off pending** | Human reviewer confirms the recorded invariants and preservation result. |
| G3 — human CRM workflow and responsive UI | Resumed acceptance report; `tmp/crm-wrap-up/resumed-web-build.log`; `resumed-navigation-tests.log`; retained screenshots and `chrome-e2e-flagship-review.md` | **Partial** | Fresh desktop/mobile walkthrough of the final host, including names, archive transition, date entry and connector-free path. |
| G4 — data, permissions, recovery and limits | Resumed acceptance report; `tmp/crm-wrap-up/resumed-demo-data.log`; `tmp/crm-final-20260917/manual-browser-evidence.md`; `boundary-review.md`; cache regression/focused web evidence (10/10 regression, 26 focused web checks, all green) | **Cache blocker resolved; hosted recovery review open** | Root verifies the repaired review surfaces in the final host and reruns live invariants for permissions, recovery, limits and disable/re-enable. |
| G5 — assistant collaboration | `tmp/crm-wrap-up/model-driven-local-sanitized.log` proves Codex discovery plus one create/get/update/readback; current scope retains Defty and Codex only | **Partial; Claude deferred by user scope** | Root runs the bounded Defty/Codex task and outreach continuation; verify returned IDs, receipts and no duplicates. |
| G6 — App activation and sandbox authority | Hosted connected App `1.9.0` activated; ordinary UI sandbox connection is full-review guarded stdio; exact-message approval and verified receipts are recorded in `tmp/crm-final-20260917/hosted-final-evidence.md` | **Covered by agent-operated hosted evidence; human sign-off pending** | Human reviewer confirms receipt metadata and no external delivery claim. |
| G7 — public author/operator handoff | `tmp/crm-wrap-up/release-validation-crm-author.log` (3/3 packed author tests); external artifacts and hashes in resumed acceptance; Sol’s repair routes through Settings → Apps upload/inspect/stage | **Partial** | Independent operator installs the exact package through the documented UI on a disposable host; verify fresh install and existing-install adoption. |
| G8 — final review and quality decision | Plan `outputs/CRM-flagship-wrap-up-plan-2026-09-17.md`; this ledger; source/release copies | **Pending** | Review changed code in dependency order, inspect unintended files, then assign separate visual/workflow/integration scores with observations. |

## Artifact identities currently evidenced

- App Kit: `@deft/app-kit@0.1.0-alpha.3`.
- Module: `com.deft.contacts@1.8.0`.
- Connector-free App: `org.deft.contacts-crm-app@1.8.0`, Protocol v0.
- Connected App: same App ID at `1.9.0`, Protocol v1.
- Independently exported base SHA-256: `B8DCD0A4C3610E6341F381F2E9D948AB1640F6D6E21538D1DB1BAE168D749559`.
- Independently exported connected SHA-256: `939703C4863E265A729CAD4593097497F79754E25F87746CAEDE2B1BF7C357EF`.

These identities describe retained evidence and must be compared with the
final candidate before approval. A package build or test count does not prove
host installation, live authority, or human usability.

## Historical isolated execution evidence

Root created a fresh isolated database with `db:push-full`, completed normal
no-AI signup, inspected/staged/activated the external connector-free base CRM
package at 1.8 with zero App rights, and exercised a human path: Northstar
Studio, Avery Chen, the USD 18,000 Pilot deal, a completed call linked to all
three, and native follow-up `CRV-1` through Today → Done in Tasks. The summary
refreshed immediately and the completed task left the open queue. This is
isolated candidate evidence; it does not close hosted activation, sandbox
connector, final cache-isolation, or human sign-off gates.

Sol reports cache repair regression 10/10, 26 focused web checks, TypeScript and
lint passing, with the repair present in the release and canonical copies.
Independent review signed off the generic label (36 shared checks plus 4 DB
checks). The hosted lifecycle and activation checks remain open.

## Human review checklist

1. Use the documented Settings → Apps upload/inspect/stage route with the exact
   base and connected JSON artifacts. Record the operator, host, timestamp and
   package digests; do not use `install-local` for the exported CRM package.
2. Walk the fictional fixture from company/contact discovery through deal,
   activity, native Task completion, draft outreach, exact-message review and
   sandbox receipt. Report sandbox acceptance as sandbox acceptance; never as
   delivery.
3. Repeat import repair, duplicate handling, archive/restore, stale submission,
   denied access and App disable/re-enable on disposable data. Confirm linked
   Tasks, relationships, revisions and protected records survive.
4. Run manual CRM with no AI provider and no mail connector. Confirm ordinary
   CRM work remains usable and unavailable connected actions explain setup.
5. Run the Defty and Codex governed assistant cases with the existing authorized
   OAuth connection and least required scopes. Capture canonical IDs, revisions,
   approvals and receipts; verify scope and denial behavior where a disposable
   connection is used. No temporary token is required or claimed. Claude remains
   explicitly unverified and deferred by scope.
6. Inspect desktop and 390px mobile in light and dark modes, including focus,
   keyboard/touch behavior, long labels, loading/empty/error/denied states and
   date entry. Record any remaining blocker with exact reproduction.

Until source reconciliation, integrated acceptance, independent review, and
the applicable human checks are complete, refer to the work as **closure review
in progress**, not release-ready, a final candidate, or a blanket 9/10. The
execution workspace holds the current evidence-reuse matrix; it is intentionally
not linked from this portable repository document.
