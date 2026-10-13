# Email Stage1 demo candidate preparation

This records local builds and concrete demo rollout evidence gates. The live
demo still runs its old image/schema. Root has staged private configuration and
a read-only runtime module separately, and relocated six verified old archives;
these actions have not switched the live app or changed its database. Later code
changes require a new frozen candidate and manifest.

## Decision and observed baseline

Use the existing production `Dockerfile`, built with the existing Linux Docker
engine in WSL `Deft-CRM-Test`, then transport one compressed image. This keeps web,
API, App Kit, database upgrader, doctor and smoke on the same frozen source.
An API-only patch would leave the native composer and reviewed policy contracts
behind. A full build on demo is unsuitable on this constrained shared host; no remote
build, image pruning, new registry or new host infrastructure is part of this plan.

Read-only checks on 2026-09-30 found local Docker29.1.3/linux/amd64 and Buildx0.30.1,
with 941 GiB free on the existing WSL filesystem. Docker Desktop is stopped but is
not needed. Windows C: has about80 GiB free for staging artifacts. Demo runs
Compose project `app`, app image
`sha256:cc29882edfc5acccef992bfe6efed242756b2249d3f3fc57c107089f18237381`,
based on `0c611bb4b1a000e8b4a066f71974137e5c0f31cd`. The root's last schema
observation was56; this lane has not queried or mutated the demo database.
The existing candidate `/opt/deft/candidates/gate-g-demo-20260928` has an80 MiB
source staging tree, not this Stage1 candidate. Its old images and the running
Email1.5.5 runner do not prove compatibility with the new custody interfaces.

## Local build and identity

From the Windows source worktree:

```powershell
node scripts/stage-email-demo-candidate.mjs --output C:/tmp/deft-email-host-candidate-20260930-01 --build
```

The new output directory is required; the script refuses to overwrite a prior
candidate. It freezes tracked and nonignored source, excludes generated trees and
private-looking files, and refuses concurrent source edits during the freeze.
Physical migration bytes are preserved unless an explicit deployed baseline
supplies verified historical bytes as described below. `source-files.json` binds every path/length/SHA256;
`candidate-manifest.json` binds the dirty base revision, aggregate source digest,
source archive, all declared migrations after56, build arguments, image ID and compressed
image digest. This is an identified dirty-source candidate, not a signed release
or a claim that the base Git commit alone contains its changes.

The script uses the normal Dockerfile with frozen lockfile installation and
`NEXT_PUBLIC_FEATURE_{HUDDLES,APPS,APP_RESOURCE_SYNC,APP_ATTACHMENT_BROKER}=true`
plus the self-hosted UI flag, matching the prior demo build. Runtime authorization
flags and credentials remain governed by the existing private demo configuration.
Public URLs use the existing startup placeholder injection. The image embeds its
exact source archive under `/releases/deft-source-email-stage1-<source_digest>.tar.gz`
and its generated final Compose overlay selects that source offer. Validate that
public archive hash after any eventual start. No placeholder source offer may be
used for a network-visible modified deployment.

`build-local.sh` can retry a failed local build from this frozen source without
resnapshotting; the existing Docker cache is reused. A retry alone does not update
the manifest's built status, so retain its image inspection/archive checksums and
refresh final identity before deployment. No local database is contacted by build.

After the completed60 lane is reviewed and frozen, adding `--owner-connections`
emits the new default-off `DEFT_APP_OWNER_CONNECTIONS_ENABLED=true` runtime opt-in
into the candidate overlay. The script refuses this option against a target
below60. The API additionally requires Apps and its existing attachment-broker
conjunction. The flag grants no access by itself: Protocol7 reviewed
`owner_connections`, current immutable admin admission and exact member-owned
consent remain mandatory. It is absent from the provisional59 overlay.
Private registry/module/custody mounts remain a separate reviewed root-owned
configuration; this opt-in never selects a browser-provided module.

The completed provisional59 build is in
`C:/tmp/deft-email-host-candidate-20260930-01`: frozen install, App Kit build,
Next compile/typecheck/static generation and image packaging exited0. Its frozen
source digest is `9aff35671e07e25b9f540a423c669aad7fef00e1b7d8c8331a74dd705f63840f`.
`image.tar.gz` is401,720,171 bytes, SHA256
`a2da5b47c67bce4c28108be97f62818273d30d2ae0df2855a83713fa537dcf7f`.
The Docker29 index identity is
`sha256:e08b2c092a1da6834d0fcb5e3f7843f178e71fbd893490815fa568f16183864d`;
the saved amd64 platform configuration is
`sha256:c97f7d39f96fca93d47a45e89da3da5178b55162dc72ac0c91d2c287a5b5010e`.
Use the saved platform configuration as the portable loaded-image comparison;
index representation can differ between Docker stores.

`image-verification.json` records an exit0 `docker run --network none` metadata
check of57–59 checksums, embedded source archive, reviewed PDF policy and callback
route. `image-size-proof.json` records the layer-byte proof. These checks use no
database or provider. A separate cold API `tsc --noEmit` attempt inside this image
exhausted Node's default heap and exited1 without compiler diagnostics; it is
unverified by that attempt and was not retried. The API lane owns the final
current-source typecheck. This provisional image precedes final60 and Email1.5.9
source changes; it is not the final matching deployment artifact.

## Deployed historical migration bytes

Root's real demo56 restore reproduced a checksum refusal for preview.2. The current
source/Git blob is LF SHA256 `ed5ae4bd8f3f5da989d5d632b73011bae5619a614ee81b4a8387feff7ca9d835`;
the live container and applied ledger use CRLF SHA256
`e10b7282f30aabee269bca331bdd73c91a076754282504d809445c75029975d9`.
Candidate01 copied the LF bytes and is therefore unsuitable for that deployed
history. Preserving checkout bytes alone did not establish compatibility.

A bounded read-only ledger SELECT and live SQL export are in
`C:/tmp/deft-email-demo-migration-baseline-20260930/baseline-manifest.json` and
`sql/`. All53 applied SQL files match their recorded checksums and current source
byte for byte after only CRLF→LF comparison;33 differ physically. No ledger,
working-tree migration or remote file was changed. The baseline checksum itself
and actual upgrade remain gates of root's restored-database rehearsal.

The smallest adequate correction is explicit deployment-byte overrides in the
candidate, rather than guessing an EOL normalization or changing history. The
stager accepts `--migration-baseline <absolute manifest>`, checks exact declared
historical paths, ledger/export hash and content equality modulo CRLF/LF, and
records both raw-worktree and effective-source hashes for each changed file.
Unknown/future paths, altered content, missing entries or checksum mismatch fail
closed. The candidate manifest identifies the public baseline export hash and
live image; its source archive/offer contains the actual effective bytes. The
baseline is operator-observed evidence, not a signed release attestation.

The corrected60 source-only freeze is
`C:/tmp/deft-email-host-candidate-20260930-02/source`. It certified a local
populated 56→60 database upgrade with the same maintenance scripts. Host03 then
built successfully with the same verified baseline. Its full local DB/uploads
restore booted the actual API/Next entrypoint and passed doctor (8 checks), but
health/ready incorrectly reported schema 56 against ledger 60. It is not
deployable. Its Email 1.5.9 activation also correctly refused one historical
unknown inbox sync Run; reviewed closure must preserve unknown/no-retry evidence.

The stager now requires frozen `DEFT_SCHEMA_HEAD` to equal the declared migration
head, then verifies the packaged source constant using a network-none container.
A focused negative fixture rejects host03. Actual restored-host health/ready
still needs verification because a packaged constant alone is not runtime proof.
After the schema fix and reviewed closure pass their focused checks, make a fresh
matching freeze:

```powershell
node scripts/stage-email-demo-candidate.mjs --output C:/tmp/deft-email-host-candidate-20260930-04 --migration-baseline C:/tmp/deft-email-demo-migration-baseline-20260930/baseline-manifest.json --owner-connections --build
```

`--owner-connections` requires this explicit baseline. Root can use the corrected
frozen upgrade directory read-only for its restored clone rehearsal without
changing the live56 database. Never waive the checksum guard or bulk-rewrite
historical source files.

## Transfer and cutover after the evidence gates

The final image transfer/cutover commands have not been executed. First check compressed image size plus
expected new Docker layer bytes, stopped-point backup size and safety margin
against fresh demo `df`/Docker disk metadata. On this shared host, transfer/load may
still be blocked even though the build is off-host. Retain the current running
image and complete recovery set; do not use blanket Docker prune or delete another
workload's resources. A streamed load avoids storing both image archive and
unpacked image on demo, but its real incremental layer/storage requirement must
still fit. Exact pruning or added disk requires its own operator decision.

The provisional archive contains23 layers:402,381,323 compressed blob bytes and
1,117,773,824 uncompressed layer-tar bytes, whose SHA256s match its platform
configuration's `diff_ids`. This is a portable byte measurement, not a filesystem
allocation or peak Docker-load measurement. The corresponding image's major
directories occupy about1.18 GB. Root subsequently relocated exactly six old
archives after verifying all 1,485,162,767 bytes in protected off-host copies;
free space increased from 2,684,243,968 to 4,169,437,184 bytes. No images, volumes
or broad prune were removed. With no observed shared old/new layer identities, this does
not establish enough capacity for both compressed content, new snapshots, load
temporary files and continued operation of the other live workloads.

Use an off-host recovery stream and a locally verified streamed image load;
do not retain a second401,720,171-byte image archive on demo. A conservative
preflight budget is `2 × uncompressed_layer_tar_bytes + 2 × compressed_blob_bytes
+ runtime_allocated_bytes + backup_working_bytes + 1 GiB reserve`; confirm the
final candidate's measurements and the actual storage driver's peak allocation.
For the provisional image that is4,138,341,398 bytes before backup working files.
Host03's measured 23 layer streams total402,686,730 compressed and1,118,188,544
uncompressed tar bytes; the same bound is4,139,781,652 bytes, only29,655,532 below
the latest observed free space. Require fresh free space to cover the final
candidate's measured budget and backup working bytes. This is a staging admission budget, not a
claim that Docker always allocates twice each representation. No broad prune is
appropriate on this shared host. A cold-load rehearsal belongs on a disposable
Linux Docker store with enough room: record `df` before/during/after the load,
loaded platform config digest and retained image size, then compare its peak
increment plus reserve with fresh demo free space. Such a store has not been
created by this lane.

Root's fresh read-only baseline measured `app_pgdata`210,182,144 bytes,
`pg_database_size(deft)`62,602,263 bytes, `app_uploads`344,064 bytes, old
`email-state`294,912 bytes and the old private directory20,078,592 bytes.
These are inputs to a backup plan, not backup/archive sizes or a stopped recovery
point. Stream the logical database dump, uploads and protected configuration/
credential custody directly to an encrypted off-host destination; verify hashes,
permissions and restore before cutover. Avoid an on-server duplicate recovery
tree. The two app upload mounts are the same named volume and need only one
canonical volume archive; inspect/capture any legacy writable-layer paths too.

Verify `SHA256SUMS` locally before transport. For a sufficiently provisioned host,
the same candidate archive can be loaded without a remote build:

```bash
sha256sum -c SHA256SUMS
gunzip -c image.tar.gz | ssh -i /path/to/deft_test root@demo.deft.ing docker load
```

Never pipe the gzip archive directly to `docker load` without locally validating
its manifest/checksum first. Copy only `compose.email-stage1.yml` and public
candidate evidence into a new remote candidate directory; private configuration
stays in the existing live release directory. Inspect the loaded image ID against
the manifest. Preserve Compose project `app`, Postgres and `app_uploads` volume.

The current live directory is
`/opt/deft/releases/e3cd40c7c7a800164fbc452692d41f6980065b0a`. Its app container
records this ordered Compose chain: `docker-compose.yml`, `compose.prod.yml`,
`compose.release.yml`, `compose.demo.yml`, `compose.local-image.yml`,
`/opt/deft/candidates/gate-g-demo-20260928/compose.gate-g.json`, followed by
`compose.patch.json`, `compose.defty-copy.json`, `compose.discovery.json` from
`/opt/deft/candidates/gate-g-demo-fixes-20260928`. Reconfirm those labels before
cutover. Append the new `compose.email-stage1.yml` **last** and use the live
directory as `--project-directory` plus its existing `.env` as `--env-file`.
The generated overlay sets all five app/tool services to the same local candidate,
`pull_policy: never`, and `build: !reset null`; leave Postgres/Caddy unchanged.
Use `config --quiet` and `config --images`, never print resolved secret environment.

After reconfirming that chain, construct the command explicitly:

```bash
LIVE=/opt/deft/releases/e3cd40c7c7a800164fbc452692d41f6980065b0a
CAND=/opt/deft/candidates/email-stage1-FROZEN_SOURCE_DIGEST
OLD=/opt/deft/candidates/gate-g-demo-20260928
FIX=/opt/deft/candidates/gate-g-demo-fixes-20260928
dc=(docker compose -p app --project-directory "$LIVE" --env-file "$LIVE/.env"
  -f "$LIVE/docker-compose.yml" -f "$LIVE/compose.prod.yml"
  -f "$LIVE/compose.release.yml" -f "$LIVE/compose.demo.yml"
  -f "$LIVE/compose.local-image.yml" -f "$OLD/compose.gate-g.json"
  -f "$FIX/compose.patch.json" -f "$FIX/compose.defty-copy.json"
  -f "$FIX/compose.discovery.json" -f "$CAND/compose.email-stage1.yml")
```

With that reviewed operator Bash array:

```bash
"${dc[@]}" config --quiet
"${dc[@]}" config --images
"${dc[@]}" run --rm --no-deps upgrade sh -c 'pnpm db:upgrade --status'
"${dc[@]}" run --rm --no-deps upgrade sh -c 'pnpm db:upgrade --dry-run'
# After a complete stopped-point recovery set and a passing migration rehearsal:
"${dc[@]}" run --rm --no-deps upgrade
"${dc[@]}" up -d --no-build --no-deps --force-recreate deft
"${dc[@]}" run --rm --no-deps doctor
"${dc[@]}" run --rm --no-deps smoke
```

The status/dry-run are future read-only DB operations, not evidence obtained by
this lane. The target image contains the supported ledger migrations57(owner
targets),58(reviewed PDF) and59(private files/action payloads). Use only the
versioned upgrader; do not use `init`, `db:push-full`, raw SQL migration commands
or schema sync on demo. A disposable database restored from the stopped backup
must first demonstrate56→59 and idempotent rerun using the exact candidate image.
Seed/adoption, real Email module/runtime deployment and OAuth client configuration
are separate root-owned reviewed steps. This candidate does not enable native
Gmail OAuth or claim ordinary-member Email setup works.

## Recovery and completion gates

Before migration stop the app and every external writer for the demo workspace,
including its separately supervised Email runner; retain unresolved action/Run
identities and never resend during recovery. Follow `docs/self-hosting.md`'s
complete stopped-point recovery set: PostgreSQL dump, uploads, any legacy writable
uploads, exact private `.env`/keyrings, all site overlays, image identity and
checksums. Preserve the runtime's independently held credential custody/config
under its own boundary too. Protect backups and copy a verified recovery set
off the near-full host. The candidate's source-only manifest contains no secrets.

The initial provisional freeze targets59; it does not contain the completed
ordinary-member owner opt-in lane. That lane is adding60. A final freeze must
derive its actual target and exact migration list from the copied upgrade manifest,
then rehearse56→that target rather than reuse this provisional59 result.

## Existing operator files and public setup seams

Filename-only read-only inventory found these older deployment helpers; they are
not certified for the refreshed package and must not be rerun blindly:

- `/opt/deft/candidates/gate-g-demo-20260928/install-email.mjs`,
  `install-remote.py`, `cutover.py`.
- That candidate's `email-runner/` and `email-runner-isolated/` contain
  `setup-context.mjs`, `owner-session.mjs`, `create-config.mjs`, `supervisor.mjs`.
- `/opt/deft/candidates/gate-g-demo-fixes-20260928/runner-context/` has equivalent
  runner files; its cutover scripts are `cutover-patch.py`, `cutover-discovery.py`
  and `cutover-defty-copy.py`.

Root's later public-source inspection found no systemd unit for the historical
runner. Its supervisor pins App Kit alpha.6 and starts seeded IMAP/SMTP fixtures
and legacy scalar workers. Preserve its exact image, private configuration and
`/opt/deft/candidates/gate-g-demo-20260928/email-state` (mounted at `/private`)
in recovery. It must not be relabeled as a Gmail1.5.9 runner. The new controlled
Send needs a separately reviewed one-shot executor with current leases and frozen
module bytes; no such executor has been started here.

The current public manager setup path is implemented by
`routes/app-attachments.ts`, `lib/app-attachment-review.ts`,
`lib/app-runtime-upgrade.ts`, `lib/app-resource-sync-management.ts` and
`lib/app-runtime-management.ts`. Its exact ordering is:

1. Stage a fresh Protocol7 composition package as the JSON package body to
   `POST /api/apps/blob/composition/stage`, or preserve an existing installation
   with `POST /api/apps/blob/composition/:installationId/upgrade/stage` and the
   `AttachmentUpgradeStageSchema` envelope. The existing Email installation
   should use that reviewed upgrade path, not a duplicate lineage or SQL patch.
2. Read `GET /api/apps/blob/composition/:installationId/context?app_version_id=...`
   (or `.../upgrade/context`). Submit the host's exact `review_request` to the
   matching `.../review` route, then `.../activate` with that request plus
   `expected_review_digest` and `accept_host_policy:true`. Package, requested
   grants and lifecycle/grant epochs come from the host; do not fabricate digests.
3. For the existing manager-owned path, read
   `GET /api/apps/blob/sync/setup?installation_id=...&operator_user_id=...`.
   Select the reviewed `inbox` descriptor's `consent_request`, nominate the exact
   account `target_key`, and submit to `POST /api/apps/blob/sync/reviews/prepare`.
   Submit the same closed request plus returned `expected_review_digest` and
   `accept_host_policy:true` to `/api/apps/blob/sync/bindings/activate`. Attachment
   limits/expiry and resource operations are independently reviewed. Record the
   returned resource binding and registration identities privately.
4. Read `GET /api/apps/blob/composition/:installationId/runtime/context?app_version_id=...`.
   Select each reviewed action's `review_request`; include the exact
   `owner_resource_binding_id` from step3. POST to
   `/api/apps/blob/composition/runtime/reviews/prepare`, then
   `/api/apps/blob/composition/runtime/bindings/activate` with the returned review
   digest and accepted host policy. `send_message` uses retained draft/MIME payload
   custody; reply remains limited until its trusted-parent work is complete.
5. The authenticated **operator** obtains the technical resource lease from
   `POST /api/apps/blob/sync/bindings/:bindingId/sessions` and action lease from
   `/api/apps/blob/composition/runtime/bindings/:bindingId/sessions`. Both use
   closed `{}` bodies and their distinct session credentials/claims. Schedule a
   sync through `/api/apps/blob/sync/bindings/:bindingId/sync`; use the existing
   v3 resource and v1 Runtime channels. Never treat a technical lease or
   `runtime_epoch` as account-owner consent or account OAuth epoch.
6. The owner opens `POST /api/app-experiences/:installationId/:experienceKey/sessions`
   with `resource_target_key`. The same authenticated SID performs
   `/sessions/:sessionId/access/review` with `{}`, followed by `/access/accept`
   with exact `review_token`, `review_digest`, `accept_exposure:true`. This current
   accepted exposure is separate from resource/action consent.
7. Only after the private registry is pinned and the host restarted does Email
   Settings call `/sessions/:sessionId/connections/begin`, `callback`, `manage`.
   The browser completes OAuth under the same SID, then obtains current status.
   No direct retired `/api/connections` provider OAuth route is involved.

Step3/4 manager-owned consent does not enable an ordinary member. The new60 lane's
saved, not yet deployment-certified `/api/app-owner-connections` routes are:
`GET /:installationId/context`; admin-only `POST /admissions/review`,
`/admissions/activate`, `/admissions/:admissionId/revoke`; owner-only
`POST /resources/review`, `/resources/activate`, `/actions/review`,
`/actions/activate`. Admin admission nominates a fixed operator and policy ceiling;
the member obtains the exact admission reference/context, reviews and accepts
their own resource target and paired action. Closed bodies are defined in
`app-owner-connection-contract.ts`; fresh context supplies digests/epochs.
Obtain final compiler/DB proof from that lane before a final candidate; saved
routes are not evidence of deployed ordinary-member functionality.

`DEFT_APP_CONNECTION_ADAPTERS_CONFIG` selects a private POSIX0600 registry file
outside source. Each `deft.app_connection_adapters.v1` entry is closed to `pins`,
`module_path`, bare64hex `module_sha256`, `options`. Pin current org, owner,
installation, version, effective grant, target, `inbox` resource/binding and paired
`send_message` action/binding using the actual reviewed API results. The module
entry point is Email `providers/connection-http.mjs:createAppConnectionAdapter`.
Its options select origin, account ID, provider, independent account authority
epoch, target/resource/action pins and configured capability ceiling; OAuth clients,
custody key/version/root stay private. A grant/version/binding upgrade requires
fresh matching pins and current consent; do not relabel or rebind old ciphertext.
The registry hashes its entry file only, so freeze/hash all module dependencies
and use a deployment-owned read-only module mount. Mount encrypted credential
custody separately with the module's fsync/CAS contract. Missing/mismatched pins
or config fail closed; credentials never travel through the browser setup DTO.

The Google Cloud project/client, redirect registration
`https://demo.deft.ing/apps/connections/callback`, module/runtime credentials and
operator supervision are root-owned private preparation. None was configured by
this lane. The new host image alone cannot connect Gmail or dispatch a real Send.

## Separate runtime dependency bundle

After the root-owned Email/Kit executable freeze and frozen consumer install:

```powershell
node scripts/stage-email-runtime-bundle.mjs --output C:/tmp/deft-email-runtime-candidate-20260930-03 --consumer C:/tmp/deft-email-launch-stage0-consumer-20260930 --host-manifest C:/tmp/deft-email-host-candidate-20260930-01/candidate-manifest.json
```

The script resolves only the installed production closure of `@deft/app-kit`,
`nodemailer`, `mailparser` and `imapflow`. It follows `createRequire` from each real
package location, follows required/installed optional and peer dependencies,
copies each exact resolved package version and reconstructs its nested
`node_modules` links in existing WSL ext4. The completed03 bundle has48 package
versions/66 nested dependency links. Do not flatten by name: different `entities` versions expose
incompatible APIs.

Only Email root/provider runtime `.mjs` and its package declaration are included;
tests and private credentials/configuration are excluded. Concurrent source or
installed dependency edits fail the freeze. The manifest records every file/hash,
package/version, nested dependency edge, entry-module hash and archive digest. It
compares Email bytes to the selected host snapshot; a false match requires a fresh
host build for final rollout. Package version alone does not attest App Kit byte
identity: final host-built SDK artifact digests must match the installed SDK bytes.
The first attempt correctly refused a concurrent edit and certified no archive.
The02 offline import check reproduced a missing `selderee` peer link;03 fixes
that exact resolution and includes the link manifest in its aggregate identity.
01/02 are historical attempts and must not be selected for rollout.

03's source digest is
`36798a2bbd4c22137184470e3b2aa737534b315d58b8283e2da64a2666e6cfba`.
Its3,637,138-byte archive SHA256 is
`75afdecc19f3f9c778afa6d953a8d0cd33fc478d91f5a116245df69c8434a26d`;
2,377 physical files contain16,751,367 bytes and the assembled Linux tree occupies
24,289,280 bytes. Entry `connection-http.mjs` SHA256 is
`adcc9c80d8222f6bcec13610cc3cae703cc3c6694401683df74a5e15a72f0ecf`.
`runtime-verification.json` records exit0 imports of all four dependency roots,
the actual connection factory, outgoing runtime and current recipient verifier,
using read-only mounts and `--network none`; no function, database, custody write
or provider action was invoked. Both host/bundle App Kit dists contain87 files
with aggregate digest `cadc8b86160201e95ba92de44006c63fc823429a5985a411d60eeba73149f445`.
Current Email differs from the provisional host at `build.mjs`, `package.json`
and `providers/recipient-verification.mjs`, so the final host must be freshly
frozen and matched again; this bundle alone is not a matching-host certificate.

Mount extracted code/dependencies read-only at `/opt/deft-email-module`, with the
entry `email/providers/connection-http.mjs`; bind the private0600 registry read-only
at its configured absolute path and custody at a separate private writable POSIX
location. Pin the entire bundle digest as well as the entry hash; the registry
hashes only the entry. Existing1.5.5 supervision/bootstrap is not automatically
compatible with1.5.9. Root must review current operator supervision and credentials
against the new admission and lease contracts.

## Restore and remaining proof

57–59 (and the forthcoming60) are forward-only. After a successful migration the old app image is not a
supported rollback against schema59. Rollback means stopping all candidate
writers, restoring the56 database/upload recovery point into a clean isolated
project, selecting the exact previous image plus preserved configuration/keyrings,
verifying doctor/smoke and receipts, then switching traffic. This loses writes
accepted after the recovery point. Rehearse restore; never improvise a downgrade
or silently restart the old image against a newer ledger.

Before eventual exposure require: exact image/source/archive identity; matching
doctor matching the final declared schema; no unintended public Postgres port; sign-in/core health;
current source-offer hash; root-owned owner opt-in/connection proof; and the real
native saved-draft+PDF Send/receipt pipeline. UI fixture success and a Docker build
alone do not establish Gmail delivery. Deployment, migration, restore rehearsal,
OAuth secret configuration and live Email delivery remain unexecuted here.
