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

const RESTORE_SCHEMA_VERSION = 'deft.app_connection_restore.v1';

async function withTempConstraintTable(run) {
  const client = new pg.Client({ connectionString: target });
  await client.connect();
  try {
    await client.query('BEGIN');
    const definition = (await client.query(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'app_connection_sessions_record_identity'"
    )).rows[0].definition;
    const body = definition.replace(/^CHECK\s*/i, '');
    await client.query(
      `CREATE TEMP TABLE t (
        org_id text NOT NULL,
        owner_user_id text NOT NULL,
        session_id text NOT NULL,
        revision integer NOT NULL,
        record jsonb NOT NULL,
        CONSTRAINT app_connection_sessions_record_identity CHECK ${body}
      )`
    );
    await run(client);
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

function makeContext() {
  return {
    org: 'org_' + randomUUID(),
    owner: 'user_' + randomUUID(),
    sessionId: randomUUID(),
    priorSession: randomUUID(),
    installationId: randomUUID(),
    bindingId: randomUUID(),
  };
}

function baseRecord(ctx) {
  const now = new Date().toISOString();
  return {
    session_id: ctx.sessionId,
    revision: 0,
    scope: {
      org_id: ctx.org,
      owner_user_id: ctx.owner,
      installation_id: ctx.installationId,
      target_key: 'inbox',
      resource_key: 'inbox',
      resource_binding_id: ctx.bindingId,
    },
    profile: {
      schema_version: 'deft.app_connection_profile.v1',
      key: 'primary',
      provider_id: 'p',
      operator_user_id: ctx.owner,
      runtime_requirement_key: 'r',
      resource_key: 'inbox',
      action_keys: [],
      authorization_origin: 'https://example.test',
      credential_custody: 'runtime',
      executable: false,
    },
    state: 'starting',
    callback_state_hash: 'a'.repeat(64),
    callback_consumed: false,
    callback_expires_at: new Date(Date.now() + 60_000).toISOString(),
    runtime_session_ref: null,
    account: null,
    created_at: now,
    updated_at: now,
  };
}

function restoreMarker(sessionId) {
  return {
    schema_version: RESTORE_SCHEMA_VERSION,
    source: { session_id: sessionId },
  };
}

async function insertAccepted(client, ctx, record) {
  await client.query(
    'INSERT INTO t (org_id, owner_user_id, session_id, revision, record) VALUES ($1, $2, $3, $4, $5::jsonb)',
    [ctx.org, ctx.owner, ctx.sessionId, 0, JSON.stringify(record)]
  );
}

async function insertRejected(client, ctx, record) {
  let thrown = null;
  try {
    await client.query(
      'INSERT INTO t (org_id, owner_user_id, session_id, revision, record) VALUES ($1, $2, $3, $4, $5::jsonb)',
      [ctx.org, ctx.owner, ctx.sessionId, 0, JSON.stringify(record)]
    );
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, 'record must be rejected by app_connection_sessions_record_identity');
}

const acceptedCases = [
  {
    name: 'valid record without a restore marker',
    build: (ctx) => baseRecord(ctx),
  },
  {
    name: 'valid record with a restore marker whose source.session_id is a different UUID',
    build: (ctx) => {
      const record = baseRecord(ctx);
      record.restore = restoreMarker(ctx.priorSession);
      return record;
    },
  },
];

const rejectedCases = [
  {
    name: 'callback_state_hash is null without a restore marker',
    build: (ctx) => {
      const record = baseRecord(ctx);
      record.callback_state_hash = null;
      return record;
    },
  },
  {
    name: 'callback_state_hash is null with a valid restore marker',
    build: (ctx) => {
      const record = baseRecord(ctx);
      record.callback_state_hash = null;
      record.restore = restoreMarker(ctx.priorSession);
      return record;
    },
  },
  {
    name: 'restore has the wrong schema_version',
    build: (ctx) => {
      const record = baseRecord(ctx);
      record.restore = {
        schema_version: 'deft.app_connection_restore.wrong.v1',
        source: { session_id: ctx.priorSession },
      };
      return record;
    },
  },
  {
    name: 'restore has an extra key',
    build: (ctx) => {
      const record = baseRecord(ctx);
      record.restore = {
        schema_version: RESTORE_SCHEMA_VERSION,
        source: { session_id: ctx.priorSession },
        extra: true,
      };
      return record;
    },
  },
  {
    name: 'restore.source has an extra key',
    build: (ctx) => {
      const record = baseRecord(ctx);
      record.restore = {
        schema_version: RESTORE_SCHEMA_VERSION,
        source: { session_id: ctx.priorSession, extra: true },
      };
      return record;
    },
  },
  {
    name: 'restore is null',
    build: (ctx) => {
      const record = baseRecord(ctx);
      record.restore = null;
      return record;
    },
  },
  {
    name: 'restore.source.session_id is null',
    build: (ctx) => {
      const record = baseRecord(ctx);
      record.restore = {
        schema_version: RESTORE_SCHEMA_VERSION,
        source: { session_id: null },
      };
      return record;
    },
  },
  {
    name: 'restore.source.session_id is not a UUID',
    build: (ctx) => {
      const record = baseRecord(ctx);
      record.restore = {
        schema_version: RESTORE_SCHEMA_VERSION,
        source: { session_id: 'not-a-uuid' },
      };
      return record;
    },
  },
  {
    name: 'restore.source.session_id equals the row session_id',
    build: (ctx) => {
      const record = baseRecord(ctx);
      record.restore = restoreMarker(ctx.sessionId);
      return record;
    },
  },
  {
    name: 'null callback_state_hash on a record carrying credential_repair',
    build: (ctx) => {
      const record = baseRecord(ctx);
      record.callback_state_hash = null;
      record.credential_repair = {};
      return record;
    },
  },
];

for (const testCase of acceptedCases) {
  test(`app_connection_sessions_record_identity temp table: ${testCase.name}`, { skip: !safe }, async () => {
    await withTempConstraintTable(async (client) => {
      const ctx = makeContext();
      const record = testCase.build(ctx);
      await insertAccepted(client, ctx, record);
    });
  });
}

for (const testCase of rejectedCases) {
  test(`app_connection_sessions_record_identity temp table: ${testCase.name}`, { skip: !safe }, async () => {
    await withTempConstraintTable(async (client) => {
      const ctx = makeContext();
      const record = testCase.build(ctx);
      await insertRejected(client, ctx, record);
    });
  });
}