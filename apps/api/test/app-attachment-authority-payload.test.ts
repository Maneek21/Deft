import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getTableColumns, getTableName, Table } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { appInstallations, appVersions, appGrantSnapshots } from '@deft/db/schema';
import { parseAttachmentAppManifest } from '@deft/app-kit/core';
import { buildRequestedAppGrantProjection, digestAppGrantValue } from '../src/lib/app-grant-service.js';
import { buildResourceSyncAuthorizationSnapshot } from '../src/lib/app-resource-sync-authorization.js';

mock.module(new URL('../src/lib/env.ts', import.meta.url).href, { namedExports: {
  isAppAttachmentBrokerEnabled: () => true, isAppV5RuntimeActionsEnabled: () => true,
} });
mock.module(new URL('../src/lib/app-runtime-review.ts', import.meta.url).href, { namedExports: { runtimeActionDescriptors: () => [] } });
const { loadReviewedAttachmentApp, buildAttachmentAppReviewedAuthority, ATTACHMENT_APP_EFFECTIVE_CLASSIFICATION } =
  await import('../src/lib/app-attachment-authority.js');

const dialect = new PgDialect(), hash = 'sha256:' + 'a'.repeat(64);
type Row = Record<string, any>;
function fixture() {
  const org = randomUUID(), installationId = randomUUID(), versionId = randomUUID(), requestedId = randomUUID(), grantId = randomUUID();
  const manifest = parseAttachmentAppManifest(JSON.parse(readFileSync(new URL('./fixtures/runtime-security-manifest.json', import.meta.url), 'utf8')));
  const installation = { id: installationId, org_id: org, app_id: manifest.id, state: 'active', lineage_key: 'fixture',
    active_version_id: versionId, active_grant_snapshot_id: grantId, active_grant_snapshot_kind: 'effective' };
  const version: Row = { ...Object.fromEntries(Object.keys(getTableColumns(appVersions)).map(key => [key, null])),
    id: versionId, org_id: org, installation_id: installationId, version: manifest.version, protocol_version: '7',
    state: 'active', manifest, manifest_digest: digestAppGrantValue(manifest), package_digest: hash,
    package: { worker: 'x'.repeat(140_000) }, requested_grant_snapshot_id: requestedId,
    created_at: new Date('2026-01-01T00:00:00.123Z'), updated_at: new Date('2026-01-01T00:00:00.123Z') };
  const projection = buildRequestedAppGrantProjection({ organization_id: org, app_installation_id: installationId,
    app_version_id: versionId, manifest, manifest_digest: version.manifest_digest, package_digest: hash });
  const requested: Row = { id: requestedId, org_id: org, app_installation_id: installationId, app_version_id: versionId,
    snapshot_kind: 'requested', ...projection };
  const authority = buildAttachmentAppReviewedAuthority(manifest,
    { lineage_key: installation.lineage_key, package_digest: hash, manifest_digest: version.manifest_digest }, true);
  const canonical = { ...authority, organization_id: org, app_installation_id: installationId, app_version_id: versionId,
    requested_snapshot_id: requestedId, requested_snapshot_digest: requested.snapshot_digest,
    classification: ATTACHMENT_APP_EFFECTIVE_CLASSIFICATION, review_digest: hash };
  const grant: Row = { id: grantId, org_id: org, app_installation_id: installationId, app_version_id: versionId,
    app_id: manifest.id, app_version: manifest.version, snapshot_kind: 'effective', requested_snapshot_id: requestedId,
    manifest_digest: version.manifest_digest, package_digest: hash, canonical_snapshot: canonical,
    classification: ATTACHMENT_APP_EFFECTIVE_CLASSIFICATION, resource_rights: [], snapshot_digest: digestAppGrantValue(canonical) };
  const rows: Record<string, Row[]> = { app_installations: [installation], app_versions: [version], app_grant_snapshots: [grant, requested] };
  const calls: { table: string; params: unknown[]; share: boolean; columns: string[]; bytes: number }[] = [];
  const tx = { select: (selection?: Record<string, any>) => {
    let table: any, where: any, share = false;
    const joins: { table: any; on: any }[] = [];
    const original = (value: any) => value[Table.Symbol.OriginalName] ?? getTableName(value);
    const matches = (condition: any, context: Record<string, Row | null>) => {
      const query = dialect.sqlToQuery(condition);
      return [...query.sql.matchAll(/"([^"]+)"\."([^"]+)" = (?:\$(\d+)|"([^"]+)"\."([^"]+)")/gu)].every(match => {
        const left = context[match[1]!] ? context[match[1]!]![match[2]!] : null;
        const right = match[3] ? query.params[Number(match[3]) - 1] : context[match[4]!]?.[match[5]!] ?? null;
        return left != null && right != null && left === right;
      });
    };
    const project = (field: any, context: Record<string, Row | null>): any => {
      if (field?.table) return context[getTableName(field.table)]?.[field.name] ?? null;
      if (field?.[Table.Symbol.Name]) return context[getTableName(field)] ?? null;
      const value = Object.fromEntries(Object.entries(field).map(([key, nested]) => [key, project(nested, context)]));
      return Object.values(value).every(item => item === null) ? null : value;
    };
    const chain: any = { from: (value: any) => { table = value; return chain; }, where: (value: any) => { where = value; return chain; },
      leftJoin: (value: any, on: any) => { joins.push({ table: value, on }); return chain; },
      limit: () => chain, for: (lock: string) => { share = lock === 'share'; return chain; },
      then: (resolve: any, reject: any) => Promise.resolve().then(() => {
        const query = dialect.sqlToQuery(where), name = getTableName(table);
        let contexts: Record<string, Row | null>[] = (rows[original(table)] ?? []).map(row => ({ [name]: row }));
        for (const join of joins) contexts = contexts.flatMap(context => {
          const found = (rows[original(join.table)] ?? []).map(row => ({ ...context, [getTableName(join.table)]: row }))
            .filter(candidate => matches(join.on, candidate));
          return found.length ? found : [{ ...context, [getTableName(join.table)]: null }];
        });
        const returned = contexts.filter(context => matches(where, context)).map(context => selection ? project(selection, context) : context[name]);
        calls.push({ table: name, params: query.params, share, columns: Object.keys(selection?.version ?? selection ?? getTableColumns(table)), bytes: Buffer.byteLength(JSON.stringify(returned)) });
        return returned;
      }).then(resolve, reject) }; return chain;
  } };
  return { org, installationId, rows, version, requested, grant, calls, tx,
    run: () => loadReviewedAttachmentApp(tx as never, org, installationId) };
}

test('reviewed attachment authority transfers every version field except the unused 140KB package', async () => {
  const f = fixture(), result = await f.run(), versionRead = f.calls.find(call => call.table === 'app_versions')!;
  assert.equal(Object.hasOwn(result.version, 'package'), false);
  assert.deepEqual(versionRead.columns.sort(), Object.keys(getTableColumns(appVersions)).filter(key => key !== 'package').sort());
  assert.ok(versionRead.bytes < 80_000, 'typed version plus both grants excludes the 140KB package');
  assert.ok(result.version.created_at instanceof Date);
  assert.deepEqual(f.calls.filter(call => call.share).map(call => call.table), ['app_installations', 'app_versions']);
  assert.equal(result.grant.snapshot_digest, f.grant.snapshot_digest);
});

test('actual attachment Drizzle version query retains scoped active/protocol predicates and FOR SHARE', async () => {
  const f = fixture(), queries: string[] = [];
  const database = drizzle({ query: async (query: any) => {
    const text = typeof query === 'string' ? query : query.text; queries.push(text);
    if (queries.length === 1) return { rows: [Object.values(getTableColumns(appInstallations)).map(column => f.rows.app_installations![0]![column.name] ?? null)] };
    return { rows: [] };
  } } as never);
  await assert.rejects(loadReviewedAttachmentApp(database as never, f.org, f.installationId));
  assert.equal(queries.length, 2);
  const sql = queries[1]!, select = sql.split(' from ')[0]!;
  assert.doesNotMatch(select, /"package"(?:,|$)/u);
  assert.match(select, /"package_digest"/u);
  for (const field of ['org_id', 'id', 'installation_id', 'protocol_version', 'state']) assert.match(sql, new RegExp('"' + field + '" = \\$\\d+', 'u'));
  assert.match(sql, /for share of "app_versions"$/u);
});

test('warm immutable reconstruction still rereads all live rows and isolates returned manifest values', async () => {
  const f = fixture(), first = await f.run(), before = f.calls.length;
  first.manifest.id = 'community.example.poisoned';
  const second = await f.run();
  assert.equal(f.calls.length - before, 2, 'each admission rereads installation and the typed version/both-grant join');
  assert.equal(second.manifest.id, f.version.manifest.id, 'returned values cannot poison retained reconstruction');
  f.rows.app_installations![0]!.state = 'disabled';
  await assert.rejects(f.run(), 'warm reconstruction is never an active-installation decision');
});

test('package projection retains current organization, activation, requested grant and full digest checks', async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.rows.app_installations![0]!.org_id = randomUUID(); }, f => { f.version.org_id = randomUUID(); },
    f => { f.version.installation_id = randomUUID(); }, f => { f.version.state = 'superseded'; },
    f => { f.version.protocol_version = '6'; }, f => { f.version.manifest_digest = 'sha256:' + 'b'.repeat(64); },
    f => { f.version.package_digest = 'sha256:' + 'b'.repeat(64); }, f => { f.requested.canonical_snapshot.extra = 'changed'; },
    f => { f.grant.canonical_snapshot.extra = 'changed'; }, f => { f.grant.classification = {}; },
    f => { f.grant.requested_snapshot_id = randomUUID(); }, f => { f.rows.app_versions = []; },
  ];
  for (const [index, change] of changes.entries()) { const f = fixture(); await f.run(); change(f); await assert.rejects(f.run(), undefined, 'current drift ' + index); }
});

test('resource snapshot serialization uses only the current version ID and package digest', () => {
  const owner = randomUUID(), version = { id: randomUUID(), package_digest: hash };
  const facts = { binding: { id: randomUUID(), owner_user_id: owner, reviewed_by_user_id: owner,
    reviewed_at: new Date('2030-01-01T10:00:00Z'), consent_expires_at: new Date('2030-01-01T12:00:00Z'),
    risk_class: 'read_only', review_requirement: 'none', review_scope: 'reviewed_resource_sync', retry_class: 'never', retention_class: 'standard',
    max_records_per_page: 25, max_page_bytes: 524288, max_retained_records: 100, max_retained_bytes: 1048576, min_interval_seconds: 300 },
    installation: { id: randomUUID(), lifecycle_epoch: 1, grant_epoch: 1 }, version: { ...version, package: { worker: 'x'.repeat(140_000) } },
    grant: { id: randomUUID(), snapshot_digest: hash }, registration: { id: randomUUID(), operator_user_id: owner, runtime_epoch: 1 },
    descriptor_digest: hash, provider_snapshot: { id: randomUUID(), snapshot_digest: hash } };
  const full = buildResourceSyncAuthorizationSnapshot(facts as never);
  const guarded = new Proxy(version, { get: (target, key) => {
    assert.ok(key === 'id' || key === 'package_digest', 'No package access, JSON serialization or whole-version digest'); return Reflect.get(target, key);
  }, ownKeys: () => { throw Error('No whole-version traversal'); } });
  assert.deepEqual(buildResourceSyncAuthorizationSnapshot({ ...facts, version: guarded } as never), full);
  version.package_digest = 'sha256:' + 'b'.repeat(64);
  const changed = buildResourceSyncAuthorizationSnapshot({ ...facts, version: guarded } as never);
  assert.notDeepEqual(changed, full, 'the reviewed package digest remains part of the authority pin');
});

test('warm descriptor digest reuse still reloads current locked App/grant bytes and rejects drift', async () => {
  const { loadReviewedAttachmentSyncDescriptor } = await import('../src/lib/app-attachment-sync-reviewed.js');
  const f = fixture(), read = () => loadReviewedAttachmentSyncDescriptor(f.tx as never, f.org, f.installationId);
  const first = await read(), before = f.calls.length, digest = first.descriptor_digest;
  first.descriptor.attachments.max_attachment_bytes--;
  const next = await read();
  assert.equal(next.descriptor_digest, digest, 'caller mutation cannot alter a retained digest or current descriptor');
  assert.equal(f.calls.length - before, 2, 'warm digest reuse still reads locked installation and exact version/grants');
  assert.deepEqual(f.calls.slice(-2).map(call => [call.table, call.share]), [['app_installations', true], ['app_versions', true]]);
  f.version.manifest.sync_descriptors[0].attachments.max_attachment_bytes--;
  await assert.rejects(read(), 'actual descriptor drift under unchanged advertised manifest/grant digests fails current reconstruction');
  const disabled = fixture();
  await loadReviewedAttachmentSyncDescriptor(disabled.tx as never, disabled.org, disabled.installationId);
  disabled.rows.app_installations![0]!.state = 'disabled';
  await assert.rejects(loadReviewedAttachmentSyncDescriptor(disabled.tx as never, disabled.org, disabled.installationId));
});
