import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveJwtSecret, resolveJwtSecrets } from '../src/lib/env.js';

const accessDefault = 'dev-jwt-secret-change-me';
const refreshDefault = 'dev-refresh-secret-change-me';
const access = 'fixture-access-key-with-at-least-32-characters';
const refresh = 'fixture-refresh-key-with-at-least-32-characters';

test('production rejects missing, short, padded and exact template keys for either signing purpose', () => {
  const invalid = [undefined, '', ' '.repeat(40), 'a'.repeat(31), ` ${access}`, `${access}\n`,
    accessDefault, refreshDefault, 'CHANGE_ME_JWT_SECRET', 'CHANGE_ME_JWT_REFRESH_SECRET',
    'change-me-to-a-random-string', 'change-me-to-another-random-string',
    'CHANGE_ME_WITH_AT_LEAST_32_RANDOM_CHARACTERS',
    'Change_Me_To_Another_Random_String', 'change me with at least 32 random characters'];
  for (const [name, fallback] of [['JWT_SECRET', accessDefault], ['JWT_REFRESH_SECRET', refreshDefault]]) {
    for (const value of invalid) assert.throws(() => resolveJwtSecret(value, fallback, name, 'production'), new RegExp(name));
  }
});

test('production accepts exact valid bytes and does not use broad substring or entropy rejection', () => {
  for (const value of ['a'.repeat(32), 'b'.repeat(64), 'a-valid-key-with-CHANGE_ME-inside-and-extra-random-data']) {
    assert.equal(resolveJwtSecret(value, accessDefault, 'JWT_SECRET', 'production'), value);
  }
  assert.deepEqual(resolveJwtSecrets(access, refresh, 'production'), { JWT_SECRET: access, JWT_REFRESH_SECRET: refresh });
  assert.throws(() => resolveJwtSecrets(access, access, 'production'), /must be different/);
});

test('development and test preserve pre-validation defaults and configured bytes', () => {
  for (const mode of ['development', 'test', undefined]) {
    assert.equal(resolveJwtSecret(undefined, accessDefault, 'JWT_SECRET', mode), accessDefault);
    assert.equal(resolveJwtSecret('', refreshDefault, 'JWT_REFRESH_SECRET', mode), refreshDefault);
    assert.equal(resolveJwtSecret(' short ', accessDefault, 'JWT_SECRET', mode), ' short ');
    assert.deepEqual(resolveJwtSecrets('same', 'same', mode), { JWT_SECRET: 'same', JWT_REFRESH_SECRET: 'same' });
  }
});

test('production-image API seeding receives the valid signing pair used by the app', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const step = workflow.slice(workflow.indexOf('name: Start production-image test stack'));
  const access = /JWT_SECRET: (\S+)/.exec(step)?.[1];
  const refresh = /JWT_REFRESH_SECRET: (\S+)/.exec(step)?.[1];
  assert.doesNotThrow(() => resolveJwtSecrets(access, refresh, 'production'));
  const seed = step.slice(step.indexOf('docker run --rm'), step.indexOf('# Fixed API fixtures'));
  assert.match(seed, /-e JWT_SECRET="\$JWT_SECRET"/);
  assert.match(seed, /-e JWT_REFRESH_SECRET="\$JWT_REFRESH_SECRET"/);
});
