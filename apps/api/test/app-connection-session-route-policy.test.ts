import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';

// Configure the ordinary opt-in dependency chain before the boot-time flags load.
Object.assign(process.env, {DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true', DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true',
  DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true', DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true',
  DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true', DEFT_APP_OWNER_CONNECTIONS_ENABLED: 'true'});
const ring = (id: string) => ({current: id, keys: {[id]: createHash('sha256').update('synthetic-route-policy-' + id).digest('base64')}});
process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({schema_version: 'deft.app_run_keyring.v1',
  run_encryption: ring('enc'), receipt_signing: ring('sign'), fingerprint: ring('fingerprint')});

test('connection routes fail closed before parsing when current App or owner rollout is disabled', async () => {
  const {createAppConnectionSessionRoutes} = await import('../src/routes/app-connection-sessions.js');
  const routes = createAppConnectionSessionRoutes();
  for (const flag of ['DEFT_APPS_ENABLED', 'DEFT_APP_OWNER_CONNECTIONS_ENABLED']) {
    process.env[flag] = 'false';
    try {
      for (const path of ['/begin', '/callback', '/status', '/disconnect', '/runtime/authority',
        '/reattach/review', '/reattach/activate', '/reattach/status', '/runtime/reattach-authority',
        '/upgrade/review','/upgrade/begin','/upgrade/callback','/upgrade/status','/v2/begin','/v2/callback','/runtime/authority-v2','/runtime/upgrade-authority']) {
        const response = await routes.request(path, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{'});
        assert.equal(response.status, 503); assert.equal((await response.json()).code, 'APP_FEATURE_DISABLED');
        assert.equal(response.headers.get('cache-control'), 'no-store');
      }
      for(const path of ['context','upgrade-context']){
       const context=await routes.request('/installations/00000000-0000-0000-0000-000000000001/'+path);
       assert.equal(context.status,503);assert.equal((await context.json()).code,'APP_FEATURE_DISABLED');
      }
    } finally {process.env[flag] = 'true';}
  }
});

test('owner and runtime route budgets are independent, bounded and ignore credential/forwarding rotation', async () => {
  const {createAppConnectionSessionRoutes} = await import('../src/routes/app-connection-sessions.js');
  const routes = createAppConnectionSessionRoutes();
  const post = (path: string, index = 0) => routes.request(path, {method: 'POST', body: '{}',
    headers: {'content-type': 'application/json', authorization: 'Bearer synthetic-' + index,
      'x-forwarded-for': '192.0.2.' + (index % 250 + 1), 'x-real-ip': '198.51.100.' + (index % 250 + 1)}});
  for (let index = 0; index < 600; index++) assert.equal((await post('/begin', index)).status, 401);
  assert.equal((await post('/status', 600)).status, 429, 'owner operations share the normal generic API budget');
  // Six complete connection operations can require >90 online checks. Their
  // separate budget admits the normal burst even after the owner budget ends.
  for (let index = 0; index < 120; index++) assert.equal((await post('/runtime/authority', index)).status, 400);
  for (let index = 120; index < 600; index++) assert.equal((await post('/runtime/authority', index)).status, 400);
  const denied = await post('/runtime/authority', 600);
  assert.equal(denied.status, 429); assert.equal(denied.headers.get('retry-after'), '60');
  assert.equal((await post('/disconnect', 601)).status, 429);
});
