import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const access = 'fixture-access-key-with-at-least-32-characters';
const refresh = 'fixture-refresh-key-with-at-least-32-characters';
function start(jwt = access, renewal = refresh, mode = 'production') {
  const source = new URL('../src/lib/env.ts', import.meta.url).href;
  const script = `const {env} = await import(${JSON.stringify(source)}); console.log(JSON.stringify({started:true,exact:env.JWT_SECRET===process.env.JWT_SECRET&&env.JWT_REFRESH_SECRET===process.env.JWT_REFRESH_SECRET}));`;
  return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', script], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { ...process.env, NODE_ENV: mode, DOTENV_CONFIG_QUIET: 'true',
      DATABASE_URL: 'postgres://fixture@127.0.0.1:1/never_connected',
      ENCRYPTION_KEY: 'fixture-envelope-key-with-at-least-32-characters',
      // Explicit empty values prevent a developer .env from filling a negative
      // case; undefined is independently covered by the validator tests.
      DEFT_APP_RUNS_ENABLED: 'false', JWT_SECRET: jwt, JWT_REFRESH_SECRET: renewal },
  });
}

test('production env import fails before startup for missing or insecure signing keys', () => {
  for (const [label, jwt, renewal] of [
    ['both missing', '', ''], ['access missing', '', refresh], ['refresh missing', access, ''],
    ['short', 'a'.repeat(31), refresh], ['template', access, 'change-me-to-another-random-string'],
    ['whitespace', ` ${access}`, refresh], ['same key', access, access],
  ]) {
    const child = start(jwt, renewal);
    assert.equal(child.status, 1, `${label}: production env import must reject before startup`);
    assert.match(child.stderr, /JWT_(?:REFRESH_)?SECRET/);
    assert.equal(child.stdout, '', `${label}: no successful startup marker`);
    for (const value of [jwt, renewal]) if (value) assert.ok(!child.stderr.includes(value), 'validation must not print signing material');
  }
});

test('production env import preserves a valid distinct pair byte for byte', () => {
  const child = start();
  assert.equal(child.status, 0, 'valid explicit signing keys must start');
  assert.deepEqual(JSON.parse(child.stdout), { started: true, exact: true });
});

test('development and test env imports preserve configured signing bytes', () => {
  for (const mode of ['development', 'test']) {
    const child = start(' short dev access ', ' short dev renewal ', mode);
    assert.equal(child.status, 0);
    assert.deepEqual(JSON.parse(child.stdout), { started: true, exact: true });
  }
});
