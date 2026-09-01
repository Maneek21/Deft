import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const setupHook = readFileSync(
  new URL('./ci/app-platform-track-a-certification-setup.sh', import.meta.url),
  'utf8',
);
const setupProbe = readFileSync(
  new URL('../apps/api/src/scripts/app-platform-track-a-certification-setup.ts', import.meta.url),
  'utf8',
);

function occurrences(source, value) {
  return source.split(value).length - 1;
}

test('Track A setup delegates Phase 6 and adds only the frozen automation prerequisites', () => {
  assert.match(setupHook, /2f4db0834d9563a359169f84f9d79e471c77f056/);
  assert.match(setupHook, /bash "\$phase6_setup"/);
  assert.equal(occurrences(setupHook, 'docker run '), 1);
  assert.doesNotMatch(setupHook, /docker compose|browser-smoke|certify-app-platform/);
  assert.match(setupHook, /examples\/scheduled-connected-resource-campaigns-app/);
  assert.match(setupHook, /packages\/app-kit\/dist\/cli\.js" app check/);
  assert.match(setupHook, /packages\/app-kit\/dist\/cli\.js" app build/);
  assert.match(setupHook, /DEFT_APP_AUTOMATIONS_ENABLED=true/);
  assert.match(setupHook, /track-a-browser-fixture\.json/);
  assert.match(setupHook, /track-a-setup-summary\.json/);
  assert.match(setupProbe, /stageAppUpgrade/);
  assert.match(setupProbe, /prepareConnectedAppReview/);
  assert.match(setupProbe, /activateConnectedAppInstallation/);
  assert.match(setupProbe, /appAutomationDefinitions/);
  assert.match(setupProbe, /assert\.equal\(definitionsAfter\.length, 0\)/);
  assert.match(setupProbe, /assert\.equal\(campaignRecords\.length, 1\)/);
  assert.match(setupProbe, /assert\.equal\(contactRecords\.length, 1\)/);
  assert.match(setupProbe, /assert\.equal\(relation\.items\.length, 1\)/);
});
