# ADR: App Platform Foundation and Dual Deployment Boundary

- Status: Accepted
- Date: 2026-08-29
- Implementation baseline: `origin/master` at `e05471f17e2c12adced54c3d5d88ab63e980f09a`
- Supported database upgrade floor: `v0.2.0-preview.1`

## Context

Deft needs to let users build applications that participate in the workspace rather than appear as disconnected sidecars. The platform must work first as an open, self-hostable product and later as the same workspace data plane inside a managed SaaS with optional paid Add-ons.

The shipped Module system is a strong declarative record primitive, but it is not an installation, permission, execution, custom-UI, runtime, synchronization, public-ingress, or commercial-entitlement model. Expanding `deft.module.json` into an executable plug-in format would collapse those trust boundaries.

## Decision

Deft will build a first-class App Platform above the closed Module contract.

- **App** is the user-facing installed product unit.
- **App package** is an immutable, versioned artifact set inspected, staged, reviewed, and activated by Deft.
- **App lineage** is the upgrade identity allowed to inherit one installation's bindings and grants. Initial unsigned lineages are workspace-local; portable lineage requires later verified provenance.
- **App installation** is the organization-scoped lifecycle and authorization identity.
- **Module** is a closed declarative provider for structured records and Deft-rendered views.
- **Resource** is a stable, permission-checked noun that can be resolved, related, searched, cited, and acted upon.
- **Capability** is a typed verb governed by Deft policy and implemented by a registered provider.
- **Experience** is either Deft-rendered declarative UI or an isolated custom UI surface.
- **Runtime** is separately operated computation outside Deft's trusted API, worker, and web processes.
- **Connector** is an organization-owned credentialed provider connection.
- **Add-on** is a commercial catalog offer that may include an App, managed runtime or connectors, operations, usage, support, or an SLA.
- **Entitlement** answers whether a commercial offer is available. It is never a workspace permission or approval.

`ResourceRef` is the transport-neutral identity of a resource provider, registered resource type, and provider-local resource ID. Existing identities such as `module_record:<id>` remain compatibility forms. This decision freezes the meaning, not the future wire schema; Resource Service must define and validate that schema before Apps can request generalized resource access.

An App **grant** is an append-only organization-approved snapshot of the exact resource rights, capability interfaces, connector/provider bindings, runtime/public/automation rights where applicable, and authorization versions accepted for one App installation/version. Requested rights are untrusted input and never a grant. Declarative App v0 has no generalized grant fields and stages with zero rights.

App lifecycle and protocol failures follow Deft's established structured error terminology: a stable machine `code`, safe human `error` message, HTTP status where applicable, and optional bounded safe `details`. Internal exceptions retain their cause for logs but never expose raw stacks, secrets, package bytes, database details, or untrusted active content. The opening HTTP lifecycle follows the current Module projection `{ error, code, details? }`; MCP and later protocol adapters preserve the same code and safe meaning in their transport envelope.

The initial App v0 is declarative only: exact included Module artifacts plus closed navigation. It has no executable code, capabilities, grants, connectors, secrets, custom UI, runtime, automation, synchronization, public ingress, or entitlement fields. Unknown future-plane fields are rejected.

## Data plane and commercial control plane

Self-hosted and hosted Deft use the same App package, App Protocol, workspace data model, authorization services, and lifecycle behavior.

The workspace data plane owns organization data, membership, App installations, resources, grants, approvals, runs, receipts, audit, and live authorization. It remains useful without a hosted registry, Deft account, billing service, entitlement service, telemetry service, or managed runtime.

A future hosted control plane may own customer accounts, provisioning, plans, billing, catalog offers, entitlements, rollout policy, and managed-service operations. It cannot grant workspace resource access or lower an approval floor. Initial SaaS should provision isolated workspace cells using the supported one-workspace deployment contract before any shared-database multi-tenancy claim.

Non-payment or entitlement loss may stop new managed-service work according to the commercial contract. It must not silently widen or rewrite grants, delete workspace data, erase receipts, or prevent a supported export.

## Authority and principals

App packages request composition; Deft code and an authorized workspace role grant authority. The initial organization-scoped lifecycle requires a live owner or admin to stage, activate, upgrade, disable, or bind an App.

Effective authority is the intersection of:

```text
current actor authority
∩ current App installation grant
∩ current resource security context
∩ current provider/connector/runtime binding
∩ current deployment/operator policy
```

Commercial entitlement is evaluated separately as product availability and never appears in this authorization intersection.

Human, employee, automation, runtime, developer-pairing, and public principals remain distinct. A principal cannot be represented by the installing owner, inherit an ambient browser session, or exchange one credential audience for another.

Inspection writes nothing. Staging creates immutable zero-rights state and no navigation. Activation is one transaction across the App and included Module pointers. Disable advances an installation lifecycle epoch, removes App access/navigation, and preserves data. Old work is never silently rebound to a new version.

## Feature gates

The logical gates are `apps`, `app_runs`, `resource_service`, `custom_experiences`, `runtimes`, `sync`, `automation`, and `public_ingress`. A gate is implemented only with the first real route or behavior it controls. Later planes remain absent rather than represented by unused abstraction or flag code.

Self-hosted operation defaults every unfinished plane off. A hosted deployment may apply a stricter operator policy, but it cannot make a package mean something different at the App Protocol boundary.

## Migration and rollback

The implementation begins from the baseline above. Fresh schemas use `pnpm db:push-full`; the supported release path uses `pnpm db:upgrade` from `v0.2.0-preview.1` or later.

Opening migrations are additive. Existing Module IDs, manifests, versions, records, relations, views, APIs, tools, and navigation remain compatible. App activation must compose Module lifecycle work through one caller-owned database transaction; it cannot nest an independently committed Module lifecycle operation.

Code rollback is supported only while the previous supported image can ignore the additive App structures. No unsafe schema downgrade or reinterpretation of existing Module data is promised.

## Rejected alternatives

### Turn Module manifests into executable plug-ins

Rejected because arbitrary code, secrets, endpoints, permissions, workers, and migrations would enter the trusted process and make every installation a supply-chain and tenant-isolation event.

### Build a separate SaaS fork

Rejected because package compatibility, authorization behavior, migrations, and self-host parity would drift. Hosted differentiation belongs in operations and the commercial control plane, not a second workspace kernel.

### Build all future platform seams before the first App

Rejected because it freezes hypothetical abstractions without a user-visible proof. Each plane is added only when a proof App requires it and can certify its trust boundary.

## Acceptance evidence

The opening milestone must prove one deterministic declarative App can be built from a clean external project, inspected, staged with zero rights, activated atomically, opened, disabled, and retained without editing Deft core. The identical package must work in self-hosted and hosted workspace data planes, and self-hosting must work with Deft-hosted infrastructure blocked.

The architecture is revisited if App/Module activation cannot commit once, the public App kit requires private database types, a commercial entitlement is proposed as authorization, or a future plane must be persisted before its host exists.
