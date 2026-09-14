# Documentation examples

These examples target `v0.3.0-preview.15`. Use fictional data in a disposable workspace.

- `vendor-pilot/deft.module.json`: a two-collection Module for the [Module tutorial](../tutorials/first-module.md).
- `operations/backup-release.sh`: a backup example for a release-image deployment using Docker named volumes. It also saves legacy container uploads when present. Run `bash backup-release.sh` from the release folder, or add `--leave-stopped` before an upgrade.
- `operations/restore-release.sh`: a restore rehearsal in a new Compose project. Export `RECOVERY` (the absolute recovery-folder path) and `DEFT_RESTORE_IMAGE` (the saved immutable image digest) before running it. It refuses an existing target project or directory. Optional `RESTORE_PROJECT` and `RESTORE_DIR` choose other names; defaults are `deft-docs-restore` and `deft-restore`.

The Bash examples are for Linux. On Windows, use WSL with Docker integration; Git Bash needs its Docker path-conversion behavior accounted for. Rehearse on an isolated host because restored jobs and configured integrations can resume with the app.

Before upgrading an older deployment, copy captured legacy uploads into the persistent volume as described in [self-hosting](../self-hosting.md#upgrading). Restoring an older image also requires its original upload path and any source-mounted files; the restore example targets preview.15.

Validate the manifest from the repository root:

```bash
pnpm module:check docs/examples/vendor-pilot
```
