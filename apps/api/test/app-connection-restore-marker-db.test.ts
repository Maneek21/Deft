import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = (() => {
  if (!target || target !== process.env.DATABASE_URL) return false;
  try {
    const url = new URL(target);
    return ['postgres:', 'postgresql:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && ['55440', '5432'].includes(url.port)
      && /^\/deft_test/u.test(url.pathname) && !url.search && !url.hash;
  } catch { return false; }
})();

test('app_connection_sessions accepts a restore successor marker', { skip: !safe }, async () => {
  const client = new pg.Client({ connectionString: target });
  await client.connect();
  try {
    await client.query('BEGIN');
    const org = 'org_' + randomUUID().replace(/-/g, '').slice(0, 12);
    const owner = 'user_' + randomUUID().replace(/-/g, '').slice(0, 12);
    const webSession = 'ws_' + randomUUID().replace(/-/g, '').slice(0, 12);
    const priorSession = randomUUID();
    const sessionId = randomUUID();
    await client.query('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [org, 'Org', 'slug-' + org]);
    await client.query('INSERT INTO users(id,name,email,kind) VALUES($1,$2,$3,$4)', [owner, 'User', owner + '@t', 'human']);
    await client.query('INSERT INTO org_members(id,org_id,user_id,role,is_active,app_run_authorization_version,joined_at,created_at,updated_at) VALUES($1,$2,$3,$4,true,1,now(),now(),now())', [randomUUID(), org, owner, 'owner']);
    await client.query('INSERT INTO web_sessions(id,user_id,org_id,refresh_token_hash,expires_at) VALUES($1,$2,$3,$4,$5)',
      [webSession, owner, org, 'a'.repeat(64), new Date(Date.now() + 3600_000)]);

    const baseRecord = {
      session_id: sessionId, revision: 0, scope: { org_id: org, owner_user_id: owner, installation_id: randomUUID(), target_key: 'inbox', resource_key: 'inbox', resource_binding_id: randomUUID() },
      profile: { schema_version: 'deft.app_connection_profile.v1', key: 'primary', provider_id: 'p', operator_user_id: owner, runtime_requirement_key: 'r', resource_key: 'inbox', action_keys: [], authorization_origin: 'https://example.test', credential_custody: 'runtime', executable: false },
      state: 'starting', callback_state_hash: 'a'.repeat(64), callback_consumed: false,
      callback_expires_at: new Date(Date.now() + 60_000).toISOString(), runtime_session_ref: null, account: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      restore: { schema_version: 'deft.app_connection_restore.v1', source: { session_id: priorSession } },
    };
    await client.query(
      'INSERT INTO app_connection_sessions(org_id,owner_user_id,session_id,web_session_id,access_expires_at,revision,record,created_at,updated_at) VALUES($1,$2,$3,$4,$5,0,$6::jsonb,$7,$8)',
      [org, owner, sessionId, webSession, new Date(Date.now() + 3600_000), JSON.stringify(baseRecord), baseRecord.created_at, baseRecord.updated_at]);
    // accepted: no constraint violation
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
});

test('app_connection_sessions rejects a restore marker pointing at itself', { skip: !safe }, async () => {
  const client = new pg.Client({ connectionString: target });
  await client.connect();
  try {
    await client.query('BEGIN');
    const org = 'org_' + randomUUID().replace(/-/g, '').slice(0, 12);
    const owner = 'user_' + randomUUID().replace(/-/g, '').slice(0, 12);
    const webSession = 'ws_' + randomUUID().replace(/-/g, '').slice(0, 12);
    const sessionId = randomUUID();
    await client.query('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [org, 'Org', 'slug-' + org]);
    await client.query('INSERT INTO users(id,name,email,kind) VALUES($1,$2,$3,$4)', [owner, 'User', owner + '@t', 'human']);
    await client.query('INSERT INTO org_members(id,org_id,user_id,role,is_active,app_run_authorization_version,joined_at,created_at,updated_at) VALUES($1,$2,$3,$4,true,1,now(),now(),now())', [randomUUID(), org, owner, 'owner']);
    await client.query('INSERT INTO web_sessions(id,user_id,org_id,refresh_token_hash,expires_at) VALUES($1,$2,$3,$4,$5)',
      [webSession, owner, org, 'a'.repeat(64), new Date(Date.now() + 3600_000)]);

    const baseRecord = {
      session_id: sessionId, revision: 0, scope: { org_id: org, owner_user_id: owner, installation_id: randomUUID(), target_key: 'inbox', resource_key: 'inbox', resource_binding_id: randomUUID() },
      profile: { schema_version: 'deft.app_connection_profile.v1', key: 'primary', provider_id: 'p', operator_user_id: owner, runtime_requirement_key: 'r', resource_key: 'inbox', action_keys: [], authorization_origin: 'https://example.test', credential_custody: 'runtime', executable: false },
      state: 'starting', callback_state_hash: 'a'.repeat(64), callback_consumed: false,
      callback_expires_at: new Date(Date.now() + 60_000).toISOString(), runtime_session_ref: null, account: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      restore: { schema_version: 'deft.app_connection_restore.v1', source: { session_id: sessionId } },
    };
    let thrown: any = null;
    try {
      await client.query(
        'INSERT INTO app_connection_sessions(org_id,owner_user_id,session_id,web_session_id,access_expires_at,revision,record,created_at,updated_at) VALUES($1,$2,$3,$4,$5,0,$6::jsonb,$7,$8)',
        [org, owner, sessionId, webSession, new Date(Date.now() + 3600_000), JSON.stringify(baseRecord), baseRecord.created_at, baseRecord.updated_at]);
    } catch (e) { thrown = e; }
    assert.ok(thrown, 'self-referential restore marker is rejected');
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
});