# Deft bundled modules

This directory contains immutable offline snapshots of first-party declarative
modules. The authoring source normally lives in a standalone Git repository;
`modules.lock.json` pins the exact source commit, canonical manifest digest,
and vendored file used by Deft.

Do not edit a vendored manifest without updating its source project and lock.
Use `pnpm module:vendor` after validation.
