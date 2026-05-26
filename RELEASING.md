# Releasing Deft

This document describes how to cut a new Deft release.

## Versioning during alpha (0.x)

Deft is pre-1.0. The project uses a loose interpretation of SemVer during
alpha:

- **Minor** (`0.X.0`) — may include breaking changes to schema, API
  contracts, env vars, or wire formats. Read the CHANGELOG entry before
  upgrading.
- **Patch** (`0.X.Y`) — non-breaking fixes only. Safe to bump in place.

Tag format: `vMAJOR.MINOR.PATCH[-channel]` where `channel` is one of
`alpha` / `beta` / `rc`. Examples: `v0.1.0-alpha`, `v0.2.0-beta`,
`v1.0.0-rc.1`. Once 1.0 ships, the channel suffix drops.

## Cutting a release

### 1. Pre-flight

On `master`, verify the four required CI checks are green:

```bash
git checkout master
git pull origin master
gh pr checks --required  # or visit the most recent commit's checks page
```

If any required check is red, fix that first — releases must come off a
green master.

### 2. Open a release-prep PR

Create a branch and update both the version and CHANGELOG in one PR:

```bash
git switch -c chore/release-vX.Y.Z-channel
```

Edit `package.json` (root) — bump the `version` field. Workspace
`package.json`s under `apps/` and `packages/` intentionally do **not**
carry independent versions; they all inherit the monorepo version.

Edit `CHANGELOG.md`:
- Move every item under `[Unreleased]` into a new section
  `[X.Y.Z-channel] — YYYY-MM-DD` placed directly below `[Unreleased]`.
- Leave a fresh empty `[Unreleased]` section at the top for next time.
- Update the comparison links at the bottom of the file:
  ```
  [Unreleased]: https://github.com/Maneek21/Deft/compare/vX.Y.Z-channel...HEAD
  [X.Y.Z-channel]: https://github.com/Maneek21/Deft/releases/tag/vX.Y.Z-channel
  ```

Commit, push, open a PR titled `chore(release): vX.Y.Z-channel`, get the
required CI checks green, squash-merge.

### 3. Tag the release

After the prep PR lands on `master`:

```bash
git checkout master
git pull origin master
git tag -a vX.Y.Z-channel -m "Deft vX.Y.Z-channel"
git push origin vX.Y.Z-channel
```

Use **annotated** tags (`-a`), never lightweight tags — the release page
shows the annotation message and `git describe` works correctly.

### 4. Create the GitHub Release

Extract the `[X.Y.Z-channel]` section of `CHANGELOG.md` into a temp file
`release-notes-X.Y.Z.md`, then:

```bash
gh release create vX.Y.Z-channel \
  --title "vX.Y.Z-channel" \
  --notes-file release-notes-X.Y.Z.md \
  --prerelease   # omit once on 1.0+ stable
```

`--prerelease` flags the release as not-production-ready. Drop the flag
on `1.0.0` and later stable releases.

### 5. (Optional) Publish Docker image

The `Docker Image Build` CI job builds the production `Dockerfile` on
every PR but does not push to a registry. To publish a tagged image,
build and push manually:

```bash
docker build -t ghcr.io/maneek21/deft:vX.Y.Z-channel .
docker push ghcr.io/maneek21/deft:vX.Y.Z-channel
```

Or set up a `release.yml` workflow triggered on tag push that authenticates
to GHCR / Docker Hub and pushes. Not wired up yet during alpha.

## Hotfix releases

For an urgent fix on a previously released minor version:

1. Branch off the released tag: `git switch -c hotfix/vX.Y.Z+1 vX.Y.Z-channel`
2. Cherry-pick or land the fix.
3. Bump the patch number, update `CHANGELOG.md`, tag `vX.Y.Z+1-channel`.
4. Push the tag and create the GitHub Release as above.
5. Open a PR to merge the hotfix branch back into `master` so the fix
   isn't lost when the next minor goes out.

## License-date implications

[BSL 1.1](LICENSE) auto-converts each release to Apache 2.0 four years
after the release date. The release date is the tag date (the date of
the annotated tag, not the prep-PR merge). Keep this in mind when
back-dating tags is tempting — don't.
