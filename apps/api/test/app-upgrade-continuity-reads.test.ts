import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock, test } from 'node:test';
import { getTableName, getTableColumns, Table } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { appResourceBindings } from '@deft/db/schema';

mock.module(new URL('../src/lib/db.ts', import.meta.url).href, { namedExports: { db: {} } });
mock.module(new URL('../src/lib/module-service.ts', import.meta.url).href, { namedExports: { assertCurrentModuleManagerWithExecutor: async () => {} } });
mock.module(new URL('../src/lib/app-connection-session-registry.ts', import.meta.url).href, { namedExports: { getAppConnectionSessionRegistry: async () => { throw Error('not used'); } } });
mock.module(new URL('../src/lib/app-connection-current-locators.ts', import.meta.url).href, { namedExports: { currentConsentContinuationSourceLocators: () => { throw Error('not used'); } } });
mock.module(new URL('../src/lib/app-connection-session-authority.ts', import.meta.url).href, { namedExports: { currentAppConnectionReadAuthority: async () => { throw Error('not used'); } } });
mock.module(new URL('../src/lib/app-connection-upgrade-fence.ts', import.meta.url).href, { namedExports: { appConnectionUpgradeSourceIsAvailable: async () => true } });
const { assertContinuityProof, UpgradeContinuityProofSchema, rowDigest } = await import('../src/lib/app-upgrade-trust-continuity.js');

const dialect = new PgDialect(), hash = 'sha256:' + 'a'.repeat(64), expires = '2030-01-01T00:00:00.000Z';
type Row = Record<string, any>;
function fixture() {
  const org = randomUUID(), installation = randomUUID(), owner = randomUUID(), operator = randomUUID(), prior = randomUUID(), target = randomUUID();
  const profile = { schema_version: 'deft.app_connection_profile.v1', key: 'provider', provider_id: 'provider', operator_user_id: operator,
    runtime_requirement_key: 'source', resource_key: 'inbox', action_keys: [], authorization_origin: 'https://provider.example.test', credential_custody: 'runtime', executable: false };
  const scope = { org_id: org, owner_user_id: owner, installation_id: installation, app_version_id: prior, grant_snapshot_id: randomUUID(),
    package_digest: hash, grant_snapshot_digest: hash, lifecycle_epoch: 1, grant_epoch: 1, target_key: 'primary', resource_key: 'inbox',
    resource_binding_id: randomUUID(), runtime_registration_id: randomUUID(), operator_user_id: operator, runtime_epoch: 1, profile_digest: hash, consent_expires_at: expires };
  const source = { session_id: randomUUID(), revision: 2, scope, profile, state: 'connected', callback_state_hash: 'a'.repeat(64), callback_consumed: true,
    callback_expires_at: expires, runtime_session_ref: 'private_reference', account: { account_ref: randomUUID(), label: 'Fixture' }, created_at: expires, updated_at: expires };
  const pin = (id = randomUUID()) => ({ id, org_id: org, state: 'active', created_at: new Date('2026-01-01T00:00:00.123Z') });
  const binding = pin(scope.resource_binding_id), registration = pin(scope.runtime_registration_id), admission = pin(), action = pin();
  const proof = UpgradeContinuityProofSchema.parse({ schema_version: 'deft.app_upgrade_continuity.v1', request_id: randomUUID(), org_id: org,
    installation_id: installation, prior_version_id: prior, version_id: target, grant_id: randomUUID(), lifecycle_epoch: 2, grant_epoch: 2,
    trust_revision: 7, owner_id: owner, operator_id: operator, owner_role: 'owner', operator_role: 'member', source_session_id: source.session_id,
    source_revision: source.revision, source_scope: scope, source_profile: profile, connection_protocol: 'v2', transport_digest: hash,
    source_binding: { id: binding.id, digest: rowDigest(binding) }, source_registration: { id: registration.id, digest: rowDigest(registration) },
    source_admission: { id: admission.id, digest: rowDigest(admission) }, source_actions: [{ id: action.id, digest: rowDigest(action) }],
    source_observations: [], source_data: [], web_session_id: randomUUID(), issuance_expires_at: expires });
  const data: Record<string, Row[]> = {
    app_installations: [{ id: installation, org_id: org, state: 'active', active_version_id: target, active_grant_snapshot_id: proof.grant_id, lifecycle_epoch: 2, grant_epoch: 2 }],
    app_versions: [{ id: prior, org_id: org, installation_id: installation, manifest: { schema_version: '7', id: 'community.example.fixture', compatibility: { app_protocol: '7' }, version: '1.0.0' } },
      { id: target, org_id: org, installation_id: installation, manifest: { schema_version: '7', id: 'community.example.fixture', compatibility: { app_protocol: '7' }, version: '1.0.1' } }],
    app_connection_sessions: [{ org_id: org, owner_user_id: owner, session_id: source.session_id, record: source }],
    app_resource_bindings: [binding], app_runtime_registrations: [registration], app_owner_connection_admissions: [admission], app_runtime_bindings: [action],
    audit_log: [{ org_id: org, entity_type: 'app_installation', entity_id: installation, action: 'app.upgrade_continuity_trust_changed', actor_type: 'human', after_state: { trusted: true, revision: 7 } }],
    org_members: [{ org_id: org, user_id: owner, role: 'owner', is_active: true }, { org_id: org, user_id: operator, role: 'member', is_active: true }],
    users: [{ id: owner, kind: 'human', is_agent: false }, { id: operator, kind: 'human', is_agent: false }],
  };
  const queries: { sql: string; params: unknown[]; share: boolean; transferBytes: number }[] = [], locks: string[] = [];
  const name = (table: any) => getTableName(table), original = (table: any) => table[Table.Symbol.OriginalName];
  // Execute the generated equality/IN predicates against independent table rows.
  // This prevents a foreign-org fixture from being accepted merely by nomination.
  const matches = (condition: any, context: Record<string, Row | null>) => {
    if (!condition) return true;
    const { sql, params } = dialect.sqlToQuery(condition), value = (table: string, field: string) => context[table]?.[field];
    for (const match of sql.matchAll(/"([^"]+)"\."([^"]+)" = \$(\d+)/gu)) if (value(match[1]!, match[2]!) !== params[Number(match[3]) - 1]) return false;
    for (const match of sql.matchAll(/"([^"]+)"\."([^"]+)" = "([^"]+)"\."([^"]+)"/gu)) if (value(match[1]!, match[2]!) !== value(match[3]!, match[4]!)) return false;
    for (const match of sql.matchAll(/"([^"]+)"\."([^"]+)" in \(([^)]+)\)/gu)) if (![...match[3]!.matchAll(/\$(\d+)/gu)].some(slot => value(match[1]!, match[2]!) === params[Number(slot[1]) - 1])) return false;
    return true;
  };
  const tx = { execute: async (statement: any) => { locks.push(dialect.sqlToQuery(statement).sql); return { rows: [] }; }, select: (selection?: Row) => {
    let table: any, condition: any, limit = Infinity, share = false; const joins: { table: any; on: any; left: boolean }[] = [];
    const rows = (record = true) => {
      const contexts = (data[original(table)] ?? []).map(row => ({ [name(table)]: row }));
      let joined: Record<string, Row | null>[] = contexts;
      for (const join of joins) joined = joined.flatMap(context => {
        const candidates = (join.table.__rows ? join.table.__rows() : data[original(join.table)] ?? []).map((row: Row) => ({ ...context, [name(join.table)]: row })).filter(next => matches(join.on, next));
        return candidates.length ? candidates : join.left ? [{ ...context, [name(join.table)]: null }] : [];
      });
      const sql = condition ? dialect.sqlToQuery(condition) : { sql: '', params: [] };
      const project = (field: any, context: Record<string, Row | null>): any => {
        if (field?.table) return context[name(field.table)]?.[field.name] ?? null;
        if (field?.[Table.Symbol.Name]) return context[name(field)] ?? null;
        const value = Object.fromEntries(Object.entries(field).map(([key, nested]) => [key, project(nested, context)]));
        return Object.values(value).every(item => item === null) ? null : value;
      };
      const result = joined.filter(context => matches(condition, context)).slice(0, limit).map(context => selection ? project(selection, context) : context[name(table)]);
      if (record) queries.push({ sql: sql.sql, params: sql.params, share, transferBytes: Buffer.byteLength(JSON.stringify(result)) });
      return result;
    };
    const chain: any = { from: (value: any) => { table = value; return chain; }, where: (value: any) => { condition = value; return chain; },
      leftJoin: (value: any, on: any) => { joins.push({ table: value, on, left: true }); return chain; },
      innerJoin: (value: any, on: any) => { joins.push({ table: value, on, left: false }); return chain; },
      limit: (value: number) => { limit = value; return chain; }, orderBy: () => chain, for: () => { share = true; return chain; },
      as: (alias: string) => {
        const aliased: any = { [Table.Symbol.Name]: alias, [Table.Symbol.OriginalName]: alias, __rows: () => rows(false) };
        aliased.after_state = { table: aliased, name: 'after_state' }; return aliased;
      },
      then: (resolve: any, reject: any) => Promise.resolve().then(() => rows()).then(resolve, reject) }; return chain;
  } };
  return { proof, data, queries, locks, tx, run: (issuance = false) => assertContinuityProof(tx as never, proof, true, issuance) };
}

test('unlocked continuity reads every current pin in two statements with original Date values and no locks', async () => {
  const f = fixture(), result = await f.run();
  assert.equal(f.queries.length, 2, 'only current independent reads are batched; no authority decision is cached');
  assert.equal(f.locks.length, 0); assert.ok(f.queries.every(query => !query.share));
  assert.equal(result.source.session_id, f.proof.source_session_id);
  assert.ok(f.data.app_resource_bindings![0]!.created_at instanceof Date);
  await f.run(); assert.equal(f.queries.length, 4, 'a later phase performs all fresh reads again');
});

test('unlocked continuity still denies missing, mixed-org, wrong-owner and independently drifted evidence', async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [];
  for (const table of ['app_installations', 'app_versions', 'app_connection_sessions', 'app_resource_bindings', 'app_runtime_registrations', 'app_owner_connection_admissions', 'app_runtime_bindings']) {
    changes.push(f => { f.data[table] = []; }, f => { f.data[table]![0]!.org_id = randomUUID(); });
  }
  changes.push(f => { f.data.app_versions![1]!.installation_id = randomUUID(); }, f => { f.data.app_connection_sessions![0]!.owner_user_id = randomUUID(); },
    f => { f.data.app_connection_sessions![0]!.record.revision++; }, f => { f.data.app_connection_sessions![0]!.record.scope.target_key = 'other'; },
    f => { f.data.app_installations![0]!.grant_epoch++; }, f => { f.data.audit_log![0]!.after_state.revision++; },
    f => { f.data.audit_log![0]!.after_state.trusted = false; }, f => { f.data.org_members![0]!.is_active = false; },
    f => { f.data.users![1]!.is_agent = true; }, f => { f.data.app_runtime_registrations![0]!.created_at = new Date(0); },
    f => { f.data.app_resource_bindings![0]!.state = 'revoked'; }, f => { f.proof.source_scope.consent_expires_at = '2020-01-01T00:00:00.000Z'; });
  for (const [index, change] of changes.entries()) { const f = fixture(); change(f); await assert.rejects(f.run(), undefined, 'drift scenario ' + index); }
});

test('issuance retains member then installation locks and the original per-pin share sequence', async () => {
  const f = fixture(); await f.run(true);
  assert.equal(f.queries.length, 9); assert.equal(f.locks.length, 3);
  assert.match(f.locks[0]!, /org_members/u); assert.match(f.locks[1]!, /org_members/u); assert.match(f.locks[2]!, /app_installations/u);
  assert.deepEqual(f.queries.filter(query => query.share).map(query => query.params.at(-1)),
    [f.proof.source_binding.id, f.proof.source_registration.id, f.proof.source_admission.id, f.proof.source_actions[0]!.id]);
});

test('later authority invocations reread revocation, source drift and role changes after a successful prior phase', async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => { f.data.app_connection_sessions![0]!.record.state = 'disconnected'; },
    (f: ReturnType<typeof fixture>) => { f.data.app_runtime_registrations![0]!.state = 'revoked'; },
    (f: ReturnType<typeof fixture>) => { f.data.audit_log![0]!.after_state.trusted = false; },
    (f: ReturnType<typeof fixture>) => { f.data.org_members![1]!.role = 'guest'; }]) {
    const f = fixture(); await f.run(); await new Promise(resolve => setImmediate(resolve)); change(f); await assert.rejects(f.run());
  }
});

test('typed nested row selection retains native timestamp decoding and exact full-row digest bytes', async () => {
  const f = fixture(), row = f.data.app_resource_bindings![0]!, columns = Object.values(getTableColumns(appResourceBindings));
  const raw = columns.map(column => { const value = row[column.name] ?? null;
    return value instanceof Date ? value.toISOString().replace('T', ' ').replace(/Z$/u, '') : value; });
  const client = { query: async () => ({ rows: [raw] }) };
  const database = drizzle(client as never);
  const [result] = await database.select({ binding: appResourceBindings }).from(appResourceBindings).limit(1);
  assert.ok(result!.binding.created_at instanceof Date);
  assert.equal(result!.binding.created_at.toISOString(), row.created_at.toISOString());
  const returned = Object.fromEntries(Object.keys(row).map(key => [key, (result!.binding as Row)[key]]));
  assert.equal(rowDigest(returned), rowDigest(row));
});

test('current continuity omits two representative 140KB app packages from transferred version rows', async () => {
  const f = fixture();
  for (const version of f.data.app_versions!) version.package = { worker: 'x'.repeat(140_000) };
  const result = await f.run();
  assert.equal(Object.hasOwn(result.prior!, 'package'), false, 'unread package bytes must not be selected');
  assert.equal(Object.hasOwn(result.target!, 'package'), false);
  assert.deepEqual(Object.keys(result.prior!).sort(), ['id', 'manifest']);
  assert.deepEqual(Object.keys(result.target!).sort(), ['id', 'manifest']);
  assert.ok(f.queries[0]!.transferBytes < 10_000, 'first typed read transfers no package payload');
  assert.equal(result.source.session_id, f.proof.source_session_id);
});

test('actual Drizzle current projection omits package columns and retains every join scope predicate', async () => {
  const f = fixture(), calls: { text: string; values: unknown[] }[] = [];
  const database = drizzle({ query: async (query: any, values: unknown[]) => {
    calls.push({ text: typeof query === 'string' ? query : query.text, values });
    return { rows: [] };
  } } as never);
  await assert.rejects(assertContinuityProof(database as never, f.proof, true, false));
  assert.equal(calls.length, 1);
  const select = calls[0]!.text.split(' from ')[0]!;
  for (const alias of ['continuity_prior_version', 'continuity_target_version']) {
    assert.match(select, new RegExp('"' + alias + '"\\."id"', 'u'));
    assert.match(select, new RegExp('"' + alias + '"\\."manifest"', 'u'));
    assert.doesNotMatch(select, new RegExp('"' + alias + '"\\."package(?:_digest)?"', 'u'));
    for (const field of ['org_id', 'installation_id', 'id'])
      assert.match(calls[0]!.text.slice(select.length), new RegExp('"' + alias + '"\\."' + field + '" = \\$\\d+', 'u'));
  }
  assert.match(calls[0]!.text, /"app_connection_sessions"\."owner_user_id" = \$\d+/u);
  assert.ok(calls[0]!.values.includes(f.proof.owner_id));
});

test('narrow version reads still reject manifest changes and every complete digest-bound source row drift', async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => { f.data.app_versions![1]!.manifest.id = 'community.example.changed'; },
    ...['app_resource_bindings', 'app_runtime_registrations', 'app_owner_connection_admissions', 'app_runtime_bindings'].map(table =>
      (f: ReturnType<typeof fixture>) => { f.data[table]![0]!.extra_current_field = 'changed'; })]) {
    const f = fixture(); await f.run(); change(f); await assert.rejects(f.run());
  }
});


test('warm validation still fences changed versions, grants, epochs and membership without reusing prior authority', async () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => { f.data.app_installations![0]!.active_version_id = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.data.app_installations![0]!.active_grant_snapshot_id = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.data.app_installations![0]!.lifecycle_epoch++; },
    (f: ReturnType<typeof fixture>) => { f.data.app_installations![0]!.grant_epoch++; },
    (f: ReturnType<typeof fixture>) => { f.data.org_members![0]!.org_id = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.data.org_members![1]!.is_active = false; },
    (f: ReturnType<typeof fixture>) => { f.data.users![0]!.kind = 'agent'; },
    (f: ReturnType<typeof fixture>) => { f.data.app_runtime_bindings![0]!.unprojected_field = 'changed'; },
    (f: ReturnType<typeof fixture>) => { f.data.audit_log![0]!.after_state.revision++; },
    (f: ReturnType<typeof fixture>) => { f.data.app_versions![1]!.manifest.future_authority = true; },
  ];
  for (const change of mutations) {
    const f = fixture(); await f.run(); await f.run(); change(f); await assert.rejects(f.run());
  }
});
