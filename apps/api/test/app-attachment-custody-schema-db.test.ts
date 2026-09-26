import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
const target = process.env.DEFT_TEST_DATABASE_URL;
const assigned = (() => { if (!target || target !== process.env.DATABASE_URL) return false;
  const u = new URL(target); return u.protocol === 'postgresql:' && u.username === 'gate_g_test'
    && !u.password && u.hostname === '127.0.0.1' && u.port === '55435'
    && /^\/gate_g_20260927_c19_attachment_test(?:_v[0-9]+)?$/u.test(u.pathname) && !u.search && !u.hash; })();
const policy = { max_attachment_bytes: 2097152, max_attachments_per_record: 8, max_attachments_per_run: 32,
  max_attachment_bytes_per_run: 8388608, retention_days: 7, allowed_media_types: ['text/csv'] };
const digest = 'sha256:' + '1'.repeat(64);
async function connect() { assert.ok(assigned, 'Exact synthetic attachment target required');
  const c = new pg.Client({ connectionString: target, statement_timeout: 2000, query_timeout: 3000 }); await c.connect(); return c; }

test('official attachment fresh schema contains exact .47 ledger, scoped custody FKs and enforcing triggers', { skip: !assigned }, async () => {
  const c = await connect(); try {
    const versions = await c.query("SELECT version FROM deft_schema_migrations ORDER BY applied_at,version");
    assert.equal(versions.rows.length, 45); assert.ok(versions.rows.some(r => r.version === '0.3.0-preview.47'));
    const constraints = await c.query("SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='app_attachment_stages'::regclass");
    for (const name of ['checkpoint_fk','attempt_fk','projection_fk','retry_unique','identity_check','metadata_check','state_check']) {
      assert.ok(constraints.rows.some(r => r.conname === 'app_attachment_stages_' + name), name);
    }
    for (const name of ['app_attachment_stage_guard_trigger','app_attachment_stage_capacity_trigger','app_attachment_binding_policy_guard_trigger']) {
      const found = await c.query('SELECT tgenabled FROM pg_trigger WHERE tgname=$1 AND NOT tgisinternal', [name]);
      assert.equal(found.rows[0]?.tgenabled, 'O');
    }
    assert.equal((await c.query('SELECT count(*)::int AS n FROM app_attachment_stages')).rows[0]?.n, 0);
  } finally { await c.end(); }
});

test('installed SQL consent check denies old-binding promotion and closed v3 policy widening/null/duplicate bypasses', { skip: !assigned }, async () => {
  const c = await connect(); try {
    const definition = (await c.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='app_resource_bindings_attachment_policy_check' AND conrelid='app_resource_bindings'::regclass")).rows[0]?.definition;
    assert.equal(typeof definition, 'string');
    // Temporary probe executes the exact installed CHECK; it creates no App,
    // registration, binding, or effective authority and cannot hide FK failures.
    await c.query('CREATE TEMP TABLE attachment_policy_probe (registration_contract_version text, attachment_policy jsonb, attachment_consent_digest text, reviewed_descriptor jsonb, ' + definition + ')');
    const insert = (version: string, value: unknown, consent: string | null, descriptor = { attachments: policy }) => c.query(
      'INSERT INTO attachment_policy_probe VALUES ($1,$2,$3,$4)', [version, value == null ? null : JSON.stringify(value), consent, JSON.stringify(descriptor)]);
    await insert('deft.app_runtime_channel.v2', null, null);
    await insert('deft.app_runtime_channel.v3', policy, digest);
    await insert('deft.app_runtime_channel.v3', { ...policy, max_attachment_bytes: 1000, retention_days: 1 }, digest);
    await assert.rejects(insert('deft.app_runtime_channel.v2', policy, digest));
    await assert.rejects(insert('deft.app_runtime_channel.v3', null, digest));
    await assert.rejects(insert('deft.app_runtime_channel.v3', policy, null));
    await assert.rejects(insert('deft.app_runtime_channel.v3', policy, 'invalid'));
    for (const invalid of [{ ...policy, retention_days: 8 }, { ...policy, max_attachment_bytes: 2097153 },
      { ...policy, max_attachment_bytes: 1.5 }, { ...policy, provider_url: 'https://invalid.example' },
      { ...policy, allowed_media_types: ['text/csv','text/csv'] }, { ...policy, allowed_media_types: ['image/png'] },
      { ...policy, allowed_media_types: [] }, { ...policy, retention_days: null }]) {
      await assert.rejects(insert('deft.app_runtime_channel.v3', invalid, digest));
    }
    await assert.rejects(insert('deft.app_runtime_channel.v3', policy, digest, { attachments: {} }));
    assert.equal((await c.query('SELECT count(*)::int AS n FROM attachment_policy_probe')).rows[0]?.n, 3);
  } finally { await c.end(); }
});
