import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/app-platform-phase6-certification.yml', import.meta.url),
  'utf8',
);
const orchestrator = readFileSync(
  new URL('./ci/certify-app-platform-phase5.sh', import.meta.url),
  'utf8',
);
const setupHook = readFileSync(
  new URL('./ci/app-platform-phase6-certification-setup.sh', import.meta.url),
  'utf8',
);
const offlineHook = readFileSync(
  new URL('./ci/app-platform-phase6-certification-offline.sh', import.meta.url),
  'utf8',
);
const executionSurface = `${workflow}\n${orchestrator}\n${setupHook}\n${offlineHook}`;

const CANDIDATE_COMMIT = '16875df2f6c9dc2bc3d850de6758b7dd56767a05';
const CANDIDATE_PLACEHOLDER = '__PRODUCT_CANDIDATE_SHA__';
const PHASE4_BASELINE_COMMIT = 'ec79592e669bdf915fad8a5d2480f0625d819a4c';
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

test('Phase 6 certification is manual, read-only, bounded, and non-concurrent', () => {
  assert.match(workflow, /^on:\s*\r?\n\s+workflow_dispatch:/m);
  assert.doesNotMatch(
    workflow,
    /^\s{2}(?:push|pull_request|pull_request_target|schedule|release):/m,
  );
  assert.match(workflow, /permissions:\s*\r?\n\s+contents:\s*read\b/);
  assert.match(workflow, /concurrency:\s*\r?\n\s+group:\s*app-platform-phase6-certification/);
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

test('candidate, baseline, and predecessor identities are immutable and verified', () => {
  assert.equal(occurrences(workflow, CANDIDATE_COMMIT), 1);
  assert.equal(occurrences(workflow, CANDIDATE_PLACEHOLDER), 0);
  assert.equal(occurrences(workflow, PHASE4_BASELINE_COMMIT), 1);
  assert.equal(occurrences(workflow, PREDECESSOR_IMAGE), 1);
  assert.equal(occurrences(workflow, PREDECESSOR_COMMIT), 1);
  assert.match(workflow, /path:\s*\.cert\/phase6-candidate/);
  assert.match(workflow, /path:\s*\.cert\/phase4-baseline/);
  assert.match(workflow, /ref:\s*\$\{\{\s*env\.APP_PLATFORM_CANDIDATE_SHA\s*\}\}/);
  assert.match(workflow, /ref:\s*\$\{\{\s*env\.APP_PLATFORM_BASELINE_SHA\s*\}\}/);
  assert.match(
    workflow,
    /candidate_sha="\$\(git -C \.cert\/phase6-candidate rev-parse HEAD\)"/,
  );
  assert.match(workflow, /\[\[ "\$candidate_sha" == "\$APP_PLATFORM_CANDIDATE_SHA" \]\]/);
  assert.match(
    workflow,
    /baseline_sha="\$\(git -C \.cert\/phase4-baseline rev-parse HEAD\)"/,
  );
  assert.match(workflow, /\[\[ "\$baseline_sha" == "\$APP_PLATFORM_BASELINE_SHA" \]\]/);
});

test('three dependency roots are installed before one candidate typecheck and production build', () => {
  assert.equal(occurrences(workflow, 'pnpm install --frozen-lockfile'), 3);
  assert.match(workflow, /Install certifier dependencies/);
  assert.match(
    workflow,
    /Install exact Phase 6 candidate dependencies[\s\S]*?working-directory: \.cert\/phase6-candidate/,
  );
  assert.match(
    workflow,
    /Install exact Phase 4 baseline dependencies[\s\S]*?working-directory: \.cert\/phase4-baseline/,
  );
  assert.match(workflow, /docker\/setup-buildx-action@v4/);
  assert.match(workflow, /playwright install --with-deps chromium/);
  assert.equal(occurrences(workflow, 'run: pnpm typecheck'), 1);
  assert.equal(occurrences(workflow, 'run: pnpm build'), 1);
  assert.ok(
    workflow.indexOf('run: pnpm typecheck') < workflow.indexOf('run: pnpm build'),
    'candidate typecheck must precede its single production build',
  );
});

test('shared gate receives the Phase 6 roots, hooks, and exact isolated resources', () => {
  assert.match(workflow, /APP_PLATFORM_CERT_PHASE:\s*phase6/);
  assert.match(workflow, /APP_PLATFORM_CANDIDATE_ROOT=\$GITHUB_WORKSPACE\/\.cert\/phase6-candidate/);
  assert.match(workflow, /APP_PLATFORM_BASELINE_ROOT=\$GITHUB_WORKSPACE\/\.cert\/phase4-baseline/);
  assert.match(workflow, /APP_PLATFORM_RESOURCE_PREFIX:\s*deft-p6-cert-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /APP_PLATFORM_DATABASE_NAME:\s*deft_phase5_phase6_release_test/);
  assert.match(
    workflow,
    /APP_PLATFORM_SETUP_HOOK:[^\n]*app-platform-phase6-certification-setup\.sh/,
  );
  assert.match(
    workflow,
    /APP_PLATFORM_OFFLINE_HOOK:[^\n]*app-platform-phase6-certification-offline\.sh/,
  );
  assert.match(
    workflow,
    /APP_PLATFORM_BROWSER_SCRIPT:[^\n]*app-platform-phase6-browser-smoke\.mjs/,
  );
  assert.match(workflow, /run:\s*bash scripts\/ci\/certify-app-platform-phase5\.sh/);
  assert.match(orchestrator, /git -C "\$candidate_root" rev-parse HEAD/);
  assert.match(orchestrator, /run_extension_hook "\$setup_hook" setup/);
  assert.match(orchestrator, /node "\$browser_script"/);
  assert.match(orchestrator, /run_extension_hook "\$offline_hook" offline/);
  assert.match(setupHook, /SELECT count\(\*\) FROM mcp_connections WHERE slug LIKE 'loop5-mail-%'/);
  assert.match(setupHook, /is_active = true/);
  assert.match(
    setupHook,
    /app_run_authorization_version = app_run_authorization_version \+ 1/,
  );
  assert.match(
    setupHook,
    /pnpm --filter @deft\/app-kit exec tsx --test test\/\*\.test\.ts/,
  );
  assert.doesNotMatch(setupHook, /pnpm --filter @deft\/app-kit test/);
  assert.match(offlineHook, /\[\[ "\$after_total" == "\$before_total" \]\]/);
  assert.match(offlineHook, /invocation_failed_without_creating_a_run/);
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

test('cleanup targets only the exact Phase 6 prefix and Compose project', () => {
  assert.match(workflow, /if:\s*always\(\)[\s\S]*?Remove and confirm isolated resources/);
  assert.match(workflow, /\$APP_PLATFORM_RESOURCE_PREFIX-source/);
  assert.match(workflow, /\$APP_PLATFORM_RESOURCE_PREFIX-restore/);
  assert.match(workflow, /\$APP_PLATFORM_RESOURCE_PREFIX-app/);
  assert.match(workflow, /\$APP_PLATFORM_RESOURCE_PREFIX-network/);
  assert.match(workflow, /\$APP_PLATFORM_RESOURCE_PREFIX-source-data/);
  assert.match(workflow, /\$APP_PLATFORM_RESOURCE_PREFIX-restore-data/);
  assert.match(
    workflow,
    /label=com\.docker\.compose\.project=\$APP_PLATFORM_COMPOSE_PROJECT/,
  );
  assert.match(workflow, /docker image rm "\$APP_PLATFORM_CANDIDATE_TAG"/);
  assert.match(workflow, /docker image inspect "\$APP_PLATFORM_CANDIDATE_TAG"/);
  for (const forbidden of [
    /docker\s+system\s+prune/,
    /docker\s+(?:container|image|network|volume)\s+prune/,
    /docker\s+rm\s+-f\s+\$\(/,
    /docker\s+volume\s+rm\s+\$\(/,
    /docker\s+network\s+rm\s+\$\(/,
  ]) assert.doesNotMatch(workflow, forbidden);
});

test('the complete certification surface cannot publish repository or image state', () => {
  for (const forbidden of [
    /docker\s+push\b/,
    /push:\s*true\b/,
    /git\s+push\b/,
    /gh\s+(?:pr|release)\s+(?:create|merge|upload)\b/,
    /(?:oras|cosign)\s+(?:push|sign)\b/,
    /softprops\/action-gh-release/,
    /actions\/create-release/,
  ]) assert.doesNotMatch(executionSurface, forbidden);
});
