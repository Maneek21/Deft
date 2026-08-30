# Declarative App v0 Threat Model

**Status:** Accepted entry contract for the first App implementation loops

**Baseline:** `origin/master` at `e05471f17e2c12adced54c3d5d88ab63e980f09a`

**Scope:** package inspection, staging, activation, navigation, and exact included Module artifacts for declarative App v0

## Security objective

Installing a declarative App v0 must add no execution or authority path. The package may describe identity, display metadata, exact immutable Module artifacts, and closed navigation to Deft-rendered Module views. Everything else is rejected before persistence.

Inspection writes nothing. Staging grants nothing and creates no navigation. Activation is an owner/admin-confirmed transaction over one organization-scoped App lineage and its exact App-owned Module versions. Disable removes access/navigation and preserves data.

## Trust boundaries

The App package, provenance text, license identifier, display labels, descriptions, Module manifests, file paths, MIME declarations, navigation keys, and future unknown fields are untrusted author input.

Only Deft code may:

- resolve the current organization and membership;
- decide lifecycle authorization;
- mint the workspace-local lineage and installation identity;
- validate package bytes and included Module manifests;
- bind App and Module versions;
- write active pointers and audit state;
- expose navigation after activation;
- advance the lifecycle epoch on disable.

The package cannot name an organization, user, role, grant, token audience, connector, provider, secret, runtime, endpoint, worker, schedule, approval policy, or entitlement that the host accepts as authority.

## Allowed v0 surface

The authoritative parser will accept only:

- strict App schema/protocol version;
- reverse-DNS App identity and semantic version;
- bounded display metadata, declared SPDX license metadata, and provenance claims shown as untrusted until verified;
- exact canonical App-owned Module artifacts with path, MIME, length, and digest;
- closed navigation that resolves only to included Module collections/views;
- deterministic package index and whole-package digest.

Unknown fields are rejected, not ignored or retained for later activation.

## Threats and required controls

| Threat | Required control | Evidence loop |
|---|---|---|
| Module manifest smuggles code, network access, secrets, or authority | Frozen strict Module schema `1`; table-driven top-level and nested rejection tests | Loop 1 |
| App metadata smuggles later planes | Strict App v0 schema rejects capability, connector, secret, experience, runtime, sync, automation, public, grant, and entitlement blocks | Loop 2 |
| Path traversal, symlink, device path, absolute path, or case collision escapes the package | Canonical relative path grammar; physical-path containment; symlink rejection; Windows case/confusable collision checks | Loop 2 |
| Declared MIME or extension hides active/executable content | Closed JSON-only MIME set in v0; byte parsing is authoritative | Loop 2 |
| Mutable bytes are swapped after inspection | Content-address every entry and pin a canonical whole-package digest through staging and activation | Loops 2–4 |
| Claimed publisher replaces another App | Host-minted workspace-local unsigned lineage; claimed publisher is display metadata only | Loops 3–4 |
| Staging exposes data or navigation | Staged state has zero rights, no active pointers, no nav, and no inbound discovery | Loops 3–4 |
| Partial activation exposes App without its Modules, or Modules without App | One caller-owned transaction and deterministic identity locks; post-commit effects only | Loops 3–4 |
| Cross-tenant IDs bind another organization's App or Module | Organization-scoped composite keys, live membership checks, and negative service/database tests | Loops 3–4 |
| Disable leaves stale access | Installation lifecycle epoch, live enabled check, immediate nav/cache invalidation | Loops 4–6 |
| Package creates hosted-service dependency | No registry, entitlement, billing, telemetry, or call-home field/path | Loops 2–6 |
| Display text becomes instructions or markup | Bounded plain text; no HTML, control, bidi, or active URL fields | Loops 1–2 |
| App license metadata is mistaken for legal verification | Display declared metadata and provenance; do not infer compatibility or rights | Loops 2–6 |

## Forbidden concepts and fixture routing

Loop 1 freezes Module schema `1` against top-level and nested variants of at least:

```text
scripts, entrypoints, endpoints, tools, mcp_servers, capabilities,
connectors, secrets, network, webhooks, triggers, schedules, jobs,
workers, cron, sql, runtime, skills, workflows, custom_experience,
public_routes, trust_level, approval_tier, scopes, permissions,
grants, entitlement, billing, and pack
```

Loop 2 repeats the relevant concepts against the new App v0 parser and adds traversal, symlink, absolute/device path, duplicate path, case collision, Unicode-confusable path, MIME mismatch, oversize, malformed JSON, duplicate identity, unsupported protocol, and digest mismatch fixtures.

The deny vocabulary is test documentation and defense in depth. Strict closed schemas remain the primary enforcement; matching a safe-looking key never authorizes it.

## Explicitly absent boundaries

There is no custom browser experience in App v0, so iframe/CSP/storage isolation is not part of this milestone. The browser spike is required before a later custom-experience manifest block is frozen.

There is no capability or runtime, so approval execution, encrypted Run input, provider calls, connector credentials, and remote data release are not part of this milestone. Their previously accepted policy vocabulary cannot appear in the v0 package.

There is no uninstall in the first lifecycle slice. Disable plus truthful retained-data visibility is safer until export, shared ownership, dependency, and deletion semantics are implemented.

## Exit gate

Persistence work cannot begin until the Module perimeter tests pass and the App v0 parser work lists a hostile fixture for every threat assigned to Loop 2. A newly requested v0 field that implies execution, authority, external communication, background work, custom UI, or commercial entitlement reopens the architecture gate.
