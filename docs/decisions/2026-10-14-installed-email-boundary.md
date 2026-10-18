# Installed Email boundary

Status: implementation in progress; not accepted or deployed.

## Decision

Email is an independently packaged installed App and external Runtime. Deft
provides generic identity, installation, authorization, trusted presentation,
reviewed actions, execution receipts and native resource integration. Author Kit
defines and validates those public contracts. Core Deft does not ship a mailbox
product or require an Email-specific provider adapter.

Reuse the existing declarative renderer, packed Kit, Email build script and
public sideload workflow. Generalize only contracts exercised by Email. Move
mailbox/provider semantics into Email; retain reusable bounded field, document,
file and exact-action controls in Deft. Standard field formats may be reused
across apps, but the Host must not select behavior by Email app IDs, action names,
provider names or fixed mail field names.

Frozen Protocol 1/2 sandbox compatibility remains for older connected apps.
Current Email uses Protocol 7 and does not depend on that interface. Retiring
the unrelated compatibility plane would change existing Campaigns/CRM behavior;
it is outside this proof. Standard iCalendar parsing is a neutral shared utility.
Historical native storage and completed-adoption source readers remain, subject
to current authority; preserved data does not grant access to unadopted sources.

An optional mail package compiled into the Host would retain the dependency.
A new arbitrary UI/plugin execution plane adds unnecessary scope. Neither is
part of this change.

## Invariants

- Tenant, actor, account, installation and current grants remain Host authority.
- Reviews bind exact saved revisions, content, files and prepared actions.
- Domain interpretation and provider credentials remain Runtime-owned.
- No automatic replay of uncertain external effects.
- Existing custody, drafts, receipt history and citations are preserved.
- Native writes are retired without recreating pending or uncertain sends.
- Historical migrations are immutable; removal of UI is not deletion of data.

## Acceptance

Build Email using packed public Kit dependencies outside the Deft checkout.
Freeze the generic Host image and Kit identity. On a fresh workspace with no
native Email execution, sideload, connect, read, save/reopen a draft with a file,
review and send once, independently verify delivery, and resolve a Task source
backlink. Verify supported delegated tools through app declarations. Restart the
Runtime without losing state. Change and upgrade Email only against the same
Host, including App-owned draft behavior and a declared UI change.

Run affected isolation, expiry, exact-input and uncertain-outcome regressions,
then consolidated integration checks on the candidate tree. Existing failed
provider-publication and security gates remain explicit until resolved. Preserve
old evidence; capture fresh screenshots and video for this candidate.

## Delivery

Separate Kit, Host and Email review changes. No merge, auto-merge, release tag or
release publication is authorized by this implementation. Final handoff includes
all PRs, actual validation, remaining limitations and recommended merge order.

Optional Host recipient autocomplete is removed from this preview; manually entered mailbox pills and independent Cc/Bcc controls remain available.
