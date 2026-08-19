# Deft bundled modules

This directory contains immutable offline snapshots of first-party declarative
modules. The authoring source normally lives in a standalone Git repository;
`modules.lock.json` pins the exact source commit, canonical manifest digest,
and vendored file used by Deft.

Do not edit a vendored manifest without updating its source project and lock.
Use `pnpm module:vendor` from a clean source worktree after validation. The
command proves the exact `HEAD` blob and `origin`, enforces source and version
continuity, and updates the snapshot plus lock under an exclusive writer lock.
`pnpm module:verify` also cross-checks this directory against the runtime
bundled catalog, so a hardcoded-only or unlocked module fails CI.
