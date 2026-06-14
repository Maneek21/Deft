import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  buildResetPlan,
  composeArgs,
  isPublicUrl,
  parseResetArgs,
  validateResetSafety,
} from './selfhost-reset.ts';

test('compose args include base, prod, and extra overlays in order', () => {
  const options = parseResetArgs(['--prod', '--compose-file', 'compose.demo.yml']);

  assert.deepEqual(composeArgs(options), [
    'compose',
    '-f',
    'docker-compose.yml',
    '-f',
    'compose.prod.yml',
    '-f',
    'compose.demo.yml',
  ]);
});

test('reset refuses destructive execution without force', () => {
  const options = parseResetArgs(['--platform-only']);

  assert.throws(
    () => validateResetSafety(options, { NEXT_PUBLIC_APP_URL: 'http://localhost:3000' }),
    /without --force/
  );
});

test('public or production-looking targets need explicit production reset confirmation', () => {
  const options = parseResetArgs(['--prod', '--force']);

  assert.throws(
    () => validateResetSafety(options, { NEXT_PUBLIC_APP_URL: 'https://demo.deft.ing' }),
    /--force-production-reset/
  );
});

test('dry run can print a public reset plan without force flags', () => {
  const options = parseResetArgs(['--prod', '--dry-run']);

  assert.doesNotThrow(() => validateResetSafety(options, { NEXT_PUBLIC_APP_URL: 'https://demo.deft.ing' }));
});

test('platform-only reset uses platform init and skips demo seed', () => {
  const options = parseResetArgs(['--force']);
  const plan = buildResetPlan(options);
  const init = plan.find((step) => step.label.includes('platform seed'));

  assert.ok(init);
  assert.equal(init?.args.includes('pnpm db:seed:pilot'), false);
});

test('reset builds current images before destructive steps by default', () => {
  const options = parseResetArgs(['--force']);
  const plan = buildResetPlan(options);

  assert.equal(plan[0]?.label, 'Build current app and tool images');
  assert.deepEqual(plan[0]?.args.slice(-4), ['deft', 'init', 'doctor', 'smoke']);
});

test('skip-build omits the image build step', () => {
  const options = parseResetArgs(['--force', '--skip-build']);
  const plan = buildResetPlan(options);

  assert.notEqual(plan[0]?.label, 'Build current app and tool images');
});

test('seed-pilot reset uses the pilot seed command', () => {
  const options = parseResetArgs(['--seed-pilot', '--force']);
  const plan = buildResetPlan(options);
  const init = plan.find((step) => step.label.includes('pilot demo'));

  assert.ok(init);
  assert.ok(init?.args.includes('pnpm db:push-full && pnpm db:seed:pilot'));
});

test('reset recreates the app container so current env takes effect', () => {
  const options = parseResetArgs(['--force']);
  const plan = buildResetPlan(options);
  const start = plan.find((step) => step.label.includes('Start app'));

  assert.ok(start?.args.includes('--force-recreate'));
});

test('keep flags omit Redis flush and upload clear steps', () => {
  const options = parseResetArgs(['--force', '--keep-redis', '--keep-uploads']);
  const labels = buildResetPlan(options).map((step) => step.label);

  assert.equal(labels.some((label) => label.includes('Redis')), false);
  assert.equal(labels.some((label) => label.includes('uploads')), false);
});

test('backup-only has no reset plan', () => {
  const options = parseResetArgs(['--backup-only']);

  assert.deepEqual(buildResetPlan(options), []);
});

test('doctor and smoke receive runtime public URL overrides', () => {
  const options = parseResetArgs(['--force']);
  const plan = buildResetPlan(options, {
    NEXT_PUBLIC_APP_URL: 'http://localhost:3090',
    NEXT_PUBLIC_API_URL: 'http://localhost:3091',
    NEXT_PUBLIC_WS_URL: 'http://localhost:3091',
  });
  const doctor = plan.find((step) => step.label.includes('doctor'));
  const smoke = plan.find((step) => step.label.includes('smoke'));

  assert.ok(doctor?.args.includes('NEXT_PUBLIC_APP_URL=http://localhost:3090'));
  assert.ok(doctor?.args.includes('NEXT_PUBLIC_API_URL=http://localhost:3091'));
  assert.ok(smoke?.args.includes('NEXT_PUBLIC_WS_URL=http://localhost:3091'));
});

test('public URL detection ignores localhost', () => {
  assert.equal(isPublicUrl('http://localhost:3000'), false);
  assert.equal(isPublicUrl('http://127.0.0.1:3000'), false);
  assert.equal(isPublicUrl('https://demo.deft.ing'), true);
});
