import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const url = process.env.DEFT_TEST_DATABASE_URL;
const safe = !!url && url === process.env.DATABASE_URL
  && /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260927_c19_public_cancellation_test(?:_v[0-9]+)?$/.test(url);
const { Client } = createRequire(import.meta.url)('pg');
async function database<T>(run: (client: InstanceType<typeof Client>) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try { return await run(client); } finally { await client.end(); }
}

test('public cancellation SQL historical consent accepts sixteen exact tuples and rejects malformed or widened ancestry',
  { skip: !safe }, async () => database(async (client) => {
    const creates = Array.from({ length: 16 }, () => ({ app_version_id: randomUUID(), grant_snapshot_id: randomUUID(),
      package_digest: `sha256:${'a'.repeat(64)}`, grant_snapshot_digest: `sha256:${'b'.repeat(64)}` }));
    const policy = (items: unknown[]) => ({ schema_version: 'deft.app_native_historical_create_policy.v1', creates: items });
    const valid = async (value: unknown) => (await client.query('SELECT valid_app_native_historical_create_policy($1::jsonb) AS valid',
      [value === null ? null : JSON.stringify(value)])).rows[0].valid;
    assert.equal(await valid(null), true);
    assert.equal(await valid(policy(creates)), true);
    for (const value of [policy([]), policy([...creates, { ...creates[0], app_version_id: randomUUID() }]),
      policy([creates[0], creates[0]]), policy([{ ...creates[0], unexpected: true }]),
      policy([{ ...creates[0], package_digest: 'unverified' }]), { ...policy(creates), owner_user_id: randomUUID() }]) {
      assert.equal(await valid(value), false);
    }
  }));

test('public cancellation SQL retains unique owner selection and inherited original Run ancestry with deferred complete association',
  { skip: !safe }, async () => database(async (client) => {
    const { rows } = await client.query(`SELECT conname,contype,pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid='app_public_cancellation_selections'::regclass`);
    const constraints = new Map<string, string>(rows.map((row: { conname: string; definition: string }) => [row.conname, row.definition]));
    assert.match(constraints.get('app_public_cancellation_selections_request_fk')!,
      /FOREIGN KEY \(org_id, app_installation_id, cancellation_id, original_run_id\) REFERENCES app_public_cancellations/);
    assert.match(constraints.get('app_public_cancellation_selections_binding_fk')!, /native_binding_id, owner_user_id/);
    assert.match(constraints.get('app_public_cancellation_selections_run_fk')!, /FOREIGN KEY \(org_id, cancel_run_id\) REFERENCES app_runs/);
    assert.equal(rows.filter((row: { contype: string; definition: string }) => row.contype === 'f' && /REFERENCES app_runs/.test(row.definition)).length, 1);
    assert.match(constraints.get('app_public_cancellation_selections_request_unique')!, /UNIQUE \(org_id, cancellation_id\)/);
    assert.match(constraints.get('app_public_cancellation_selections_run_unique')!, /UNIQUE \(org_id, cancel_run_id\)/);
    assert.ok(constraints.has('app_public_cancellation_selections_pin_check'));
    const triggers = (await client.query(`SELECT tgname,tgdeferrable,tginitdeferred FROM pg_trigger
      WHERE tgrelid='app_public_cancellation_selections'::regclass AND NOT tgisinternal`)).rows;
    assert.ok(triggers.some((row: { tgname: string }) => row.tgname === 'app_public_cancellation_selection_immutable'));
    assert.ok(triggers.some((row: { tgname: string; tgdeferrable: boolean; tginitdeferred: boolean }) =>
      row.tgname === 'app_public_cancellation_selection_complete' && row.tgdeferrable && row.tginitdeferred));
  }));
