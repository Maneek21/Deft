# Loop 1 operations evidence

Date: 2026-09-05. All credentials below were disposable test values. Existing
Loop 0 databases and images were read only. Disposable resources were removed
after each proof unless explicitly noted.

## L03 release files and upload persistence

The empty-directory release probe copied only `docker-compose.yml`,
`compose.prod.yml`, `compose.release.yml`, and `.env.example`, then ran the
published `ghcr.io/maneek21/deft:0.3.0-preview.14` image on a fresh volume:

```powershell
$env:COMPOSE_PROJECT_NAME='deft-preview-loop1-ops'
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml up -d postgres
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml run --rm init
```

Assertion: fresh-database detection, pgvector creation, schema push, supplemental
SQL, platform seed, four bundled skills, two task templates, and nine employee
templates completed. The exact Compose render contained zero bind mounts.

Published-image red probe:

```powershell
docker run -d --name deft-preview-loop1-upload-red `
  -v deft-preview-loop1-upload-red:/app/uploads `
  --entrypoint sh ghcr.io/maneek21/deft:0.3.0-preview.14 `
  -c "cd /app/apps/api && mkdir -p uploads && printf actual-file-store-write > uploads/path-probe.txt && sleep 300"
```

Assertion: `/app/apps/api/uploads/path-probe.txt` contained the marker while
`/app/uploads/path-probe.txt` was `MISSING`.

Corrected dual-mount proof recreated the container with the same named volume
mounted at `/app/uploads` and `/app/apps/api/uploads`. Assertion: both paths
returned `persisted-file-store-write` after recreation.

## L04 failure-stage recovery

Reusable harness: `scripts/selfhost-upgrade.test.ts`.

```powershell
.\node_modules\.bin\tsx.CMD --test scripts/selfhost-upgrade.test.ts
```

Assertions: a backup failure before migration restarts the previous container;
migration, target recreation, doctor, and smoke failures stop the application
and never start the previous image. The upgrade plan passes `--app-stopped` to
the complete recovery-set helper. The final plan order is stop writes, capture
the complete recovery set and old image identity, then pull/build the target,
migrate, recreate, doctor, and smoke. This prevents a mutable target pull from
replacing the only recorded image reference. During an upgrade backup, captured
legacy `/app/apps/api/uploads` files are copied into `/app/uploads` before the
old container can be recreated.

## L07/L08 frozen red and corrected OAuth behavior

Frozen baseline harness retained at
`C:/Users/Osheen Pradhan/Documents/Deft Main Repo/tmp/launch-audit-2026-09-05/security-probe.mts`:

```powershell
& 'C:\Users\Osheen Pradhan\Documents\Deft Main Repo\node_modules\.bin\tsx.CMD' `
  'C:\Users\Osheen Pradhan\Documents\Deft Main Repo\tmp\launch-audit-2026-09-05\security-probe.mts'
```

Observed assertions: unsigned GitHub callback returned 302, performed two mocked
provider requests, and wrote the supplied victim identity; 12 same-source public
DCR requests all returned 201 despite configured auth/default limit 1; malformed
object refresh input reached a TypeError and returned a plain-text 500.

Reusable corrected harness: `apps/api/test/oauth-public-hardening.test.ts`.
Assertions: 64 KiB overflow returns OAuth 413; null/object/array core fields return
structured 400; forged forwarded IP cannot bypass the global budget; GitHub
connect/callback return 404 and make zero provider requests.

The DB-backed suite used an upgraded clone only:

```powershell
$env:DATABASE_URL='postgres://preview:REDACTED@127.0.0.1:55439/preview_loop1_oauth'
corepack pnpm db:upgrade
.\node_modules\.bin\tsx.CMD --test apps/api/test/oauth-mcp.test.ts
```

Assertions: 10/10 passed, including DCR, PKCE exchange, refresh replay rejection,
revocation, MCP authorization, and acceptance-but-non-persistence of common DCR
extension metadata.

## L11 complete backup and clean-target restore

Reusable backup implementation: `scripts/selfhost-backup.ts`; parser harness:
`scripts/selfhost-backup.test.ts`. The helper was executed against fresh project
`deft-preview-loop1-backup`. Its final successful artifact contained a 70,122-byte
database dump, volume upload marker, legacy-container upload capture, `.env`,
running image ID, repo digest, and ten independently rechecked checksums; the
stopped app restarted.

The retained assertion summary for that disposable run is:

```json
{
  "checksumsVerified": 10,
  "uploadArchiveContainsMarker": true,
  "legacyCaptureContainsMarker": true,
  "databaseBytes": 70122,
  "envCaptured": true,
  "imageIdentityCaptured": true,
  "appRunning": true
}
```

Database and file restore assertions on disposable targets were:

```json
{
  "databaseRowsMatch": true,
  "migrationHead": "0.3.0-preview.27",
  "uploadHashesMatch": true,
  "keyringHashesMatch": true,
  "imageIdentityRecorded": true
}
```

The initial generic receipt assertion used a manually constructed HMAC and is
not App Run proof. It was superseded by restoring the synthetic
`preview_loop1_apps` database into `preview_loop1_receipt_restore` and running:

```powershell
$env:DEFT_RESTORE_PROOF_DATABASE_URL='postgres://preview:REDACTED@127.0.0.1:55439/preview_loop1_receipt_restore'
.\node_modules\.bin\tsx.CMD scripts/selfhost-verify-app-run-restore.ts
```

`AppRunSecretService.verifyReceipt` returned true for restored receipt key
`attempt-terminal:90045fb1-0ea1-47c1-a6d7-a8ff08d50439`, signing key `sig-v1`.
The verifier reconstructs the deterministic lifecycle fixture keyring and uses
the production canonical receipt verifier.
