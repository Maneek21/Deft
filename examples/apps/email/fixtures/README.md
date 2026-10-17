# Retained Email SDK fixture

The standalone legacy regression graph pins `../deft-app-kit-0.1.0-alpha.9.tgz`.
The exact original archive is tracked so a clean frozen install does not depend on
private deployment artifacts. Its SHA512 matches the unchanged legacy lockfile.
The archive is not rebuilt, repacked, or substituted with the current Author Kit.

Its metadata says alpha.9 while its exported contract says alpha.7. This historical
mismatch is preserved and is not an advertised supported SDK. Current authoring
uses the separate current Kit contracts; this fixture serves legacy tests only.

`app-kit-alpha9-corresponding-source.tar.gz` includes original preferred TypeScript
source, build input and shared schemas, plus a pinned standalone reconstruction
recipe. Its public `reconstruct-javascript.mjs` checks all 27 emitted JavaScript
modules byte-for-byte. Extract the source archive and follow its README; no private
retained source is required. See SDK9-PROVENANCE.json for immutable hashes.

The isolated clean install used only the original package.json, pnpm-lock.yaml and
SDK archive: pnpm 10.33.1 `install --ignore-workspace --frozen-lockfile` succeeded
with 50 dependencies and left manifest/lock bytes unchanged. The graph has exactly
one local file/tarball dependency, this archive; other dependencies retain registry
integrity pins. Production Docker uses seven workspace importers and no local
SDK archive. The source is AGPL-3.0-only; the corresponding-source archive includes LICENSE.

The source archive is part of this Host source offer. Its NOTICE attribution
references the parent repository THIRD-PARTY-LICENSES.md, which is also publicly
tracked here.
