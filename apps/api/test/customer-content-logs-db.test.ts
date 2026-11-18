import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { format } from 'node:util';
import test from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';
import { closeDb } from '../src/lib/db.js';
import { requestLogger } from '../src/lib/request-logger.js';
import { contentFreeErrorHandler } from '../src/lib/content-free-error-handler.js';

test('native writes, agent replies and failed writes never log customer content', async t => {
  const url = safeTestDatabaseUrl();
  if (!url) return t.skip('Set DEFT_TEST_DATABASE_URL to a disposable test database');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const org = randomUUID(), user = randomUUID(), space = randomUUID(), project = randomUUID();
  const kinds = ['chat', 'title', 'description', 'note', 'canvas', 'filename', 'email', 'prompt', 'reply',
    'invite', 'recovery', 'api-key', 'failed-body', 'database-error'] as const;
  const markers = Object.fromEntries(kinds.map(kind => [kind, `PRIVATE-${randomUUID()}-${kind}`]));
  const output: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const originals = methods.map(method => console[method]);
  t.after(async () => {
    try {
      for (const table of ['job_queue', 'notifications', 'agent_actions', 'native_create_requests', 'task_activity',
        'tasks', 'notes', 'canvases', 'agent_employees', 'org_members']) {
        await client.query(`DELETE FROM ${table} WHERE org_id=$1`, [org]);
      }
      await client.query('DELETE FROM space_members WHERE space_id=$1', [space]);
      await client.query('DELETE FROM messages WHERE org_id=$1', [org]);
      await client.query('DELETE FROM spaces WHERE org_id=$1', [org]);
      await client.query('DELETE FROM projects WHERE org_id=$1', [org]);
      await client.query('DELETE FROM users WHERE id=$1', [user]);
      await client.query('DELETE FROM orgs WHERE id=$1', [org]);
    } finally { await client.end(); await closeDb(); }
  });
  const app = new Hono();
  app.onError(contentFreeErrorHandler);
  app.use('*', requestLogger);
  app.use('*', async (c, next) => {
    c.set('user', { id: user, org_id: org, role: 'owner', email: `${user}@example.test` } as any);
    await next();
  });
  const send = (path: string, body: unknown, method = 'POST') => app.request(path, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    await client.query('INSERT INTO orgs(id,name,slug) VALUES($1,$1,$1)', [org]);
    await client.query('INSERT INTO users(id,email,name) VALUES($1,$2,$1)', [user, `${user}@example.test`]);
    await client.query("INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,'owner')", [randomUUID(), org, user]);
    await client.query("INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,'public',$4)", [space, org, 'Log regression', user]);
    await client.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), space, user]);
    await client.query("INSERT INTO projects(id,org_id,name,prefix) VALUES($1,$2,'Log regression','LG')", [project, org]);
    app.route('/api/messages', (await import('../src/routes/messages.js')).messageRoutes);
    app.route('/api/tasks', (await import('../src/routes/tasks.js')).taskRoutes);
    app.route('/api/notes', (await import('../src/routes/daily-notes.js')).dailyNoteRoutes);
    app.route('/api/spaces', (await import('../src/routes/canvas.js')).canvasRoutes);
    app.post('/throw', async c => { throw new Error(JSON.stringify(await c.req.json())); });
    const { handleAgentReply } = await import('../src/workers/handlers/agent-reply.js');
    for (const method of methods) console[method] = (...args: unknown[]) => { output.push(format(...args)); };

    const messageResponse = await send(`/api/messages/${space}`, { content: markers.chat });
    assert.equal(messageResponse.status, 201, await messageResponse.clone().text());
    assert.ok((await messageResponse.text()).includes(markers.chat));
    const task = await send('/api/tasks', { project_id: project, title: markers.title, description: markers.description });
    assert.equal(task.status, 201, await task.clone().text());
    assert.ok((await task.text()).includes(markers.description));
    const note = await send('/api/notes', { title: markers.note, content: markers.note });
    assert.equal(note.status, 201, await note.clone().text());
    assert.ok((await note.text()).includes(markers.note));
    // GET creates the initial canvas; PATCH exercises the actual content write.
    assert.equal((await app.request(`/api/spaces/${space}/canvas`)).status, 201);
    const canvas = await send(`/api/spaces/${space}/canvas`, { content: markers.canvas, title: markers.canvas }, 'PATCH');
    assert.equal(canvas.status, 200);
    assert.ok((await canvas.text()).includes(markers.canvas));

    const mention = await send(`/api/messages/${space}`, { content: `@defty ${markers.prompt}` });
    assert.equal(mention.status, 201, await mention.clone().text());
    const trigger = await mention.json() as { id: string };
    let called = false;
    await handleAgentReply({ id: randomUUID(), data: { orgId: org, spaceId: space, messageId: trigger.id,
      userId: user, orgName: 'Log regression', content: markers.prompt } } as any, {
      // The LLM boundary is the only stub: execute the real worker, publication,
      // and logging with a marked reply and no network or provider credential.
      runQuery: async () => {
        called = true;
        return { text: markers.reply, model: 'agent-unconfigured', pendingActions: [], executedActions: [],
          assistantBlocks: [], citations: [], tokensIn: 0, tokensOut: 0,
          metrics: { total_ms: 0, retrieval_ms: 0, reasoning_ms: 0, iterations: 0 } };
      },
    });
    assert.ok(called, 'worker must reach the agent reply boundary');
    const replies = await client.query('SELECT content FROM messages WHERE org_id=$1 AND user_id<>$2', [org, user]);
    assert.ok(replies.rows.some(row => row.content.includes(markers.reply)), 'marked reply must be published');

    assert.equal((await send(`/api/messages/${space}`, { content: 123, invalid_body: markers['failed-body'] })).status, 400);
    // PostgreSQL rejects NUL in text. Drizzle wraps it with the SQL parameters,
    // so the existing route's catch would print the marker without the fix.
    assert.equal((await send(`/api/messages/${space}`, { content: `${markers['database-error']}\u0000` })).status, 500);
    assert.equal((await send('/throw', markers)).status, 500);
    assert.ok(output.some(line => line.includes('Failed to send message')), 'exercise the real route error log');
    assert.ok(output.some(line => line.includes('[agent-reply]')), 'exercise worker logs');
    for (const marker of Object.values(markers)) assert.ok(!output.join('\n').includes(marker), `Customer content logged: ${marker}`);
  } finally {
    methods.forEach((method, index) => { console[method] = originals[index]!; });
  }
});
