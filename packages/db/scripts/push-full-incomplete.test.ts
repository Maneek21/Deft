import assert from 'node:assert/strict';
import test from 'node:test';
import { describeIncompleteFreshInit } from './push-full.ts';
import { upgradeManifest } from '../upgrades/manifest.ts';

// A stop after fresh initialization began building must say the database is
// incomplete and which recorded upgrades it lacks (SFX1 item 5).

type State = {
  tables?: number | 'error';
  ledger: string[] | null | 'error';
  present?: string[];
  server?: string;
  extensions?: Array<[string, string]>;
};

function fakeClient(state: State) {
  return {
    async query(text: string) {
      if (text.includes('information_schema.tables')) {
        if (state.tables === 'error') throw new Error('connection lost');
        return { rows: [{ count: state.tables ?? 200 }] };
      }
      if (text.includes("to_regclass('public.deft_schema_migrations')")) {
        if (state.ledger === 'error') throw new Error('connection lost');
        return { rows: [{ present: state.ledger !== null }] };
      }
      if (text.startsWith('SELECT version FROM deft_schema_migrations')) {
        return { rows: (Array.isArray(state.ledger) ? state.ledger : []).map((version) => ({ version })) };
      }
      const table = /to_regclass\('public\.(\w+)'\)/.exec(text)?.[1];
      if (table) return { rows: [{ present: (state.present ?? []).includes(table) }] };
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
const after117 = all.length - through117.length;
const pendingAfter117 = new RegExp(`${after117} upgrade\\(s\\) after 0\\.3\\.0-preview\\.117 were not applied \\(0\\.3\\.0-preview\\.118 to `);

test('an unrecognized catalog before any ledger: incomplete, the upgrades after 117 missing, versions shown, drop and rerun', async () => {
  const lines = await describeIncompleteFreshInit(
    fakeClient({ ledger: null, server: '16.15 (Ubuntu)', extensions: [['plpgsql', '1.0'], ['vector', '0.6.0']] }),
    new Error('E5_FRESH_PRESTAMP_CATALOG_UNRECOGNIZED'),
  );
  const text = lines.join('\n');
  assert.match(text, /INCOMPLETE/);
  assert.match(text, pendingAfter117);
  assert.match(text, /among them ics_publish_tokens, seat_statements, user_two_step, note_files\)/);
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
  assert.match(text, pendingAfter117);
  assert.doesNotMatch(text, /extensions:/, 'versions are shown only for an unrecognized catalog');
  assert.match(lines.at(-1)!, /pnpm db:upgrade may finish it/);
});

test('only the late tables that are really missing are named', async () => {
  const upTo144 = all.slice(0, all.indexOf('0.3.0-preview.144') + 1);
  const lines = await describeIncompleteFreshInit(
    fakeClient({ ledger: [upgradeManifest.baseline.version, ...upTo144], present: ['ics_publish_tokens', 'seat_statements'] }),
    new Error('migration 0.3.0-preview.148 failed'),
  );
  const text = lines.join('\n');
  assert.match(text, /among them user_two_step, note_files\)/);
  assert.doesNotMatch(text, /ics_publish_tokens|seat_statements/);
  const none = await describeIncompleteFreshInit(
    fakeClient({ ledger: [upgradeManifest.baseline.version, ...upTo144], present: ['ics_publish_tokens', 'seat_statements', 'user_two_step', 'note_files'] }),
    new Error('x'),
  );
  assert.doesNotMatch(none.join('\n'), /among them/);
});

test('a ledger that cannot be read is reported as unknown, never as a reason to drop the database', async () => {
  const lines = await describeIncompleteFreshInit(fakeClient({ ledger: 'error' }), new Error('connection lost'));
  const text = lines.join('\n');
  assert.match(text, /ledger could not be read/);
  assert.match(text, /pnpm db:upgrade --status/);
  assert.doesNotMatch(lines[0]!, /Drop this database/);
  assert.doesNotMatch(text, /were not applied/);
});

test('a stop before any table was created: the database is still empty, rerun', async () => {
  const lines = await describeIncompleteFreshInit(fakeClient({ tables: 0, ledger: null }), new Error('[ensure-pgvector] failed'));
  assert.deepEqual(lines.length, 1);
  assert.match(lines[0]!, /still empty/);
  assert.doesNotMatch(lines[0]!, /INCOMPLETE|Drop/);
});

test('a reporting failure never hides the original stop', async () => {
  const broken = { async query() { throw new Error('connection lost'); } };
  const lines = await describeIncompleteFreshInit(broken, new Error('E5_FRESH_PRESTAMP_CATALOG_UNRECOGNIZED'));
  assert.ok(lines.length > 0);
  assert.match(lines.join('\n'), /could not be read/);
});

test('a stop with every upgrade recorded says only the final step failed', async () => {
  const lines = await describeIncompleteFreshInit(
    fakeClient({ ledger: [upgradeManifest.baseline.version, ...all], present: ['ics_publish_tokens', 'seat_statements', 'user_two_step', 'note_files'] }),
    new Error('final check failed'),
  );
  assert.match(lines.join('\n'), /Every upgrade was applied, but the final step failed/);
});
