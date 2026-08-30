# ADR: App Capability Risk and Review Policy

- Status: Accepted
- Date: 2026-08-29
- Implementation: deferred until Capability Service and App Runs

## Context

The existing native agent approval matrix uses `auto`, `quick`, and `full` tiers combined with `conservative`, `standard`, and `autonomous` trust. An Autonomous employee can execute ordinary `full` actions without a review unless the action is recognized as destructive.

That behavior remains the compatibility contract for existing native and Module actions. It is not an adequate safety floor for independently authored App capabilities, external effects, or unattended automation because an App must not classify its own risk or make `full` mean “always reviewed.”

## Decision

App capability policy is Deft-owned and orthogonal to the legacy numeric tier.

Each registered capability classification contains these closed host-owned facts:

- `risk_class`: `read`, `internal_write`, `external_write`, `destructive`, or `privileged`;
- `review_requirement`: `policy` or `always`;
- `review_scope`: `per_invocation`, `immutable_batch`, `approved_automation_definition`, or `forbidden_in_automation`;
- `retry_class`: `safe`, `idempotent_with_key`, or `unsafe_or_unknown`;
- data-egress and retention classifications defined by the host contract.

Actor trust and organization policy may satisfy `review_requirement: policy`. They can never bypass `review_requirement: always`.

A broader review scope satisfies `always` only through an explicit approval of an immutable definition that pins all executable inputs: resource/query revisions, content digest, provider/connector, limits, validity window, and relevant authorization versions. Every resulting external effect still receives its own idempotent App Run and receipt.

Standard interfaces receive a reviewed code-owned classification. App-private capabilities may declare schemas and descriptions, but those are untrusted and cannot set effective risk, review, retry, idempotency, egress, retention, automation eligibility, token scope, or grants.

A new private capability with a possible external effect defaults to:

```text
risk_class: external_write
review_requirement: always
review_scope: per_invocation
retry_class: unsafe_or_unknown
automation: forbidden
```

It remains disabled until an owner/admin binds a registered provider and accepts a Deft-owned classification with a bounded approval preview.

Execution rechecks the live actor, membership, App grant, resource context, connector/provider/runtime binding, schema digest, policy classification, and relevant authorization versions before approval and immediately before effect.

## Compatibility boundary

This decision does not silently migrate existing Deft, Module, employee, or human-MCP operations to App Runs. Capability Service extraction must preserve their current names, payloads, errors, scopes, budgets, connector behavior, and approval outcomes before App-originated behavior is introduced.

The first declarative App milestone contains no capabilities and therefore implements none of these fields. The vocabulary is frozen now so App package and grant work cannot later treat author-supplied approval metadata as policy.

## Rejected alternatives

- Reusing `full` as “always reviewed” is rejected because Autonomous currently bypasses ordinary full-tier review.
- Letting an App declare its effective tier or retry safety is rejected because the party requesting authority cannot define the enforcement floor.
- Approving an unbounded campaign or automation once is rejected because changing queries, content, providers, limits, or validity would silently widen the approved effect.

## Acceptance evidence

When implemented, tests must prove Autonomous cannot bypass `always`; provider/App metadata cannot lower host policy; immutable-batch or automation approval fails after any pinned input or authorization version changes; unsafe/unknown effects are not automatically retried; and every external effect has one App Run ancestry and receipt.
