/**
 * Block 3.4 — deft-mcp-client bundled skill.
 *
 * Run: pnpm --filter @deft/api exec tsx --env-file=../../.env --test test/deft-mcp-client-skill.test.ts
 *
 * Verifies the BUNDLED_SKILLS catalog contains the skill with the
 * required MCP config shape, and that the row was seeded into the
 * skills table.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq, and, isNull } from 'drizzle-orm';
import { db, skills } from '@deft/db';
import { BUNDLED_SKILLS } from '../src/lib/bundled-skills.js';

test('BUNDLED_SKILLS contains deft-mcp-client with correct shape', () => {
  const entry = BUNDLED_SKILLS.find((s) => s.slug === 'deft-mcp-client');
  assert.ok(entry, 'deft-mcp-client present in BUNDLED_SKILLS');
  assert.equal(entry!.name, 'Deft MCP client');
  assert.equal(entry!.version, '1.0.0');

  const cfg = entry!.agent_config;
  assert.deepEqual(cfg.requires_env, ['DEFT_API_URL', 'DEFT_MCP_TOKEN']);
  assert.ok(cfg.mcp_servers && cfg.mcp_servers.length === 1);
  const server = cfg.mcp_servers![0]!;
  assert.equal(server.name, 'deft');
  assert.equal(server.transport, 'streamable-http');
  assert.match(server.url ?? '', /\$\{DEFT_API_URL\}/);
  assert.match(server.headers?.Authorization ?? '', /\$\{DEFT_MCP_TOKEN\}/);
  assert.ok(cfg.system_prompt_addition && cfg.system_prompt_addition.length > 0);
});

test('seed-bundled-skills inserted the row (bundled, org_id NULL)', async () => {
  const rows = await db
    .select()
    .from(skills)
    .where(and(eq(skills.slug, 'deft-mcp-client'), eq(skills.source, 'bundled'), isNull(skills.org_id)));
  assert.ok(rows.length >= 1, `expected at least 1 bundled row, got ${rows.length}`);
  const row = rows[0]!;
  assert.equal(row.is_deleted, false);
  assert.equal(row.version, '1.0.0');
  const ac = row.agent_config as any;
  assert.deepEqual(ac.requires_env, ['DEFT_API_URL', 'DEFT_MCP_TOKEN']);
});
