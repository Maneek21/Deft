# Deft module distribution v1

**Status:** accepted for implementation

**Date:** 2026-08-18

**Scope:** tasks 9–11 of the module productisation roadmap

## Decision

A Deft module has two distinct forms:

1. **Authoring project.** Usually its own Git repository, with a README,
   screenshots, fixtures, contribution policy, license, and one
   `deft.module.json` file.
2. **Runtime artifact.** Exactly one immutable, canonicalised
   `deft.module.json` document identified by its module id, semantic version,
   and SHA-256 digest.

Deft never executes code from a module repository. GitHub is an authoring and
collaboration surface, not a runtime dependency. An install snapshots and
validates the manifest; it never follows a mutable branch after installation.

This separation gives community modules normal GitHub contribution workflows
without turning a Deft server into a package manager, build service, or remote
code execution host.

## V1 installation channels

### Bundled

The core repository vendors a canonical manifest plus provenance lock for each
first-party module. CI verifies the manifest digest against the lock. Bundled
modules work offline and never fetch GitHub at install time.

### Sideloaded

An owner or admin uploads a local `deft.module.json` file in Settings. The API
reads at most 128 KiB, rejects unknown keys and executable content, validates
the complete contract, canonicalises it, computes its digest, and installs the
immutable snapshot transactionally.

V1 does not accept a URL, repository name, archive, JavaScript, CSS, SQL,
images, prompts, secrets, OAuth configuration, webhooks, or network access.

### Hosted registry

The hosted registry stores the same immutable canonical manifest. A registry
record adds distribution metadata outside the runtime manifest: publisher,
license, repository, release commit, moderation status, signature, reviews,
and commercial terms. Clients install a registry snapshot by digest, not by
fetching the publisher repository.

The first community release can omit payments, reviews, and signatures. The
data model must still distinguish registry metadata from the execution
manifest so those systems can be added without changing module semantics.

## Why modules should usually have their own repositories

- contributors can discuss and review a module without touching Deft core;
- maintainers can release and deprecate modules independently;
- each module has an explicit license and ownership boundary;
- issues, fixtures, screenshots, changelogs, and domain expertise stay close
  to the module;
- the hosted store can index multiple publishers without accepting code into
  the Deft monorepo.

Small private modules do not require a remote repository. A local folder with
the same files is a complete authoring project.

## Reference repository shape

```text
deft-module-contacts/
├── deft.module.json       # the only runtime artifact
├── README.md              # purpose, screenshots, field model, install steps
├── LICENSE                # AGPL-3.0-only for first-party modules
├── CHANGELOG.md
├── CONTRIBUTING.md
├── fixtures/
│   └── demo-records.json  # development/test data; never installed
├── screenshots/           # store and README media; never installed
└── .github/workflows/
    └── validate.yml       # runs the Deft manifest validator
```

The repository may use any editor or coding agent. Deft consumes only the
manifest.

## Core vendoring and lock format

The Deft core tree keeps offline snapshots under:

```text
modules/
├── modules.lock.json
└── bundled/
    └── contacts/
        └── deft.module.json
```

`modules.lock.json` records, for each bundled module:

- module id and version;
- canonical manifest digest;
- source repository URL;
- exact source commit;
- relative vendored manifest path; and
- license identifier.

No Git submodules are used. A sync command may update a vendored snapshot, but
the reviewed manifest and lock change are committed directly to core. Builds
and self-hosted installs therefore remain deterministic and offline.

## Authoring commands

The core repository exposes four commands backed by the same shared contract
used by the server:

- `pnpm module:init <directory>` creates a minimal repository template;
- `pnpm module:check <path>` validates size, schema, references, defaults, and
  safe text, then prints the canonical digest;
- `pnpm module:format <path>` writes the canonical JSON representation;
- `pnpm module:vendor <path> --source <url> --commit <sha>` copies a validated
  first-party manifest into `modules/bundled` and updates the lock.

The validator also publishes a JSON Schema for editor completion. The Zod
contract remains authoritative.

`module:init` accepts only a nonexistent or completely empty destination and
uses create-only writes; it never mixes a scaffold into an existing project.
`module:vendor` accepts only a tracked `deft.module.json` in a completely clean
local Git worktree. The supplied repository must match `origin`, the supplied
full commit must be `HEAD`, and the canonical manifest digest must match the
exact blob at that commit. Updates preserve module id, slug, repository, and
license, require a strictly newer semantic version, and require the new commit
to descend from the previously locked commit.

Vendoring rejects symlinked distribution paths, holds an exclusive writer lock,
stages and fsyncs both files, then replaces the manifest before using the lock
as the commit point. An interrupted two-file replacement therefore fails
closed under `module:verify` rather than silently accepting mixed provenance.
The verifier checks both directions: every offline artifact and every runtime
bundled manifest needs the same lock entry, version, and canonical digest, and
every lock entry must be represented by both.

## Install and upgrade semantics

Installation is keyed by organisation plus both module id and slug. Concurrent
attempts serialize at the database boundary; one succeeds and later attempts
return the stable already-installed error.

An upgrade:

1. validates and canonicalises the new manifest;
2. requires the same module id and a strictly newer semantic version;
3. inserts an immutable version snapshot;
4. validates every live record against the target collection and field model;
5. updates each record's validated-version pointer and the active-version
   pointer in one transaction; and
6. emits one metadata-only invalidation after commit.

If any record is incompatible, nothing switches. V1 does not run author code
or data migrations. Rollback is allowed only after the same full-record
validation against the target version.

## Sideload API and UI

The control plane lives under Settings → Modules:

- `POST /api/modules/sideload` accepts a raw JSON body or multipart file with a
  hard 128 KiB request limit;
- `POST /api/modules/:slug/upgrade` accepts a local manifest and the expected
  active digest;
- lifecycle metadata remains visible to owners/admins when a module is
  disabled, while module data stays inaccessible;
- responses contain the canonical digest and validation issues, never echo a
  full untrusted manifest into audit metadata.

The browser reads the file locally, shows name/id/version/digest and requested
collections, then requires explicit confirmation. There is no URL field.

## Trust and supply-chain rules

- manifest labels, descriptions, and record values are untrusted data;
- all size and character limits apply before persistence;
- installs and upgrades require owner/admin membership at execution time;
- cross-organisation identifiers return not-found;
- module writes continue through the existing Defty/MCP trust, approval,
  budget, health, audit, receipt, and idempotency controls;
- the runtime never renders module HTML or loads remote module media;
- a repository URL in registry metadata is informational and never fetched by
  a self-hosted Deft server;
- registry signing, when added, signs the canonical manifest digest plus
  distribution metadata, not a mutable repository reference.

## Contribution workflow

1. Fork or create a module repository from the template.
2. Change `deft.module.json` and fixtures.
3. Run `module:check` locally and in CI.
4. Open a pull request with a semantic version bump and screenshots.
5. Publish a GitHub release pinned to the reviewed commit.
6. For bundled modules, open a Deft core PR that vendors the exact validated
   manifest and updates `modules.lock.json`.
7. For hosted distribution, submit the release commit to the registry, which
   snapshots the manifest and records its digest.

## Task 11: Contacts extraction

Contacts becomes the reference `deft-module-contacts` AGPL repository after
the deeper CRM manifest and generic runtime are stable. The extraction is
complete only when:

- the standalone repository validates in isolation;
- Deft core vendors its manifest and records the source commit/digest;
- no Contacts-specific service, MCP, Defty, search, or renderer branch exists;
- a clean self-hosted install works without network access;
- a local sideload of the same manifest produces the same digest; and
- the repository README documents contribution, versioning, screenshots, and
  compatibility.

## Explicitly deferred

- executable module code or custom React components;
- install from arbitrary URL or Git branch;
- archives containing assets;
- module-specific database migrations, workers, triggers, OAuth, secrets, or
  network calls;
- transitive module dependencies;
- automatic background upgrades;
- registry payments, ratings, publisher verification, and revocation feeds.

These are separate product and security decisions. They are not implicit in
the v1 repository model.
