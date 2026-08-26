# Hermes Native Platform Integration Decision

**Date:** 2026-08-26
**Status:** Accepted for implementation
**Baseline:** `b5d0bd47` on `codex/hermes-native-integration`
**Revisit:** After one matched preview release and two fresh-profile live gauntlets

## Decision

Deft will make the native `deft-platform` Hermes plugin the default delivery
adapter for newly onboarded Hermes employees. The existing Node Agent Channel
bridge remains in the matched bundle for one preview release as an explicit
rollback path, not as a second permanent architecture.

Both adapters use the same two authoritative interfaces:

1. Agent Channel v2 for employee-bound event delivery, claims, leases,
   cancellation, human follow-up, and terminal transport outcomes.
2. Deft MCP for employee-bound workplace reads and governed writes.

No database migration or parallel agent-only data model is introduced. Only
one adapter may actively consume Agent Channel work for an employee.

## Responsibility and trust flow

```text
Deft event
  -> Agent Channel bearer and fenced claim
  -> native plugin metadata-only delivery journal
  -> Hermes model, skills, tools, and private runtime state
  -> employee MCP bearer
  -> Deft authorization, policy, approvals, durable writes, and receipts
```

Deft remains authoritative for organization membership, tenant isolation,
shared Knowledge, task and conversation state, module grants, approvals,
receipts, and credential revocation. Hermes and its operator remain
authoritative for model/provider selection, reasoning, browser and research
tools, external MCP servers, skills, local memory, and gateway supervision.

Agent Channel acceptance means that Hermes durably accepted transport. It does
not mean the requested business work completed. Completion remains tied to
source-bound replies, governed MCP effects, and truthful task outcomes.

The native journal may retain only the accepted cursor, opaque event IDs, and
transport-acceptance flags for work whose required outward delivery is
incomplete. Source events are rehydrated from employee-scoped Deft after a
restart. The journal must not contain credentials, claims, source payloads,
prompts, chain of thought, tool transcripts, business records, or provider
payloads.

## Why this option

### Continue only with the external bridge

This is the smallest immediate release change and already has a commit-bound
certificate. It loses because it permanently duplicates lifecycle and process
supervision beside a Hermes runtime that already supports native messaging
platform plugins.

### Replace the bridge immediately

This gives the smallest steady-state system. It loses because the native
candidate has not yet been reconciled with the certified onboarding and
governance branch, included in the release certificate, or proven by two fresh
external profiles.

### Native default with a bounded bridge rollback window

Chosen. It preserves a reversible operational path while certifying the
smaller long-term interface. The rollback window ends after one matched preview
release, two consecutive fresh-profile live gauntlets, and sustained unattended
observation.

## Packaging and onboarding contract

The immutable Hermes integration bundle will contain:

- `deft-platform` as the default adapter;
- the Deft employee policy and memory plugins;
- the native readiness probe and direct HTTP MCP configuration;
- a manifest with Deft release, Agent Channel protocol, adapter versions,
  Hermes compatibility, required capabilities, and file checksums; and
- legacy bridge assets under an explicitly labelled fallback path during the
  rollback window.

Fresh onboarding must generate the native profile configuration. It must not
start both adapters or require a Deft source checkout. Readiness remains
separate from transport connectivity and requires the real certification
challenge.

## Failure and rollback behavior

- A second active adapter must not create a second concurrent runtime attempt;
  Agent Channel single-flight and fencing remain authoritative.
- A native restart resumes journaled accepted work and reuses source-bound
  idempotency. It must not guess a conversation for unsourced late output.
- Incompatible protocol or capability negotiation fails before event polling.
- Offline Hermes leaves queued Deft work intact and reports truthful runtime
  state.
- Rollback stops and disables `deft-platform`, revokes its credentials, issues
  fresh employee credentials for the matched legacy bridge, and lets expired
  native claims return to the queue. No data rollback is required.

## Acceptance evidence

Implementation is complete only when:

1. The native candidate is reconciled onto the certified baseline without
   replacing newer onboarding, memory, assistance, evidence, or budget policy.
2. Native chat, task, follow-up, cancellation, approval, restart, duplicate,
   stale-lease, credential-revocation, privacy, injection, and redaction tests
   pass through the public Agent Channel and MCP interfaces.
3. The release gate runs the native adapter suite, records adapter and bundle
   digests, and passes two clean-state runs for the exact release commit.
4. A fresh profile installs only from the matched bundle, passes readiness,
   completes the full employee gauntlet, restarts, and processes the next event
   without database, profile, service, or shell repair.
5. Two fresh independently hosted profiles pass consecutively and remain
   healthy through the agreed unattended observation window.

## Out of scope

- Hosting Hermes inside the Deft deployment.
- Moving Hermes models, skills, external MCP credentials, browser, research,
  goals, delegation, or private memory into Deft.
- Adding a generic adapter framework beyond the concrete Agent Channel and MCP
  seams.
- Removing the legacy bridge before the rollback exit criteria pass.
