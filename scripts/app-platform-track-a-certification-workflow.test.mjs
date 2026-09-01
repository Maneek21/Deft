import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const workflow = read('../.github/workflows/app-platform-track-a-certification.yml');
const orchestrator = read('./ci/certify-app-platform-phase5.sh');
const setupHook = read('./ci/app-platform-track-a-certification-setup.sh');
const phase6SetupHook = read('./ci/app-platform-phase6-certification-setup.sh');
const setupProbe = read('../apps/api/src/scripts/app-platform-track-a-certification-setup.ts');
const offlineHook = read('./ci/app-platform-phase6-certification-offline.sh');
const browserSmoke = read('./ci/app-platform-phase6-browser-smoke.mjs');
const pnpmExecWrapper = read('./ci/pnpm-exec-wrapper.mjs');
const executionSurface = [
  workflow,
  orchestrator,
  setupHook,
  phase6SetupHook,
  setupProbe,
  offlineHook,
  browserSmoke,
  pnpmExecWrapper,
].join('\n');

const CANDIDATE_COMMIT = 'ff5a3fae3e21b80fe51849e6cd8023d5228389d0';
const PHASE6_BASELINE_COMMIT = '16875df2f6c9dc2bc3d850de6758b7dd56767a05';
const PREDECESSOR_IMAGE =
  'ghcr.io/maneek21/deft@sha256:e565cc64ee22b5b9f6f99973e3762b639c27e026dc8824852145035acdacf788';
const PREDECESSOR_COMMIT = '6d39e0e0413c82d36c9481849ae582fdf805d1a6';

function occurrences(source, value) {
  return source.split(value).length - 1;
}

function uploadSteps(source) {
  return source.match(
    /^ {6}- name: Upload[^\r\n]*(?:\r?\n(?! {6}- name:)[^\r\n]*)*/gm,
  ) ?? [];
}

test('Track A certification is a manual, read-only, non-concurrent gate', () => {
  assert.match(workflow, /^on:\s*\r?\n\s+workflow_dispatch:/m);
  assert.doesNotMatch(
    workflow,
    /^\s{2}(?:push|pull_request|pull_request_target|schedule|release):/m,
  );
  assert.match(workflow, /permissions:\s*\r?\n\s+contents:\s*read\b/);
  assert.match(workflow, /group:\s*app-platform-track-a-certification/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.match(workflow, /timeout-minutes:\s*120/);
  for (const forbidden of [
    /contents:\s*write/,
    /packages:\s*write/,
    /id-token:\s*write/,
    /attestations:\s*write/,
    /actions:\s*write/,
  ]) assert.doesNotMatch(workflow, forbidden);
});

test('candidate, Phase 6 baseline, and supported predecessor are immutable and verified', () => {
  assert.equal(occurrences(workflow, CANDIDATE_COMMIT), 1);
  assert.equal(occurrences(workflow, PHASE6_BASELINE_COMMIT), 1);
  assert.equal(occurrences(workflow, PREDECESSOR_IMAGE), 1);
  assert.equal(occurrences(workflow, PREDECESSOR_COMMIT), 1);
  assert.doesNotMatch(workflow, /__PRODUCT_CANDIDATE_SHA__/);
  assert.match(workflow, /path:\s*\.cert\/track-a-candidate/);
  assert.match(workflow, /path:\s*\.cert\/phase6-baseline/);
  assert.match(
    workflow,
    /candidate_sha="\$\(git -C \.cert\/track-a-candidate rev-parse HEAD\)"/,
  );
  assert.match(
    workflow,
    /baseline_sha="\$\(git -C \.cert\/phase6-baseline rev-parse HEAD\)"/,
  );
  assert.match(workflow, /\[\[ "\$candidate_sha" == "\$APP_PLATFORM_CANDIDATE_SHA" \]\]/);
  assert.match(workflow, /\[\[ "\$baseline_sha" == "\$APP_PLATFORM_BASELINE_SHA" \]\]/);
  assert.match(orchestrator, /predecessor_revision=.*docker image inspect/);
  assert.match(orchestrator, /\[\[ "\$predecessor_revision" == "\$predecessor_commit" \]\]/);
});

test('the disposable database activates inherited Phase 5 and Track A proofs', () => {
  assert.match(
    workflow,
    /APP_PLATFORM_DATABASE_NAME:\s*deft_phase5_phase6_track_a_release_test/,
  );
});

test('candidate receives one dependency install, typecheck, production build, and packed proof', () => {
  assert.equal(occurrences(workflow, 'pnpm install --frozen-lockfile'), 3);
  assert.equal(occurrences(workflow, 'run: pnpm typecheck'), 1);
  assert.equal(occurrences(workflow, 'run: pnpm build'), 1);
  assert.ok(
    workflow.indexOf('run: pnpm typecheck') < workflow.indexOf('run: pnpm build'),
    'candidate typecheck must precede its production build',
  );
  assert.match(workflow, /working-directory:\s*\.cert\/track-a-candidate/);
  assert.match(workflow, /working-directory:\s*\.cert\/phase6-baseline/);
  assert.match(workflow, /playwright install --with-deps chromium/);
  assert.equal(occurrences(workflow, 'test/packed-external.test.ts'), 1);
  assert.match(workflow, /PNPM_CONFIG_IGNORE_SCRIPTS:\s*'true'/);
  assert.match(
    pnpmExecWrapper,
    /spawnSync\(command, args, \{ stdio: 'inherit' \}\)/,
  );
});

test('one shared orchestration pass owns image, upgrade, restore, predecessor, browser, offline, and cleanup', () => {
  assert.equal(occurrences(workflow, 'bash scripts/ci/certify-app-platform-phase5.sh'), 1);
  assert.equal(occurrences(orchestrator, 'docker buildx build --load'), 1);
  assert.equal(occurrences(orchestrator, "'pnpm db:upgrade && pnpm module:verify'"), 1);
  assert.equal(occurrences(orchestrator, 'pg_dump -U postgres'), 1);
  assert.equal(occurrences(orchestrator, 'pg_restore -U postgres'), 1);
  assert.equal(occurrences(orchestrator, 'docker pull "$predecessor_image"'), 1);
  assert.equal(occurrences(orchestrator, 'node "$browser_script"'), 1);
  assert.equal(occurrences(orchestrator, 'run_extension_hook "$offline_hook" offline'), 1);
  assert.equal(occurrences(orchestrator, 'docker save "$candidate_tag"'), 1);
  assert.equal(occurrences(workflow, '- name: Remove and confirm isolated resources'), 1);
  assert.match(workflow, /APP_PLATFORM_SETUP_HOOK:[^\n]*app-platform-track-a-certification-setup\.sh/);
  assert.match(workflow, /APP_PLATFORM_OFFLINE_HOOK:[^\n]*app-platform-phase6-certification-offline\.sh/);
  assert.match(workflow, /APP_PLATFORM_BROWSER_SCRIPT:[^\n]*app-platform-phase6-browser-smoke\.mjs/);
});

test('automation is explicitly enabled in every candidate boot and the setup hook verifies it', () => {
  assert.match(workflow, /DEFT_APP_AUTOMATIONS_ENABLED:\s*'true'/);
  assert.equal(
    occurrences(workflow, '[[ "$DEFT_APP_AUTOMATIONS_ENABLED" == "true" ]]'),
    2,
  );
  assert.match(
    orchestrator,
    /app_automations_enabled="\$\{DEFT_APP_AUTOMATIONS_ENABLED:-false\}"/,
  );
  assert.match(
    orchestrator,
    /-e DEFT_APP_AUTOMATIONS_ENABLED="\$app_automations_enabled"/,
  );
  assert.equal(
    occurrences(
      orchestrator,
      '-e DEFT_APP_AUTOMATIONS_ENABLED="$app_automations_enabled"',
    ),
    4,
  );
  assert.match(
    orchestrator,
    /DEFT_APP_AUTOMATIONS_ENABLED="\$app_automations_enabled"[\s\S]*?bash "\$hook"/,
  );
  assert.match(
    offlineHook,
    /-e DEFT_APP_AUTOMATIONS_ENABLED="\$app_automations_enabled"/,
  );
  assert.match(
    phase6SetupHook,
    /-e DEFT_APP_AUTOMATIONS_ENABLED="\$\{DEFT_APP_AUTOMATIONS_ENABLED:-false\}"/,
  );
  assert.match(setupHook, /DEFT_APP_AUTOMATIONS_ENABLED/);
  assert.match(setupHook, /DEFT_APP_AUTOMATIONS_ENABLED[^\n]*true|true[^\n]*DEFT_APP_AUTOMATIONS_ENABLED/);
});

test('candidate boots enable the rollout prerequisites before automation', () => {
  assert.match(
    orchestrator,
    /run_candidate\(\) \{[\s\S]*?-e DEFT_APPS_ENABLED=true \\\r?\n\s+-e DEFT_APP_RUNS_ENABLED=true \\\r?\n\s+-e DEFT_APP_RUN_APP_ORIGIN_ENABLED=true \\\r?\n\s+-e DEFT_APP_AUTOMATIONS_ENABLED="\$app_automations_enabled" \\\r?\n\s+-e DEFT_APP_RUN_KEYRINGS="\$\{keyring_json:-\}"/,
  );
  assert.match(
    orchestrator,
    /-v "\$\{candidate_root\}\/examples:\/app\/examples:ro"[\s\S]*?-e DEFT_APPS_ENABLED=true \\\r?\n\s+-e DEFT_APP_RUNS_ENABLED=true \\\r?\n\s+-e DEFT_APP_RUN_APP_ORIGIN_ENABLED=true \\\r?\n\s+-e DEFT_APP_AUTOMATIONS_ENABLED="\$app_automations_enabled" \\\r?\n\s+-e DEFT_APP_RUN_KEYRINGS="\$keyring_json"/,
  );
});

test('a disposable keyring exists before the first rollout-enabled candidate boot', () => {
  assert.match(
    orchestrator,
    /candidate-image-revision\.txt"[\s\S]*?certification-probe\.ts keyring --output \/recovery\/app-run-keyrings\.json[\s\S]*?keyring_json="\$\(tr -d '\\n' < "\$keyring_path"\)"[\s\S]*?run_candidate "\$source_url_container" 'pnpm db:upgrade/,
  );
});

test('the exact browser fixture is mandatory, so the Phase 6 legacy path cannot pass', () => {
  assert.match(
    workflow,
    /DEFT_APP_PLATFORM_AUTOMATION_BROWSER_FIXTURE=\$RUNNER_TEMP\/deft-track-a-evidence\/safe\/track-a-browser-fixture\.json/,
  );
  assert.match(
    workflow,
    /\[\[ -n "\$DEFT_APP_PLATFORM_AUTOMATION_BROWSER_FIXTURE" \]\]/,
  );
  assert.match(setupHook, /track-a-browser-fixture\.json/);
  assert.match(browserSmoke, /const automationFixtureInput = process\.env\.DEFT_APP_PLATFORM_AUTOMATION_BROWSER_FIXTURE/);
  assert.match(
    browserSmoke,
    /catch \{\s*if \(!automationFixtureInput\) return null;\s*throw new CertificationFailure\('AUTOMATION_FIXTURE_UNREADABLE'\);\s*\}/,
  );
  assert.match(browserSmoke, /APP_PLATFORM_TRACK_A_BROWSER_SMOKE_PASSED/);
  assert.match(browserSmoke, /APP_PLATFORM_PHASE6_BROWSER_SMOKE_PASSED/);
});

test('the exact candidate database matrix includes grants and the automation lifecycle', () => {
  const setupSurface = `${setupHook}\n${phase6SetupHook}`;
  assert.match(setupHook, /bash "\$phase6_setup"/);
  assert.equal(occurrences(setupSurface, 'apps-connected-grants-db.test.ts'), 1);
  assert.match(
    phase6SetupHook,
    /-e DEFT_APP_AUTOMATIONS_ENABLED="\$\{DEFT_APP_AUTOMATIONS_ENABLED:-false\}" \\\r?\n[\s\S]*?apps-connected-grants-db\.test\.ts/,
  );
  assert.match(setupProbe, /appAutomationDefinitions/);
  assert.match(
    orchestrator,
    /-e DEFT_APP_AUTOMATIONS_ENABLED="\$app_automations_enabled" \\\r?\n\s+-e DEFT_APP_RUN_KEYRINGS="\$keyring_json" \\\r?\n\s+--entrypoint sh "\$candidate_tag" \\\r?\n\s+-c '[^']*test\/app-origin-run-lifecycle-db\.test\.ts'/,
  );
  assert.match(orchestrator, /run_extension_hook "\$setup_hook" setup/);
});

test('only bounded safe evidence and the exact candidate image are retained', () => {
  const uploads = uploadSteps(workflow);
  assert.equal(uploads.length, 2);
  assert.match(uploads[0], /if:\s*always\(\)/);
  assert.match(uploads[0], /path:\s*\$\{\{ env\.EVIDENCE_DIR \}\}\/safe\s*$/m);
  assert.match(uploads[1], /if:\s*success\(\)/);
  assert.match(
    uploads[1],
    /path:\s*\$\{\{ env\.EVIDENCE_DIR \}\}\/candidate-image\.tar\.zst\s*$/m,
  );
  for (const upload of uploads) {
    assert.match(upload, /retention-days:\s*90/);
    assert.doesNotMatch(upload, /(?:recovery|keyring|database\.dump|\.env|\.cert|\*\*)/i);
  }
});

test('cleanup is exact and the complete gate cannot publish', () => {
  assert.match(workflow, /\$APP_PLATFORM_RESOURCE_PREFIX-source/);
  assert.match(workflow, /\$APP_PLATFORM_RESOURCE_PREFIX-restore/);
  assert.match(workflow, /\$APP_PLATFORM_RESOURCE_PREFIX-app/);
  assert.match(workflow, /\$APP_PLATFORM_RESOURCE_PREFIX-network/);
  assert.match(workflow, /\$APP_PLATFORM_RESOURCE_PREFIX-source-data/);
  assert.match(workflow, /\$APP_PLATFORM_RESOURCE_PREFIX-restore-data/);
  assert.match(workflow, /label=com\.docker\.compose\.project=\$APP_PLATFORM_COMPOSE_PROJECT/);
  assert.match(workflow, /docker image rm "\$APP_PLATFORM_CANDIDATE_TAG"/);
  for (const forbidden of [
    /docker\s+system\s+prune/,
    /docker\s+(?:container|image|network|volume)\s+prune/,
    /docker\s+push\b/,
    /push:\s*true\b/,
    /git\s+push\b/,
    /gh\s+(?:pr|release)\s+(?:create|merge|upload)\b/,
    /(?:oras|cosign)\s+(?:push|sign)\b/,
  ]) assert.doesNotMatch(executionSurface, forbidden);
});
