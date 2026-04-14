/**
 * Phase 5 — OpenClaw chat envelope adapter + client tests.
 *
 * Run: pnpm --filter @deft/api test -- openclaw-envelope
 *
 * Covers (9 tests):
 *   1. backfillMentions replaces @Firstname with <@uuid|Firstname>
 *   2. backfillMentions preserves @Firstname inside ```code blocks```
 *   3. backfillMentions preserves @Firstname inside `inline code`
 *   4. backfillMentions skips ambiguous names (two Priyas in the org)
 *   5. parseReplyIntoMessage parses a mock SSE stream with 3 deltas + DONE
 *   6. parseReplyIntoMessage writes is_agent_reply + openclaw_origin metadata
 *   7. buildChatCompletionRequest produces NO system-role messages (NC1)
 *   8. openclawClient.chatCompletion throws on non-2xx
 *   9. openclawClient.chatCompletion respects timeoutMs on a hanging server
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import pg from 'pg';

import {
  backfillMentions,
  buildChatCompletionRequest,
  parseReplyIntoMessage,
  parseSseBuffer,
  type OrgMember,
} from '../src/lib/openclaw-chat-envelope.js';
import { chatCompletion } from '../src/lib/openclaw-client.js';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6'; // seed org

const TEST_USER_ID = 'test-openclaw-envelope-user';
const TEST_EMPLOYEE_ID = 'test-openclaw-envelope-emp';
const TEST_EMPLOYEE_SLUG = 'openclaw-envelope-test';

let TEST_SPACE_ID: string | null = null;

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

before(async () => {
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (id) DO NOTHING`,
      [TEST_USER_ID, 'openclaw-envelope@test.local', 'OpenClaw Envelope Test'],
    );
    await c.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         kind, connection_url, connection_status, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5, 'project_manager', 'test', 'standard',
         'openclaw', $6, 'pending', true, $3)
       ON CONFLICT (id) DO UPDATE SET
         kind = 'openclaw',
         is_active = true`,
      [
        TEST_EMPLOYEE_ID,
        ORG_ID,
        TEST_USER_ID,
        'OpenClaw Envelope Test Emp',
        TEST_EMPLOYEE_SLUG,
        'http://127.0.0.1:19995/envelope-test',
      ],
    );

    // Grab a space to insert test messages into
    const sp = await c.query(
      `SELECT id FROM spaces WHERE org_id = $1 AND is_archived = false
       ORDER BY created_at ASC LIMIT 1`,
      [ORG_ID],
    );
    if (sp.rows.length > 0) {
      TEST_SPACE_ID = sp.rows[0].id;
    } else {
      const r = await c.query(
        `INSERT INTO spaces (org_id, name, type, created_by)
         VALUES ($1, 'openclaw-envelope-test-space', 'public', $2)
         RETURNING id`,
        [ORG_ID, TEST_USER_ID],
      );
      TEST_SPACE_ID = r.rows[0].id;
    }
  });
});

after(async () => {
  await withClient(async (c) => {
    // Phase 7 — receipts FK to agent_actions + agent_employees; clear first.
    await c.query(
      `DELETE FROM action_receipts
       WHERE employee_id = $1
          OR action_id IN (SELECT id FROM agent_actions WHERE user_id = $2)`,
      [TEST_EMPLOYEE_ID, TEST_USER_ID],
    );
    await c.query(
      `DELETE FROM agent_actions WHERE user_id = $1`,
      [TEST_USER_ID],
    );
    await c.query(`DELETE FROM messages WHERE user_id = $1`, [TEST_USER_ID]);
    await c.query(`DELETE FROM agent_employees WHERE id = $1`, [TEST_EMPLOYEE_ID]);
    await c.query(`DELETE FROM users WHERE id = $1`, [TEST_USER_ID]);
  });
});

// ─── helpers ────────────────────────────────────────────────────────────

const SAMPLE_MEMBERS: OrgMember[] = [
  { id: 'uuid-priya', name: 'Priya Singh' },
  { id: 'uuid-alex', name: 'Alex Chen' },
  { id: 'uuid-bob', name: 'Bob Rivera' },
];

function nodeStreamFromString(s: string): NodeJS.ReadableStream {
  return Readable.from([Buffer.from(s, 'utf8')]);
}

function makeSseBuffer(parts: Array<string | 'DONE'>): string {
  // Standard OpenAI SSE: `data: <json>\n\n` then `data: [DONE]\n\n`
  const lines: string[] = [];
  for (const p of parts) {
    if (p === 'DONE') {
      lines.push('data: [DONE]\n');
    } else {
      lines.push(`data: ${p}\n`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ─── 1. backfillMentions: basic rewrite ─────────────────────────────────

test('1. backfillMentions replaces @Priya with <@uuid|Priya>', () => {
  const out = backfillMentions('hi @Priya can you take a look', SAMPLE_MEMBERS);
  assert.equal(out, 'hi <@uuid-priya|Priya> can you take a look');
});

// ─── 2. fenced code blocks are preserved ────────────────────────────────

test('2. backfillMentions preserves @Priya inside ```code blocks```', () => {
  const input = 'see below\n```\nlet msg = "@Priya";\n```\nand thanks @Priya';
  const out = backfillMentions(input, SAMPLE_MEMBERS);
  assert.match(out, /```\nlet msg = "@Priya";\n```/);
  assert.ok(out.endsWith('thanks <@uuid-priya|Priya>'));
});

// ─── 3. inline code is preserved ────────────────────────────────────────

test('3. backfillMentions preserves @Priya inside `inline code`', () => {
  const input = 'run `git blame @Priya` then ping @Priya';
  const out = backfillMentions(input, SAMPLE_MEMBERS);
  assert.match(out, /`git blame @Priya`/);
  assert.ok(out.endsWith('then ping <@uuid-priya|Priya>'));
});

// ─── 4. ambiguous names are left as plain text ──────────────────────────

test('4. backfillMentions skips ambiguous names', () => {
  const ambiguous: OrgMember[] = [
    { id: 'uuid-priya-1', name: 'Priya Singh' },
    { id: 'uuid-priya-2', name: 'Priya Rao' },
    { id: 'uuid-alex', name: 'Alex Chen' },
  ];
  const out = backfillMentions('hi @Priya and @Alex', ambiguous);
  // Priya should stay plain (ambiguous), Alex should be rewritten.
  assert.match(out, /hi @Priya and <@uuid-alex\|Alex>/);
});

// ─── 5. parseReplyIntoMessage parses a mock SSE stream ──────────────────

test('5. parseReplyIntoMessage parses a 3-delta + DONE stream', async () => {
  const sse = makeSseBuffer([
    JSON.stringify({
      choices: [{ delta: { role: 'assistant', content: 'BSL ' } }],
      model: 'anthropic/claude-opus-4-6',
    }),
    JSON.stringify({
      choices: [{ delta: { content: '1.1 is a license' } }],
    }),
    JSON.stringify({
      choices: [{ delta: { content: '.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 40 },
    }),
    'DONE',
  ]);
  const { text, model, tokens_in, tokens_out } = parseSseBuffer(sse);
  assert.equal(text, 'BSL 1.1 is a license.');
  assert.equal(model, 'anthropic/claude-opus-4-6');
  assert.equal(tokens_in, 120);
  assert.equal(tokens_out, 40);

  const { message, turn } = await parseReplyIntoMessage({
    sseStream: nodeStreamFromString(sse),
    employee: {
      id: TEST_EMPLOYEE_ID,
      org_id: ORG_ID,
      slug: TEST_EMPLOYEE_SLUG,
      user_id: TEST_USER_ID,
      trust_level: 'standard',
    },
    context: {
      space_id: TEST_SPACE_ID!,
      parent_id: null,
      org_id: ORG_ID,
      trigger_kind: 'chat_mention',
      input_messages: [{ role: 'user', content: 'what is BSL 1.1?' }],
    },
    orgMembers: [],
  });
  assert.ok(message.id, 'parseReplyIntoMessage should insert a message row');
  assert.equal(message.content, 'BSL 1.1 is a license.');
  assert.equal(turn.result, 'success');
  assert.equal(turn.tokens_in, 120);
  assert.equal(turn.tokens_out, 40);
  assert.equal(turn.model_name, 'anthropic/claude-opus-4-6');
  assert.ok(turn.latency_ms >= 0);
});

// ─── 6. openclaw_origin metadata lands on the inserted row ──────────────

test('6. parseReplyIntoMessage sets is_agent_reply + openclaw_origin metadata', async () => {
  const sse = makeSseBuffer([
    JSON.stringify({
      choices: [{ delta: { content: 'hello world' } }],
      model: 'anthropic/claude-opus-4-6',
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }),
    'DONE',
  ]);
  const { message } = await parseReplyIntoMessage({
    sseStream: nodeStreamFromString(sse),
    employee: {
      id: TEST_EMPLOYEE_ID,
      org_id: ORG_ID,
      slug: TEST_EMPLOYEE_SLUG,
      user_id: TEST_USER_ID,
      trust_level: 'standard',
    },
    context: {
      space_id: TEST_SPACE_ID!,
      parent_id: null,
      org_id: ORG_ID,
    },
    orgMembers: [],
  });
  const meta = message.metadata as Record<string, unknown> | null;
  assert.ok(meta, 'metadata should be populated');
  assert.equal(meta!.is_agent_reply, true);
  const origin = meta!.openclaw_origin as Record<string, unknown>;
  assert.equal(origin.slug, TEST_EMPLOYEE_SLUG);
  assert.equal(origin.employee_id, TEST_EMPLOYEE_ID);
  assert.equal(origin.model_name, 'anthropic/claude-opus-4-6');
  assert.equal(origin.tokens_in, 10);
  assert.equal(origin.tokens_out, 2);
});

// ─── 7. buildChatCompletionRequest has no system-role messages ──────────

test('7. buildChatCompletionRequest produces no system-role messages (NC1)', async () => {
  const req = await buildChatCompletionRequest({
    employee: {
      id: TEST_EMPLOYEE_ID,
      org_id: ORG_ID,
      slug: TEST_EMPLOYEE_SLUG,
      user_id: TEST_USER_ID,
      trust_level: 'standard',
    },
    threadContext: {
      parentMessage: {
        user_id: 'some-user',
        user_name: 'Maneek',
        content: 'draft the roadmap please',
      },
      replies: [],
    },
    triggerMessage: {
      user_id: 'some-user',
      user_name: 'Maneek',
      content: '@Test how does BSL 1.1 work?',
    },
  });
  assert.equal(req.model, `openclaw/${TEST_EMPLOYEE_SLUG}`);
  assert.equal(req.stream, true);
  for (const m of req.messages) {
    assert.notEqual(m.role, 'system', 'NC1: no system messages in request body');
  }
  assert.ok(req.messages.length >= 1);
});

// ─── 8. openclawClient throws on non-2xx ────────────────────────────────

test('8. openclawClient.chatCompletion throws on non-2xx', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'gateway down' }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  try {
    await assert.rejects(
      () =>
        chatCompletion({
          connection_url: `http://127.0.0.1:${port}`,
          gateway_token: 'tok',
          request: {
            model: 'openclaw/test',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
          },
          timeoutMs: 5_000,
        }),
      /503|gateway down/i,
    );
  } finally {
    server.close();
  }
});

// ─── 9. openclawClient respects timeoutMs ────────────────────────────────

test('9. openclawClient.chatCompletion respects timeoutMs', async () => {
  // Server that never responds. Node will hold the socket open until we close it.
  const server = http.createServer((_req, _res) => {
    /* intentional hang */
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const start = Date.now();
  try {
    await assert.rejects(
      () =>
        chatCompletion({
          connection_url: `http://127.0.0.1:${port}`,
          gateway_token: 'tok',
          request: {
            model: 'openclaw/test',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
          },
          timeoutMs: 300,
        }),
      /timeout/i,
    );
  } finally {
    server.close();
    // Force-destroy any hanging sockets so the test process can exit.
    server.closeAllConnections?.();
  }
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2_000, `expected fast timeout, got ${elapsed}ms`);
});
