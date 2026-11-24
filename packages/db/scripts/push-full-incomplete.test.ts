import assert from 'node:assert/strict';
import test from 'node:test';
import { describeIncompleteFreshInit } from './push-full.ts';
import { upgradeManifest } from '../upgrades/manifest.ts';

// A stop after fresh initialization began building must say the database is
// incomplete and which recorded upgrades it lacks (SFX1 item 5).

function fakeClient(state: { ledger: string[] | null; server?: string; extensions?: Array<[string, string]> }) {
  return {
    async query(text: string) {
      if (text.includes("to_regclass('public.deft_schema_migrations')")) return { rows: [{ present: state.ledger !== null }] };
      if (text.startsWith('SELECT version FROM deft_schema_migrations')) return { rows: (state.ledger ?? []).map((version) => ({ version })) };
      if (text.includes("current_setting('server_version')")) return { rows: [{ version: state.server ?? '16.15' }] };
      if (text.includes('FROM pg_extension')) {
        return { rows: (state.extensions ?? []).map(([extname, extversion]) => ({ extname, extversion })) };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

const all = upgradeManifest.migrations.map((migration) => migration.version);
const through117 = all.slice(0, all.indexOf('0.3.0-preview.117') + 1);

test('an unrecognized catalog before any ledger: incomplete, the upgrades after 117 missing, versions shown, drop and rerun', async () => {
  const lines = await describeIncompleteFreshInit(
    fakeClient({ ledger: null, server: '16.15 (Ubuntu)', extensions: [['plpgsql', '1.0'], ['vector', '0.6.0']] }),
    new Error('E5_FRESH_PRESTAMP_CATALOG_UNRECOGNIZED'),
  );
  const text = lines.join('\n');
  assert.match(text, /INCOMPLETE/);
  const after117 = all.length - through117.length;
  assert.match(text, new RegExp(`${after117} upgrade\\(s\\) after 0\\.3\\.0-preview\\.117 were not applied \\(0\\.3\\.0-preview\\.118 to `));
  assert.match(text, /ics_publish_tokens/);
  assert.match(text, /user_two_step/);
  assert.match(text, /Postgres 16\.15 \(Ubuntu\); extensions: plpgsql 1\.0, vector 0\.6\.0/);
  assert.match(text, /docker-compose\.yml/);
  assert.match(lines.at(-1)!, /^Drop this database/);
});

test('a stop after the 117 ledger: names the upgrades after 117 and points at db:upgrade', async () => {
  const lines = await describeIncompleteFreshInit(
    fakeClient({ ledger: [upgradeManifest.baseline.version, ...through117] }),
    new Error('E5_REVIEWED_LINEAGE_APPEND_INVALID'),
  );
  const text = lines.join('\n');
  const missing = all.length - through117.length;
  assert.match(text, new RegExp(`${missing} upgrade\\(s\\) after 0\\.3\\.0-preview\\.117 were not applied \\(0\\.3\\.0-preview\\.118 to `));
  assert.doesNotMatch(text, /extensions:/, 'versions are shown only for an unrecognized catalog');
  assert.match(lines.at(-1)!, /pnpm db:upgrade may finish it/);
});

test('a reporting failure never hides the original stop', async () => {
  const broken = { async query() { throw new Error('connection lost'); } };
  const lines = await describeIncompleteFreshInit(broken, new Error('E5_FRESH_PRESTAMP_CATALOG_UNRECOGNIZED'));
  assert.match(lines.join('\n'), /INCOMPLETE/);
  assert.match(lines.at(-1)!, /^Drop this database/);
});

test('a stop with every upgrade recorded says only the final step failed', async () => {
  const lines = await describeIncompleteFreshInit(
    fakeClient({ ledger: [upgradeManifest.baseline.version, ...all] }), new Error('final check failed'));
  assert.match(lines.join('\n'), /Every upgrade was applied, but the final step failed/);
});
