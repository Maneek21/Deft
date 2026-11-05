import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./installed-app-experience.tsx', import.meta.url), 'utf8');
const accessSource = readFileSync(new URL('./experience-background-access.tsx', import.meta.url), 'utf8');

test('round2: reconnect with unknown target_key falls back to settings without changing target', () => {
  assert.match(source, /const known=catalogRows\.some\(\(row\)=>row\?\.key===targetKey\);/);
  assert.match(source, /if\(!known\)\{await showSettings\(true\);return;\}/);
});

test('round2: reconnect beginAppConnection failure restores the previous target', () => {
  assert.match(source, /setRenewalNotice\(error instanceof Error\?error\.message:'Account setup is unavailable\.'\);/);
  assert.match(source, /setResourceTarget\(currentTarget\);/);
  assert.match(source, /await showSettings\(true\);/);
});

test('round2: reconnect on connected target calls background-access helper and not beginAppConnection', () => {
  assert.match(source, /if\(targetHealth\?\.connection==='connected'\)\{/);
  assert.match(source, /setRenewalNotice\(await reestablishBackgroundAccess\(installationId,targetKey\)\);/);
  assert.match(accessSource, /export async function reestablishBackgroundAccess/);
  assert.match(accessSource, /isSameWebSession\(anchor, api\.getAccessToken\(\)\)/);
});

test('round2: catalog parse drops invalid health while keeping target, and drops invalid target', () => {
  assert.match(source, /function parseExperienceAccountTarget/);
  assert.match(source, /return null;/);
  assert.match(source, /\.filter\(\(item\): item is ExperienceAccountTarget => item !== null\)/);
});

test('round2: dispatch uses existing abort signal instead of new AbortController', () => {
  assert.match(source, /accounts\.catalog\(sourceNominationAbort\.signal\)/);
  assert.doesNotMatch(source, /accounts\.catalog\(new AbortController\(\)\.signal\)/);
});
