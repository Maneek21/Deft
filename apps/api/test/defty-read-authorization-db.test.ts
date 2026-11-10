/**
 * W1-b Defty read authorization. Defty answers with the visibility of the
 * user who asked, in the org they asked from. Every test plants a canary in a
 * resource the asker must not see and asserts it never reaches the result (or
 * the provider request).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import {
  agentMemory, canvases, mcpConnections, mcpToolOverrides, notes, orgMembers, orgs, spaceMembers, spaces, users, wikiPages,
} from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import { env } from '../src/lib/env.js';
import { executeToolCall } from '../src/lib/agent-context.js';
import { retrieveContext } from '../src/lib/retrieve-context.js';
import { runAgentQuery } from '../src/lib/agent-runner.js';
import { AGENT_TOOLS, ACTION_TOOLS } from '../src/lib/agent-tools.js';
import { capabilityService } from '../src/lib/capability-service.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const canRun = Boolean(safeTestDatabaseUrl());
const run = randomUUID().replace(/-/g, '').slice(0, 10);
const orgA = randomUUID(), orgB = randomUUID();
const alice = randomUUID(), bob = randomUUID();
const privateSpace = randomUUID(), publicSpace = randomUUID(), dmSpace = randomUUID(), orgBSpace = randomUUID();
const privateSpaceName = `w1b-private-${run}`;
const wikiCanary = `zqwikicanary${run}`;
const decisionCanary = `zqdecisioncanary${run}`;
const canvasCanary = `zqcanvascanary${run}`;
const noteCanary = `zqnotecanary${run}`;
const spaceNoteCanary = `zqspacenotecanary${run}`;
const privateNoteId = randomUUID(), spaceNoteId = randomUUID();
const mcpConnectionId = randomUUID();
const mcpSlug = `w1b-mcp-${run}`;

function text(value: unknown): string {
  return JSON.stringify(value) ?? '';
}

describe('W1-b Defty read authorization', { skip: !canRun }, () => {
  before(async () => {
    await db.insert(orgs).values([
      { id: orgA, name: 'W1b Org A', slug: `w1b-a-${run}` },
      { id: orgB, name: 'W1b Org B', slug: `w1b-b-${run}` },
    ]);
    await db.insert(users).values([
      { id: alice, name: 'Alice W1b', email: `alice-${run}@w1b.test` },
      { id: bob, name: 'Bob W1b', email: `bob-${run}@w1b.test` },
    ]);
    // Alice belongs to both orgs; Bob only to org A.
    await db.insert(orgMembers).values([
      { org_id: orgA, user_id: alice, role: 'member' },
      { org_id: orgB, user_id: alice, role: 'member' },
      { org_id: orgA, user_id: bob, role: 'member' },
    ]);
    await db.insert(spaces).values([
      { id: privateSpace, org_id: orgA, name: privateSpaceName, type: 'private', created_by: alice },
      { id: publicSpace, org_id: orgA, name: `w1b-public-${run}`, type: 'public', created_by: alice },
      { id: dmSpace, org_id: orgA, name: `w1b-dm-${run}`, type: 'dm', created_by: alice },
      { id: orgBSpace, org_id: orgB, name: `w1b-orgb-${run}`, type: 'public', created_by: alice },
    ]);
    await db.insert(spaceMembers).values([
      { space_id: privateSpace, user_id: alice },
      { space_id: publicSpace, user_id: alice },
      { space_id: publicSpace, user_id: bob },
      { space_id: dmSpace, user_id: alice },
      { space_id: orgBSpace, user_id: alice },
    ]);
    await db.insert(wikiPages).values([
      { org_id: orgA, scope: 'space', space_id: privateSpace, type: 'concept', title: `Private plan ${run}`,
        slug: `w1b-private-plan-${run}`, content: `The private launch codename is ${wikiCanary}.`, user_id: alice },
      { org_id: orgA, scope: 'space', space_id: privateSpace, type: 'decision', title: `Private decision ${run}`,
        slug: `w1b-private-decision-${run}`, content: `We decided ${decisionCanary}.`, user_id: alice },
    ]);
    await db.insert(canvases).values({ org_id: orgA, space_id: privateSpace, title: 'Private canvas',
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: canvasCanary }] }] } });
    await db.insert(notes).values([
      { id: privateNoteId, org_id: orgA, user_id: alice, title: `Alice private ${run}`, content: noteCanary, visibility: 'private' },
      { id: spaceNoteId, org_id: orgA, user_id: alice, title: `Alice space note ${run}`, content: spaceNoteCanary,
        visibility: 'space', visibility_space_id: privateSpace },
    ]);
  });

  after(async () => {
    await db.delete(agentMemory).where(inArray(agentMemory.org_id, [orgA, orgB]));
    await db.delete(notes).where(inArray(notes.org_id, [orgA, orgB]));
    await db.delete(canvases).where(inArray(canvases.org_id, [orgA, orgB]));
    await db.delete(wikiPages).where(inArray(wikiPages.org_id, [orgA, orgB]));
    await db.delete(mcpToolOverrides).where(eq(mcpToolOverrides.mcp_connection_id, mcpConnectionId));
    await db.delete(mcpConnections).where(eq(mcpConnections.id, mcpConnectionId));
    await db.delete(spaceMembers).where(inArray(spaceMembers.space_id, [privateSpace, publicSpace, dmSpace, orgBSpace]));
    await db.delete(spaces).where(inArray(spaces.org_id, [orgA, orgB]));
    await db.delete(orgMembers).where(inArray(orgMembers.org_id, [orgA, orgB]));
    await db.delete(orgs).where(inArray(orgs.id, [orgA, orgB]));
    await db.delete(users).where(inArray(users.id, [alice, bob]));
    await closeDb();
  });

  async function providerRequestFor(t: any, userId: string, content: string): Promise<string> {
    const providerKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_URL'] as const;
    const savedEnv = Object.fromEntries(providerKeys.map(key => [key, env[key]]));
    const savedProcess = Object.fromEntries(providerKeys.map(key => [key, process.env[key]]));
    const configured = { ANTHROPIC_API_KEY: '', OPENAI_API_KEY: 'test', OPENROUTER_API_KEY: '', OLLAMA_URL: '' };
    Object.assign(env, configured); Object.assign(process.env, configured);
    const bodies: string[] = [];
    const fetchMock = t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
      if (String(url).includes('/embeddings')) return Response.json({ data: [{ embedding: Array(1536).fill(0) }] });
      bodies.push(typeof init?.body === 'string' ? init.body : '');
      return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 1, output_tokens: 1 } });
    });
    try {
      await runAgentQuery({ content, orgId: orgA, userId, orgName: 'W1b Org A', conversationId: publicSpace,
        spaceContext: { type: 'public', name: 'w1b-public' }, maxIterations: 1, skipVerification: true });
    } finally {
      fetchMock.mock.restore();
      Object.assign(env, savedEnv);
      for (const key of providerKeys) {
        if (savedProcess[key] === undefined) delete process.env[key];
        else process.env[key] = savedProcess[key];
      }
    }
    assert.ok(bodies.length > 0, 'provider was called');
    return bodies.join('\n');
  }

  test('A03/B01: runner fresh exact-match context excludes a private-space wiki page for a non-member', async (t) => {
    const asBob = await providerRequestFor(t, bob, `What is ${wikiCanary}?`);
    assert.ok(!asBob.includes(`codename is ${wikiCanary}`), 'private wiki content must not reach the provider for Bob');
    const asAlice = await providerRequestFor(t, alice, `What is ${wikiCanary}?`);
    assert.ok(asAlice.includes(`codename is ${wikiCanary}`), 'member still sees the page');
  });

  test('B01: search_decisions with no query does not list private-space decisions to a non-member', async () => {
    const asBob = await executeToolCall('search_decisions', {}, orgA, bob);
    assert.ok(!text(asBob.result).includes(decisionCanary));
    const asAlice = await executeToolCall('search_decisions', {}, orgA, alice);
    assert.ok(text(asAlice.result).includes(decisionCanary));
  });

  test('B01: search_decisions does not broaden or resolve an unreadable space_name', async () => {
    const unknown = await executeToolCall('search_decisions', { space_name: `nonexistent-${run}` }, orgA, bob);
    assert.ok(!text(unknown.result).includes(decisionCanary));
    assert.equal((unknown.result as any).code, 'SPACE_NOT_FOUND');
    const hidden = await executeToolCall('search_decisions', { space_name: privateSpaceName }, orgA, bob);
    assert.ok(!text(hidden.result).includes(decisionCanary));
    assert.equal((hidden.result as any).code, 'SPACE_NOT_FOUND');
  });

  test('A06: memory recall does not cross orgs', async () => {
    const canary = `zqmemorycanary${run}`;
    const stored = await executeToolCall('remember', { key: `tz-${run}`, value: canary, scope: 'user' }, orgA, alice);
    assert.equal((stored.result as any).stored, true);
    for (const params of [{}, { scope: 'user' }, { key: `tz-${run}` }]) {
      const inB = await executeToolCall('recall', params, orgB, alice);
      assert.ok(!text(inB.result).includes(canary), `recall ${JSON.stringify(params)} in org B leaked org A memory`);
      const inBWithConversation = await executeToolCall('recall', params, orgB, alice, orgBSpace);
      assert.ok(!text(inBWithConversation.result).includes(canary));
    }
    const inA = await executeToolCall('recall', {}, orgA, alice);
    assert.ok(text(inA.result).includes(canary));
    const viaRetrieval = await retrieveContext({ query: canary, org_id: orgB, user_id: alice, types: ['memory'] });
    assert.ok(!text(viaRetrieval).includes(canary));
  });

  test('B07: conversation-scoped memory requires a conversation and stays in it', async () => {
    const canary = `zqconvcanary${run}`;
    const noConvRemember = await executeToolCall('remember', { key: `c-${run}`, value: canary, scope: 'conversation' }, orgA, alice);
    assert.equal((noConvRemember.result as any).code, 'CONVERSATION_REQUIRED');
    const noConvRecall = await executeToolCall('recall', { scope: 'conversation' }, orgA, alice);
    assert.equal((noConvRecall.result as any).code, 'CONVERSATION_REQUIRED');

    await executeToolCall('remember', { key: `c-${run}`, value: canary, scope: 'conversation' }, orgA, alice, dmSpace);
    const inOther = await executeToolCall('recall', { scope: 'conversation' }, orgA, alice, publicSpace);
    assert.ok(!text(inOther.result).includes(canary));
    const inSame = await executeToolCall('recall', { scope: 'conversation' }, orgA, alice, dmSpace);
    assert.ok(text(inSame.result).includes(canary));
    const fromOrgB = await executeToolCall('recall', { scope: 'conversation' }, orgB, alice, dmSpace);
    assert.ok(!text(fromOrgB.result).includes(canary), 'conversation memory must not cross orgs');

    // Another member of a shared conversation never gets the asker's conversation memory.
    const shared = `zqsharedconv${run}`;
    await executeToolCall('remember', { key: `s-${run}`, value: shared, scope: 'conversation' }, orgA, alice, publicSpace);
    const bobRecall = await executeToolCall('recall', {}, orgA, bob, publicSpace);
    assert.ok(!text(bobRecall.result).includes(shared));
    const bobRetrieval = await retrieveContext({ query: shared, org_id: orgA, user_id: bob, conversation_id: publicSpace, types: ['memory'] });
    assert.ok(!text(bobRetrieval).includes(shared), 'retrieval must not inject another user\'s conversation memory');
  });

  test('B06: read_canvas is dispatched and scoped to space membership', async () => {
    const asAlice = await executeToolCall('read_canvas', { space_name: privateSpaceName }, orgA, alice);
    assert.doesNotMatch(text(asAlice.result), /Unknown tool/);
    assert.ok(text(asAlice.result).includes(canvasCanary));
    const asBob = await executeToolCall('read_canvas', { space_name: privateSpaceName }, orgA, bob);
    assert.doesNotMatch(text(asBob.result), /Unknown tool/);
    assert.ok(!text(asBob.result).includes(canvasCanary));
    assert.equal((asBob.result as any).code, 'SPACE_NOT_FOUND');
    const crossOrg = await executeToolCall('read_canvas', { space_name: privateSpaceName }, orgB, alice);
    assert.ok(!text(crossOrg.result).includes(canvasCanary));
  });

  test('B06: search_notes is dispatched and scoped to note visibility', async () => {
    const asAlice = await executeToolCall('search_notes', { query: run }, orgA, alice);
    assert.doesNotMatch(text(asAlice.result), /Unknown tool/);
    assert.ok(text(asAlice.result).includes(privateNoteId));
    assert.ok(text(asAlice.result).includes(spaceNoteId));
    const asBob = await executeToolCall('search_notes', { query: run }, orgA, bob);
    assert.doesNotMatch(text(asBob.result), /Unknown tool/);
    assert.ok(!text(asBob.result).includes(noteCanary));
    assert.ok(!text(asBob.result).includes(spaceNoteCanary));
    assert.ok(!text(asBob.result).includes(privateNoteId));
    const crossOrg = await executeToolCall('search_notes', { query: run }, orgB, alice);
    assert.ok(!text(crossOrg.result).includes(privateNoteId));
  });

  test('B06: read_note is dispatched and scoped', async () => {
    const asAlice = await executeToolCall('read_note', { note_id: privateNoteId }, orgA, alice);
    assert.doesNotMatch(text(asAlice.result), /Unknown tool/);
    assert.ok(text(asAlice.result).includes(noteCanary));
    for (const noteId of [privateNoteId, spaceNoteId]) {
      const asBob = await executeToolCall('read_note', { note_id: noteId }, orgA, bob);
      assert.doesNotMatch(text(asBob.result), /Unknown tool/);
      assert.ok(!text(asBob.result).includes(noteCanary));
      assert.ok(!text(asBob.result).includes(spaceNoteCanary));
    }
    const crossOrg = await executeToolCall('read_note', { note_id: privateNoteId }, orgB, alice);
    assert.ok(!text(crossOrg.result).includes(noteCanary));
  });

  test('B06/C12: every advertised read tool reaches a handler', async () => {
    // Side-effecting or externally-dispatched names are excluded; they are
    // covered by their own suites.
    const skip = new Set(['remember', 'create_plan', 'wiki_write', 'wiki_suggest_update', 'add_knowledge']);
    const reads = AGENT_TOOLS.map(tool => tool.name).filter(name => !ACTION_TOOLS.has(name) && !skip.has(name));
    const unknown: string[] = [];
    for (const name of reads) {
      try {
        const { result } = await executeToolCall(name, {}, orgA, bob);
        if (/^Unknown tool/.test(String((result as any)?.error ?? ''))) unknown.push(name);
      } catch {
        // A handler that rejects empty input still dispatched.
      }
    }
    assert.deepEqual(unknown, []);
  });

  test('C04: an MCP tool whose live tier is no longer auto is not invoked as a read', async (t) => {
    await db.insert(mcpConnections).values({ id: mcpConnectionId, org_id: orgA, name: 'W1b MCP', slug: mcpSlug,
      server_url: 'https://w1b.example.test/mcp', transport: 'streamable-http', auth_type: 'none', is_active: true,
      default_trust_tier: 'auto', created_by: alice });
    const toolName = `mcp__${mcpSlug}__read_status`;
    let liveTier: 'auto-execute' | 'full-review' = 'auto-execute';
    t.mock.method(capabilityService, 'discover', async () => ({ tools: [{
      name: toolName, originalName: 'read_status', description: 'Read status',
      inputSchema: { type: 'object', properties: {} }, connectionId: mcpConnectionId, connectionSlug: mcpSlug,
      isWrite: false, approvalTier: liveTier, annotations: { readOnlyHint: true },
      rawTool: { name: 'read_status', description: 'Read status', inputSchema: { type: 'object', properties: {} } },
    }] }) as any);
    const invoke = t.mock.method(capabilityService, 'invoke', async () => ({
      legacy_output: { ok: true }, provider: { resolved_provider: null }, provider_display_name: undefined,
    }) as any);

    // Re-tiered to full-review after discovery: must not reach the provider.
    liveTier = 'full-review';
    const blocked = await executeToolCall(toolName, {}, orgA, alice);
    assert.equal(invoke.mock.callCount(), 0, 'provider must not be invoked for a re-tiered MCP tool');
    assert.equal((blocked.result as any).code, 'MCP_TOOL_REQUIRES_APPROVAL');

    // Still a live auto read: invoked once.
    liveTier = 'auto-execute';
    await executeToolCall(toolName, {}, orgA, alice);
    assert.equal(invoke.mock.callCount(), 1);

    // Re-tiered by a per-tool override rather than the discovered tier.
    await db.insert(mcpToolOverrides).values({ org_id: orgA, mcp_connection_id: mcpConnectionId,
      tool_name: 'read_status', trust_tier_override: 'quick' });
    const overridden = await executeToolCall(toolName, {}, orgA, alice);
    assert.equal(invoke.mock.callCount(), 1);
    assert.equal((overridden.result as any).code, 'MCP_TOOL_REQUIRES_APPROVAL');
  });
});
