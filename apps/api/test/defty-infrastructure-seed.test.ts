import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  events, labels, messageBookmarks, messages, notes, pinnedMessages,
  projects, reactions, spaceMembers, spaces, taskActivity, taskLabels,
  tasks, wikiLinks, wikiPages,
} from '@deft/db/schema';

const orgId = 'seed-org';
const adminId = 'seed-admin';
const tables = new Map([
  events, labels, messageBookmarks, messages, notes, pinnedMessages,
  projects, reactions, spaceMembers, spaces, taskActivity, taskLabels,
  tasks, wikiLinks, wikiPages,
].map((table) => {
  const config = getTableConfig(table);
  return [config.name, config] as const;
}));

const source = readFileSync(new URL('../src/scripts/seed-test-org-rich.ts', import.meta.url), 'utf8');
const program = ts.createSourceFile('seed-test-org-rich.ts', source, ts.ScriptTarget.ES2022, true);
const cliInvocation = program.statements.at(-1)!;
// Invoke the real main directly so the test can await its transaction and cleanup.
const compiled = ts.transpileModule(
  `${source.slice(0, cliInvocation.getFullStart())}\nexport { main as runSeed };`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } },
).outputText;

async function runSeed(adminEmail?: string) {
  const schemaErrors: string[] = [];
  const adminLookups: unknown[] = [];
  const bookmarks: string[] = [];
  const sqlDb = new DatabaseSync(':memory:');
  sqlDb.exec(`
    CREATE TABLE spaces (id TEXT PRIMARY KEY, org_id TEXT, name TEXT, type TEXT, is_archived BOOLEAN DEFAULT false);
    CREATE TABLE space_members (space_id TEXT, user_id TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, org_id TEXT, space_id TEXT, content TEXT, is_deleted BOOLEAN DEFAULT false);
    INSERT INTO spaces (id, org_id, type) VALUES
      ('foreign-public', 'foreign-org', 'public'), ('local-public', 'seed-org', 'public'),
      ('local-private', 'seed-org', 'private'), ('local-dm', 'seed-org', 'dm'),
      ('member-private', 'seed-org', 'private');
    INSERT INTO space_members VALUES ('member-private', 'seed-admin');
    INSERT INTO messages VALUES
      ('foreign-party', 'foreign-org', 'foreign-public', '🎉', false),
      ('foreign-gap', 'foreign-org', 'foreign-public', 'gap-fixes', false),
      ('deleted-party', 'seed-org', 'local-public', '🎉', true),
      ('private-pin', 'seed-org', 'local-private', 'pin this', false),
      ('private-dm', 'seed-org', 'local-dm', 'gap-fixes', false),
      ('public-pin', 'seed-org', 'local-public', 'pin this', false),
      ('member-gap', 'seed-org', 'member-private', 'gap-fixes', false);
  `);

  const client = {
    async query(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      const result = (rows: Record<string, unknown>[] = []) => ({ rows, rowCount: rows.length });
      if (normalized.startsWith('select u.id as user_id')) {
        adminLookups.push(values[0]);
        return result([{ user_id: adminId, org_id: orgId }]);
      }
      if (normalized.startsWith('select u.id, u.name, u.email')) {
        return result(['Maneek', 'Rahul Mehta', 'Priya Shah', 'Sara Kim', 'Arjun Rao', 'Vishesh'].map((name, i) => ({
          id: i === 0 ? adminId : `seed-user-${i}`, name, email: `${i}@deft.test`,
        })));
      }
      if (normalized.startsWith('select id, name, type from spaces')) {
        return result(['general', 'engineering', 'design', 'random', 'launch'].map((name) => ({
          id: `space-${name}`, name, type: 'public',
        })));
      }
      if (/^select m\.id, m\.space_id from messages m/i.test(normalized)) {
        const bindings = Object.fromEntries(values.map((value, i) => [`$${i + 1}`, value]));
        return result(sqlDb.prepare(sql).all(bindings as Record<string, string>) as Record<string, unknown>[]);
      }
      const insertion = /insert into (\w+)\s*\(([^)]+)\)\s*values\s*\(([^)]+)\)/i.exec(sql);
      if (insertion) {
        const [, tableName, columnText, valueText] = insertion;
        assert.ok(tableName && columnText && valueText, 'INSERT includes a table, columns, and values');
        const columns = columnText.split(',').map((column) => column.trim());
        const expressions = valueText.split(',').map((expression) => expression.trim());
        const table = tables.get(tableName);
        assert.ok(table, `Unexpected seed table ${tableName}`);
        for (const column of columns) {
          assert.ok(table.columns.some((candidate) => candidate.name === column), `${tableName}.${column} exists in the current schema`);
        }
        for (const column of table.columns) {
          if (column.notNull && !column.hasDefault && !columns.includes(column.name)) {
            schemaErrors.push(`${tableName}.${column.name} is required`);
          }
        }
        const insertedValue = (column: string) => {
          const expression = expressions[columns.indexOf(column)];
          const parameter = /^\$(\d+)$/.exec(expression ?? '');
          return parameter ? values[Number(parameter[1]) - 1] : expression;
        };
        if (columns.includes('org_id') && insertedValue('org_id') !== orgId) {
          schemaErrors.push(`${tableName}.org_id must equal the selected seed organization`);
        }
        if (tableName === 'message_bookmarks') bookmarks.push(String(insertedValue('message_id')));
      }
      return result();
    },
    release() {},
  };
  const exports: { runSeed?: () => Promise<void> } = {};
  runInNewContext(compiled, {
    exports,
    require(name: string) {
      if (name === 'dotenv/config') return {};
      if (name === 'node:crypto') return { randomUUID };
      if (name === 'pg') return { Pool: class { async connect() { return client; } async end() {} } };
      throw new Error(`Unexpected seed dependency ${name}`);
    },
    process: { env: adminEmail ? { ADMIN_EMAIL: adminEmail } : {} },
    console: { log() {}, warn() {}, error() {} },
  });
  try {
    await exports.runSeed!();
    return { schemaErrors, adminLookups, bookmarks };
  } finally {
    sqlDb.close();
  }
}

test('rich seed supplies current required columns and the selected tenant on every insert', async () => {
  const result = await runSeed('admin@deft.test');
  assert.deepEqual(result.schemaErrors, []);
});

test('rich seed uses the same default administrator as seed-test-org', async () => {
  const result = await runSeed();
  assert.deepEqual(result.adminLookups, ['admin@deft.test']);
});

test('rich seed bookmarks only live messages in spaces the administrator can read', async () => {
  const result = await runSeed('admin@deft.test');
  assert.deepEqual(result.bookmarks.sort(), ['member-gap', 'public-pin']);
});
