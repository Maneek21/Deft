import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = target === process.env.DATABASE_URL && target !== undefined
  && new URL(target).hostname === '127.0.0.1' && new URL(target).port === '55435'
  && /^\/gate_g_phase5_test_c03b_(?:public|root)(?:_v[0-9]+)?$/.test(new URL(target).pathname);

test('anonymous public route mounts only when Apps and explicit ingress opt-in are both enabled',
  { skip: !safe }, () => {
    const script = `import { app } from './src/index.ts';
      const response = await app.request('http://localhost/api/public/apps/invalid/claims', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      });
      console.log('FLAG_RESULT:' + JSON.stringify({ status: response.status,
        body: await response.json() }));
      process.exit(0);`;
    function result(apps: string, ingress: string) {
      const output = execFileSync(process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script], {
          cwd: fileURLToPath(new URL('../', import.meta.url)),
          env: { ...process.env, DEFT_APPS_ENABLED: apps,
            DEFT_APP_PUBLIC_INGRESS_ENABLED: ingress },
          encoding: 'utf8', timeout: 60_000,
        });
      const line = output.split(/\r?\n/).find((part) => part.startsWith('FLAG_RESULT:'));
      assert.ok(line, output);
      return JSON.parse(line.slice('FLAG_RESULT:'.length)) as {
        status: number; body: { code?: string };
      };
    }
    const defaultOff = result('true', 'false');
    const appsOff = result('false', 'true');
    const enabled = result('true', 'true');
    assert.notEqual(defaultOff.body.code, 'PUBLIC_NOT_FOUND');
    assert.notEqual(appsOff.body.code, 'PUBLIC_NOT_FOUND');
    assert.equal(enabled.status, 404);
    assert.equal(enabled.body.code, 'PUBLIC_NOT_FOUND');
  });
