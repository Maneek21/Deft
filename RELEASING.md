# Releasing Deft

This document describes how to cut a new Deft release.

## Versioning during alpha (0.x)

Deft is pre-1.0. The project uses a loose interpretation of SemVer during
alpha:

- **Minor** (`0.X.0`) — may include breaking changes to schema, API
  contracts, env vars, or wire formats. Read the CHANGELOG entry before
  upgrading.
- **Patch** (`0.X.Y`) — non-breaking fixes only. Safe to bump in place.

Tag format: `vMAJOR.MINOR.PATCH[-channel]`. During alpha the channel is
`preview` (for example `v0.3.0-preview.6`). Older docs mentioned
`alpha` / `beta` / `rc`; keep using `preview` unless the project
explicitly changes channel. Once 1.0 ships, the channel suffix drops.

The Git tag includes the leading `v`. The GHCR image tag does not:

```text
git tag     v0.3.0-preview.6
GHCR image  ghcr.io/maneek21/deft:0.3.0-preview.6
```

## Cutting a release

### 1. Pre-flight

On `master`, confirm required check-runs are green on the latest commit
(Type Check, Test API, Build, Production Image + Browser Smoke,
Versioned Upgrade, CodeQL). Dependency Review runs on pull requests, not
on push to `master`.

```bash
git checkout master
git pull --ff-only origin master
```

If Production Image + Browser Smoke or Versioned Upgrade is red, stop.
Releases must come off a green `master`.

### 2. Open a release-prep PR

```bash
git switch -c chore/release-vX.Y.Z-channel
```

Edit `package.json` (root) — bump the `version` field. Workspace
`package.json`s under `apps/` and `packages/` intentionally do **not**
carry independent versions; they all inherit the monorepo version.

Edit `CHANGELOG.md`:
- Write an accurate **delta from the previous tag**. Do not dump the
  entire `[Unreleased]` section if it still contains work that already
  shipped on an earlier tag.
- Leave a fresh empty `[Unreleased]` section at the top.
- Update the comparison links at the bottom of the file:
  ```
  [Unreleased]: https://github.com/Maneek21/Deft/compare/vX.Y.Z-channel...HEAD
  [X.Y.Z-channel]: https://github.com/Maneek21/Deft/releases/tag/vX.Y.Z-channel
  ```

If README or compose files still contain a placeholder image tag, replace
it with the GHCR tag (no leading `v`) in the same PR. Merge the prep PR
and push the annotated tag in the same release session so README never
points at a missing image.

Commit, push, open a PR titled `chore(release): vX.Y.Z-channel`, wait for
required CI (including Dependency Review), squash-merge.

### 3. Tag the release

After the prep PR lands on `master` and that merge commit's check-runs
are green:

```bash
git checkout master
git pull --ff-only origin master
git tag -a vX.Y.Z-channel -m "Deft vX.Y.Z-channel"
git push origin vX.Y.Z-channel
```

Use **annotated** tags (`-a`), never lightweight tags.

### 4. GitHub Actions publishes the image and Release

Pushing a `v*` tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml).
That workflow:

- builds and pushes the `linux/amd64` GHCR image
- publishes GitHub build provenance and keylessly signs the exact image digest
- verifies the Cosign workflow identity and provenance before continuing
- attaches the SPDX SBOM and corresponding source
- writes `release-manifest.json` (`license: AGPL-3.0-only`) with the digest,
  signing identity, and provenance type
- creates the GitHub Release (`--generate-notes`, prerelease when the
  version contains `-`)

**Do not run a second `gh release create`.** The workflow already creates
the Release. If notes need a license banner or highlights, edit the
Release body after the workflow finishes.

If packaging fails after the tag exists, **do not move the tag**. If the failed
run already completed image build, provenance attestation, and signing, fix the
workflow on `master`, dispatch it against the existing tag, and select
`reuse_existing_image`. Recovery then verifies and packages the original
tag-signed digest without rebuilding it. Do not select reuse when the original
image/signature steps did not complete. If the published image itself is
unusable, fix forward and cut the next preview tag.

Confirm the GitHub Release includes `LICENSE`, `NOTICE`,
`THIRD-PARTY-LICENSES.md`, `default.env.example`, the source archive, SBOM,
checksums, and compose files. Confirm the image label
`org.opencontainers.image.licenses=AGPL-3.0-only` (the production
`Dockerfile` sets this; `release.yml` passes `VCS_REF` and `SOURCE_URL`).
Run the digest-first Cosign and `gh attestation verify` commands in
[`docs/self-hosting.md`](docs/self-hosting.md) against the published manifest.
If signing, signature verification, provenance publication, or provenance
verification fails, the workflow must stop before the GitHub Release is
created.

## Hotfix releases

For an urgent fix on a previously released minor version:

1. Branch off the released tag: `git switch -c hotfix/vX.Y.Z+1 vX.Y.Z-channel`
2. Cherry-pick or land the fix.
3. Bump the patch number, update `CHANGELOG.md`, tag `vX.Y.Z+1-channel`.
4. Push the tag and let `release.yml` package it.
5. Open a PR to merge the hotfix branch back into `master` so the fix
   isn't lost when the next minor goes out.

## License and source artifacts

Every current-line release is licensed under [GNU AGPL v3.0 only](LICENSE).
Historical tags through `v0.2.0-preview.4` retain BSL 1.1 as shipped.
Do not rewrite those tags. GitHub's source archive plus the repository's
build and installation scripts are the Corresponding Source offered with
the official image.
