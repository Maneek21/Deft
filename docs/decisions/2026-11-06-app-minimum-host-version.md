# Minimum Host version for Apps

Status: proposed on 6 November 2026. Not approved and not implemented. This is a design only.

Line references are to `v0.3.0-preview.140` (`cd1618d6`, which is also current `master`) unless marked **#424**. Those refer to the `release/email-ready-20261104` head, `6bf020eb`. Rules for the Email, Host and Kit split are in [App boundaries](../app-boundaries.md).

## Recommendation

1. **Add one optional manifest field, `compatibility.min_host_version`.** An App uses it to state the oldest Host it can run on.
2. **Have the Host read that field before it runs strict validation**, at install and at open. This ordering is the core of the design. Packages that need a newer Host are the same packages strict validation rejects, so a check placed after validation would never run.
3. **Do not block #424.** No new field can improve what already-deployed Hosts do. Stating the Host floor in Email's release notes remains the right answer for those Hosts.
4. **Fix how the Host reports its version first.** Source-built Docker images currently report `0.3.0-preview.16`, which would wrongly refuse Apps.

Two findings change the framing of the original brief:

- **Email on alpha.43 is refused at install on preview.140, not at open.** An installed Email keeps working. The real defect is an unreadable error message.
- **The failure that does happen at open is a different one.** An App under the size cap that uses a newer Worker feature installs cleanly on an old Host. The Host then ends the session when the Worker sends that view. Schema checks cannot see this, and it is the strongest reason to add a declared floor.

## What the code does today

### Unknown fields are rejected everywhere

A Host at preview.140 rejected an unknown field at every structural location tested below. It did not ignore one.

Free-form value slots do exist, such as the `seed` map in a record intake (`packages/app-kit/src/record-intake.ts:7`). They don't change the conclusion, because no Host code would read a floor from them. Module artifacts were not part of this test.

The manifest, package, experience reference and bundle schemas are all `z.strictObject`: `packages/app-kit/src/core.ts:1031`, `:1033`, `:1055`, and `packages/app-kit/src/experience.ts:40`, `:58-71`. Every package admission goes through `verifyDeftAppPackageJson` (`core.ts:2068`), which parses against those schemas and then checks each Experience artifact (`core.ts:1941`).

I tested this by building a Protocol 7 package and verifying it with the preview.140 Kit source. An unmodified package was accepted, so each rejection below comes from the change listed.

| Change to a valid package | Result on preview.140 |
| --- | --- |
| New key at manifest top level | Rejected: `Unrecognized key` |
| New key in `manifest.compatibility` | Rejected: `Unrecognized key` |
| New key in `manifest.provenance` | Rejected: `Unrecognized key` |
| New key on the package envelope | Rejected: `Unrecognized key` |
| New key on the experience reference | Rejected: `Unrecognized key` |
| New key inside the bundle, digests recomputed | Rejected: `Unrecognized key` |
| Bundle `schema_version` set to `v5` | Rejected: union mismatch |
| Unknown value in renderer `capabilities` | Rejected: invalid value |
| Protocol 8 and `deft.app.package.v8` | Rejected: falls through to the v0 schema |
| Stored manifest carrying a new key, read with `parseAttachmentAppManifest` | Rejected |

### Over-cap packages fail at install

The Worker source cap is 96 KiB (98,304 bytes) at `experience.ts:14`, enforced at `experience.ts:74`. #424 raises it to 112 KiB (`experience.ts:15`, **#424**). Because `verifyPackage` runs that check, the cap applies to install as well as to open. In the test, a package with a 100,966-byte (98.6 KiB) Worker built with the #424 Kit passed on the #424 Kit and failed on the preview.140 Kit with `Worker source exceeds 96 KiB`.

All package admission funnels through `inspectAppPackageJson` (`apps/api/src/lib/app-service.ts:174`):

- `app_versions` rows are only inserted at `app-service.ts:265` and `:379`.
- Those inserts sit in `stageAppPackage` (`:217`) and `stageAppUpgrade` (`:317`), and both call inspect first (`:224`, `:325`).
- The entry routes are `apps/api/src/routes/apps.ts:176`, `:202`, `:219`, `apps/api/src/routes/app-developer.ts:43`, and `apps/api/src/routes/app-attachments.ts:94`, `:235`.

So on preview.140:

- **New install:** Settings > Apps calls `/api/apps/inspect` first (`apps/web/src/app/(app)/settings/apps/apps-client.tsx:61`). The Host returns 400 `APP_INVALID_PACKAGE` (`app-service.ts:178-182`). The message is the raw Zod issue JSON, and the page shows it as is (`apps/web/src/lib/apps.ts:1288`).
- **Upgrade:** the same refusal happens before the upgrade transaction starts (`app-service.ts:325`), so the active version stays active.

### What does fail at open

Three cases reach open or later. The first is the one that matters.

1. **Worker features the old Host does not know.** Views come from the Worker at run time, so they are not in the package and no install check can see them.

   #424 adds `connection_action` to buttons. On preview.140 the button parser allows a fixed key list without it (`apps/web/src/lib/app-experience-bridge.ts:177`). An unknown key makes the parser return `null`, a null child fails the parent (`:211-212`), and a failed view revokes the bridge (`:414`). The Kit does not filter this: its `render` posts the view unchecked (`packages/app-kit/src/experience-core.ts:271`, **#424**). An App under 96 KiB that sends this button installs cleanly, then loses its session when that view arrives. This case comes from reading the code. I did not run it in a browser.

2. **Host image rollback with the database kept.** A stored 98.6 KiB package fails in `verifiedExperienceBundle` (`apps/api/src/lib/app-experience-service.ts:88`). The `ZodError` is not wrapped, so the user sees `Invalid App action request` (`apps/api/src/routes/app-http-errors.ts:55-60`). This should be rare: the documented downgrade restores the pre-upgrade database as well (`docs/self-hosting.md:774-779`), which removes the package.

3. **A browser tab left open across a Host upgrade.** Old web code still enforces 96 KiB (`apps/web/src/lib/app-experience-session.ts:176`, `apps/web/src/lib/app-experience-bootstrap-script.ts:25`) until the tab reloads.

### No Host floor exists

This confirms the earlier review. Three things look similar, and none of them is a Host floor:

- `DEFT_APP_DEVELOPER_COMPATIBILITY.app_kit.versions` (`core.ts:137`) is a list of Kit versions the Host advertises. The check in `resolveDeftAppDeveloperProtocolFlow` (`core.ts:165`) only accepts protocols 0 to 4, so Protocol 7 Apps such as Email never pass through it.
- Email's `compatibility.json` is read by people. Nothing in `apps/` or `packages/` reads it.
- `host_release` in Kit release metadata (`scripts/prepare-author-kit-release.mjs:14`) records the Host a Kit was cut from. It is not checked at install.

### How the Host knows its version

`DEFT_RELEASE_VERSION` comes from the environment, with a source constant as the fallback (`apps/api/src/lib/agent-channel.ts:50`). `GET /health` already exposes it publicly (`apps/api/src/index.ts:355-357`). Release images set it correctly (`.github/workflows/release.yml:270`), but two other builds do not:

- The `Dockerfile` defaults it to `0.3.0-preview.16` (`Dockerfile:38`, `:48`, `:68`, `:84`) and `docker-compose.yml` does not pass it. A source-built compose Host therefore reports preview.16 whatever code it runs.
- `scripts/stage-email-demo-candidate.mjs:114` hardcodes `0.3.0-preview.16+email-stage1.<suffix>`.

The documented demo deploy also builds with compose and sets no version (`deploy/demo/README.md:32`). The live demo reports `0.3.0-preview.140` correctly on `/health`, so its actual deployment must set the value some other way. Rollout step 1 should confirm how.

`compareAppSemver` (`app-service.ts:129`) orders preview numbers correctly: 140 is above 99, `0.3.0` is above any preview, and build metadata is ignored. It does not validate input, though. Tested directly, `compareAppSemver('dev', '0.3.0-preview.141')` returns `1`, meaning a garbled Host version would count as newer and the check would silently pass.

## What a new field can and cannot do

**It cannot give deployed Hosts a useful message.** Hosts at preview.140 and earlier have no code to read the field.

**It does keep them safe, bluntly.** They reject the unknown key at install, whatever its value says. Two consequences follow:

- Adding the field to a package makes that package uninstallable on every Host older than the release that first understands it (call that release **N**). A declared floor below N has no meaning.
- Email can only adopt the field in a release that is willing to require Host N or later.

**It only helps future Hosts, and only if it is read first.** Suppose Host N receives a package from a much newer Kit. Strict parsing rejects the unknown content with Zod output and a floor check placed after it never runs, so the floor has to be read from the raw JSON beforehand. The Host already reads raw package JSON this way to detect `schema_version` (`apps/api/src/routes/apps.ts:206`).

## Options

**A. Manifest `compatibility.min_host_version`** (recommended). One semver string, checked against the Host's release version.

**B. Capability flag.** The App lists named Host abilities, such as `worker_source.112k.v1`, and the Host publishes the set it supports.

**C. Bundle schema version bump.** `deft.experience_bundle.v5` carries the 112 KiB cap, and v1 to v4 stay at 96 KiB.

| | A. `min_host_version` | B. Capability flag | C. Bundle `v5` |
| --- | --- | --- | --- |
| **Deployed Hosts** | Refused at install, unhelpful message | Same | Same |
| **Future Hosts** | Clear refusal | Clear refusal, if read before strict parsing | Zod union error unless the Host adds mapping |
| **Covers Worker-only features** | Yes, the author declares it | Yes, if a name was registered | No |
| **Covers Apps without an Experience** | Yes | Only as a new manifest field | No |
| **Trust and data flow** | Author-set, can only refuse. Compared with a local constant. No network or database read at install | Same, plus a capability registry kept in step across Kit and Host | Unchanged. The bundle is digest-bound and already verified |
| **Error the user sees** | "Needs Deft X or later. This workspace runs Y." Names the fix | "Doesn't support `worker_source.112k.v1`." Needs a display map and doesn't say which version fixes it | Generic unsupported-package error |
| **Migration** | No database change. Stored in the existing `manifest` JSON. Absent means no floor | No database change. New registry, plus a name for each future requirement | No database change. Changes #424 and delays it |
| **Rollback** | Host below N can't read a manifest carrying the key | Same | Same for the bundle |
| **Main failure mode** | Author sets the floor too low, or the Host misreports its version | Nobody registers a name, which is exactly what happened in #424 | Solves one cap only. The next requirement needs another bump |
| **Caller interface** | One reader and one assert function | Reader, assert, registry and a published set | Edits schema unions, `canonicalBundleJson`, and version lists in API and web |
| **Tests** | Pure table test plus route tests | Same, plus registry sync tests | Schema and allow-list tests |

**Why A over B.** Deft ships as one linear release train, so a version number carries the same information as a capability set, without a registry to maintain. B is more accurate if Host lineages diverge, for example a fork that cherry-picks features. That is not today's situation, and the raw-read design does not prevent adding B later.

**Why not C.** It would have been a reasonable way to ship the cap change, but it is not a general mechanism. It says nothing about manifest features, Worker features or Apps without Experiences.

**Also rejected:**

- **Release notes alone.** They remain the only option for deployed Hosts, but they do nothing for the failure at open or for future error messages.
- **Protocol 8.** Deployed Hosts refuse it too, and 62 lines in the API compare `protocol_version` and would need revisiting. That is far more than this problem needs.

## Recommended design

### Declaration

```json
{ "compatibility": { "app_protocol": "7", "min_host_version": "0.3.0-preview.145" } }
```

- Optional, on manifest schemas V4 to V7 (`core.ts:928`, `:960`, `:997`, `:1033`). These are the protocols that can carry Experiences. Others can be added later with one line each.
- It sits under `compatibility` because that key is already registered in `manifest_keys`, so the protocol registry check at `core.ts:1649-1654` needs no change.
- The value is strict semver without build metadata.
- The Kit rejects values below N at build time, because they cannot mean anything.
- The JSON path `manifest.compatibility.min_host_version` is frozen permanently, including for future protocols. A Host has to find it in packages it otherwise cannot parse.
- The author chooses the value. The Kit cannot infer it, since Worker behaviour is not visible in the package.

### Interface

```ts
// @deft/app-kit/core
// Never throws. Returns null if the field is absent or malformed.
export function readDeftAppMinHostVersion(manifest: unknown): string | null;

// apps/api/src/lib/app-host-version.ts
// Throws AppError APP_HOST_VERSION_UNSUPPORTED (409) when the Host is too old.
export function assertAppHostVersionSupported(
  manifest: unknown,
  hostVersion: string = DEFT_RELEASE_VERSION,
): void;
```

The Kit reads the field. The Host owns the comparison, because the Kit is a build-time contract and never decides Host policy. Neither function takes an App id, so there is nothing to branch on. A malformed floor reads as `null`, and strict validation then rejects the package as it does any invalid field.

### Enforcement at install

Call the assert function first in `inspectAppPackageJson`, before `verifyDeftAppPackageJson` (`app-service.ts:177`), on the raw parsed `manifest`. Apply the existing package size limit (`core.ts:2071`) before this extra parse. Invalid JSON skips the check, and the existing parser reports it.

This one call covers every admission route, and also the re-inspection of stored packages at `apps/api/src/lib/app-runtime-upgrade.ts:112` and `:118`. First-install activation does not re-inspect, so a Host downgraded between stage and activate is caught at open.

### Enforcement at open

Call the assert function in two places, both on the raw `version.manifest`:

1. **At the top of `verifiedExperienceBundle`** (`app-experience-service.ts:77`), before `parse*Manifest` runs. Opening an App starts with the `targets` request (`apps/web/src/components/apps/installed-app-experience.tsx:322`), which reaches this function with no earlier manifest parse (`app-experience-service.ts:238`). Later in-session reads such as data actions go through it too (`apps/api/src/lib/app-data-action-service.ts:49`).
2. **In `create`, straight after the version row is loaded and before the Protocol 7 branch** (`app-experience-service.ts:154`). That branch calls `loadReviewedAttachmentApp`, which parses the manifest strictly (`apps/api/src/lib/app-attachment-authority.ts:118`) before `verifiedExperienceBundle` runs at `:159`. Without this second call, a Protocol 7 App such as Email would get a Zod error instead of the floor message when `create` is reached directly.

Some in-session paths parse the manifest before calling `verifiedExperienceBundle`, such as `apps/api/src/lib/app-private-state-adoption-service.ts:71`. A stored manifest the Host cannot parse still fails there with the old error, but only after a rollback and only after the App has failed to open.

The refusal changes no state. The App stays installed and its data is untouched, so it works again once the Host is upgraded.

Other surfaces (runtime actions, sync, automations) are not gated in this design. The API has about 30 manifest parse calls across 21 files. They only fall below the floor after a rollback, which should be rare, so the extra change is not justified yet.

### Errors

Add code `APP_HOST_VERSION_UNSUPPORTED` with status 409, matching `APP_PROTOCOL_UNSUPPORTED` (`app-service.ts:169`), and `details: { required_host_version, host_version }`.

| Where | Who sees it | Text |
| --- | --- | --- |
| Install or upgrade | Admin, in Settings > Apps | This app needs Deft 0.3.0-preview.145 or later. This workspace runs 0.3.0-preview.141. Upgrade Deft, then try again. |
| Open | Any member | This app needs Deft 0.3.0-preview.145 or later. Ask your Deft admin to upgrade. |

The code must be added to `publicCodes` in `apps/web/src/lib/app-request-error.ts:6`, or the open case falls back to "The app could not open." The install path needs no web change because `appApiError` shows `error` directly.

### Trust and data flow

- **Self-restriction only.** The field can cause a refusal and nothing else. It grants nothing and is not authority, so the requested-authority projection does not need it (`core.ts:1431-1434`).
- **Reading before verification is safe for the same reason.** The raw value is unverified at that point, but the worst result is a refusal of that package. Everything else still goes through full verification, and `manifest_digest` covers the field.
- **Displayed text is bounded.** Only a value matching the semver pattern reaches the message.
- **No new disclosure.** The Host version in `details` is already public through `/health`.
- **It is not a security control.** Packages are unsigned and an operator can override `DEFT_RELEASE_VERSION`. The floor exists to prevent confusing failures.
- **Unusable Host version fails closed, only for Apps that declare a floor.** The assert function validates `hostVersion` before comparing, because `compareAppSemver` would otherwise pass it. Apps with no floor are unaffected.

### Tests

- **Kit:**
  - Valid and invalid values, and values below N.
  - Packages without the field stay byte-identical, following `packages/app-kit/test/attachment-contracts.test.ts:45`.
  - The reader never throws on arbitrary input.
- **Host, pure table:** preview ordering, final over preview, build metadata, absent field, garbled Host version.
- **Frozen future package:** a fixture with an unknown key, an unknown protocol and a high floor must produce `APP_HOST_VERSION_UNSUPPORTED` rather than Zod output. This is the test that protects the ordering.
- **Routes:** each admission route refuses and creates no `app_installations` or `app_versions` row. An upgrade refusal leaves the active version active.
- **Open:** a stored floor above the Host returns 409 from both `targets` and `create`, creates no session, and shows the message through `publicCodes`. Include a Protocol 7 case whose stored manifest has a key this Host does not know.
- **Web:** confirm the manifest normaliser in `apps/web/src/lib/apps.ts` tolerates the new field in `/inspect` responses.

## Rollout

1. **Fix version reporting.** Stop the `Dockerfile` default overriding the source constant. An empty value already falls back to it (`agent-channel.ts:50`). Review the demo candidate script.
2. **Host release N.** Ship the Kit schema, the reader and both checks together.
3. **Kit release.** Publish the first Kit that accepts the field, with N as its lowest allowed value, and add it to the advertised version list.
4. **Email.** Set the floor in the first Email release that is ready to require Host N or later.

No database migration or backfill is needed. Existing Apps have no floor and behave as they do now.

**For #424 now:** release as planned. #424 does not bump the Host or Kit version itself: `package.json` and the Kit constant still read preview.140 and alpha.42. Email's notes should use the actual Host release number once it exists. Suggested text:

> Needs Deft Host <release carrying #424> or later. On older Hosts, Settings > Apps refuses this package with an error mentioning `Worker source exceeds 96 KiB`. An Email that is already installed keeps working. Upgrade Deft, then install this release.

## Rollback

- **Host N+1 back to N:** safe. Both understand the field.
- **Host below N with a floor-carrying App active:** the old strict schema cannot read the stored manifest (the last row of the table above), so the App stops working across every surface that parses it. Every new manifest key carries this same risk. The documented downgrade restores the older database, which avoids it. An image-only rollback does not.
- **Removing the field later:** not safe. Once shipped, Hosts must keep accepting it.
- **App author undoing a floor:** publish a newer version without it, or with a lower one. Connected upgrades require a strictly newer App version (`docs/app-boundaries.md`).

## Failure modes

| Failure | Effect | Handling |
| --- | --- | --- |
| Host under-reports its version (Docker default, demo script) | Valid Apps are refused | Rollout step 1, which must land first |
| Unreleased `master` still reports the last tag | A floor set to the next release is refused | Intended. Developers set `DEFT_RELEASE_VERSION` |
| Garbled Host version | Would silently pass | Validate first, then fail closed |
| Author sets the floor too low | Fails at run time, as it does today | No worse than now |
| Author sets the floor too high | Needless refusal | Publish a corrected version |
| Fork with its own version scheme | Comparison may be meaningless | Accepted limit. Option B is the path if this becomes real |
| Future protocol moves the field | Floor not found, so Zod output returns | Frozen path and frozen fixture test |
| Upgrade on a Host below the floor of the active App | Refused by the re-inspection at `app-runtime-upgrade.ts:118`, even if the new version has a lower floor | Accepted. It needs a rollback first. Upgrade the Host |
| Stale browser tab | Not covered, since the floor is checked on the server | Unchanged. Clears on reload |

## Open questions and follow-ups

- **Timing of N.** If this landed in the same Host release as #424, N would equal Email's real floor and Email could adopt the field without raising it. The recommendation is not to delay #424 for this, but that is the owner's call.
- **Gate `connection_action` with a renderer capability?** Renderer features such as `menu.v1` are already gated this way (`app-experience-bridge.ts:173`), and an unknown capability is refused at install. Gating #424's button the same way would turn the failure at open into a refusal at install for any App on an old Host. This is separate from the floor and worth its own review.
- **Readable errors on older-than-N packages.** `APP_INVALID_PACKAGE` could stop showing raw Zod JSON. This is a small, independent fix.
- **Docs.** When this ships, add the field to the Kit README and `docs/connected-app-author-guide.md`.

## How this was checked

- **Tested:** the rejection table, the 100,966-byte package result and the `compareAppSemver` cases, using Kit source from both commits with Zod 4.6.7 in a throwaway harness outside the repository.
- **Limits of the test:** the package was synthetic, not the real Email build, and no live Host or database was involved.
- **Read, not run:** the Host route behaviour, the web error display, the `connection_action` session failure, the open-path ordering and the rollback error text.
- **Live check:** one `GET /health` on demo.deft.ing, which reported `0.3.0-preview.140`.
