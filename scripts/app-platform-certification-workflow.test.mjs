import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/app-platform-phase5-certification.yml', import.meta.url),
  'utf8',
);
const orchestrator = readFileSync(
  new URL('./ci/certify-app-platform-phase5.sh', import.meta.url),
  'utf8',
);
const executionSurface = `${workflow}\n${orchestrator}`;

const CANDIDATE_COMMIT = '161ca65fcb79cdb76fee315b2ba9974ff145a47e';
const PHASE4_BASELINE_COMMIT = 'ec79592e669bdf915fad8a5d2480f0625d819a4c';
const PREDECESSOR_IMAGE = 'ghcr.io/maneek21/deft@sha256:e565cc64ee22b5b9f6f99973e3762b639c27e026dc8824852145035acdacf788';

function occurrences(source, value) {
  return source.split(value).length - 1;
}

test('Phase 5 certification is manual and read-only at the repository boundary', () => {
  assert.match(workflow, /^on:\s*\r?\n\s+workflow_dispatch:/m);
  assert.doesNotMatch(
    workflow,
    /^\s{2}(?:push|pull_request|pull_request_target|schedule|release):/m,
  );
  assert.match(workflow, /permissions:\s*\r?\n\s+contents:\s*read\b/);
  for (const forbidden of [
    /contents:\s*write/,
    /packages:\s*write/,
    /id-token:\s*write/,
    /attestations:\s*write/,
    /actions:\s*write/,
  ]) assert.doesNotMatch(workflow, forbidden);
});

test('candidate, Phase 4 baseline, and predecessor image are immutable identities', () => {
  assert.match(workflow, new RegExp(`PHASE5_CANDIDATE_SHA:\\s*${CANDIDATE_COMMIT}`));
  assert.match(workflow, new RegExp(`PHASE4_BASELINE_SHA:\\s*${PHASE4_BASELINE_COMMIT}`));
  assert.match(
    workflow,
    new RegExp(`PREDECESSOR_IMAGE:\\s*["']?${PREDECESSOR_IMAGE.replaceAll('.', '\\.')}`),
  );
  assert.equal(occurrences(workflow, CANDIDATE_COMMIT), 1);
  assert.equal(occurrences(workflow, PHASE4_BASELINE_COMMIT), 1);
  assert.equal(occurrences(workflow, PREDECESSOR_IMAGE), 1);
  assert.match(workflow, /ref:\s*\$\{\{\s*env\.PHASE5_CANDIDATE_SHA\s*\}\}/);
  assert.match(workflow, /ref:\s*\$\{\{\s*env\.PHASE4_BASELINE_SHA\s*\}\}/);
});

test('certification checks the exact candidate revision and builds without publishing', () => {
  assert.match(workflow, /candidate_sha="\$\(git -C \.cert\/phase5-candidate rev-parse HEAD\)"/);
  assert.match(workflow, /\[\[ "\$candidate_sha" == "\$PHASE5_CANDIDATE_SHA" \]\]/);
  assert.match(workflow, /baseline_sha="\$\(git -C \.cert\/phase4-baseline rev-parse HEAD\)"/);
  assert.match(workflow, /\[\[ "\$baseline_sha" == "\$PHASE4_BASELINE_SHA" \]\]/);
  assert.match(workflow, /bash scripts\/ci\/certify-app-platform-phase5\.sh/);
  assert.match(orchestrator, /git -C "\$phase5_root" rev-parse HEAD/);
  assert.match(orchestrator, /docker buildx build --load/);
  assert.match(orchestrator, /org\.opencontainers\.image\.revision/);
  assert.match(orchestrator, /\[\[ "\$image_revision" == "\$phase5_sha" \]\]/);
  for (const forbidden of [
    /docker\s+push\b/,
    /push:\s*true\b/,
    /gh\s+release\b/,
    /(?:oras|cosign)\s+(?:push|sign)\b/,
    /softprops\/action-gh-release/,
    /actions\/create-release/,
  ]) assert.doesNotMatch(executionSurface, forbidden);
});

test('certification uses real pgvector and proves matched backup, restore, and key continuity', () => {
  assert.match(orchestrator, /pgvector\/pgvector:pg16/);
  assert.match(orchestrator, /CREATE EXTENSION(?: IF NOT EXISTS)? vector/i);
  assert.match(orchestrator, /\bpg_dump\b/);
  assert.match(orchestrator, /\bpg_restore\b/);
  assert.match(orchestrator, /DEFT_APP_RUN_KEYRINGS/);
  assert.match(orchestrator, /keyring_hash="\$\(sha256sum "\$keyring_path"/);
  assert.match(
    orchestrator,
    /sha256sum "\$restored_keyring_path"[^\n]+== "\$keyring_hash"/,
  );
  assert.match(orchestrator, /source-snapshot\.json/);
  assert.match(orchestrator, /restored-verification\.json/);
});

test('certification carries the Phase 4 and Phase 5 probes plus browser evidence', () => {
  assert.match(orchestrator, /pnpm --filter @deft\/app-kit build/);
  assert.match(orchestrator, /resource-participation-apps-db\.test\.ts/);
  assert.match(orchestrator, /app-origin-run-lifecycle-db\.test\.ts/);
  assert.match(orchestrator, /app-platform-phase5-browser-smoke\.mjs/);
  assert.match(workflow, /DEFT_APP_PLATFORM_EVIDENCE_DIR/);
  assert.match(orchestrator, /DEFT_APP_PLATFORM_BROWSER_EVIDENCE=/);
  assert.match(orchestrator, /NEXT_PUBLIC_FEATURE_APPS=true/);
  assert.match(orchestrator, /DEFT_APPS_ENABLED=true/);
  assert.match(orchestrator, /DEFT_APP_RUNS_ENABLED=true/);
  assert.match(orchestrator, /DEFT_APP_RUN_APP_ORIGIN_ENABLED=true/);
});

test('evidence uploads even on failure and disposable resources are always removed', () => {
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /if:\s*always\(\)/);
  assert.match(workflow, /app-platform-phase5-certification/);
  assert.match(orchestrator, /trap cleanup EXIT/);
  assert.match(orchestrator, /docker\s+(?:rm|container\s+rm)\b/);
  assert.match(orchestrator, /docker\s+volume\s+rm/);
  assert.match(orchestrator, /docker\s+network\s+rm/);
  assert.match(workflow, /Confirm isolated resource cleanup/);
  assert.match(workflow, /docker ps -a/);
  assert.match(workflow, /docker volume ls/);
  assert.match(workflow, /docker network ls/);
});
