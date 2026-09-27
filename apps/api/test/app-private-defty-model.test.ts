import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { privateDeftyModelTurn } from '../src/lib/app-private-defty-turn.js';

async function endpoint(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Synthetic provider unavailable');
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  }) };
}
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const params = (baseUrl: string) => ({
  resolved: { provider: 'openai' as const, model: 'test-model', apiKey: 'synthetic-only', baseUrl },
  selected: { subject: 'selected-context-sentinel' }, history: [], prompt: 'Summarize this record',
});

test('private Defty actual model HTTP uses exact endpoint and has no tools', async t => {
  let requests = 0;
  const server = await endpoint(async (req, res) => {
    requests++;
    assert.equal(req.url, '/v1/chat/completions');
    const captured = await body(req);
    assert.equal(captured.tools, undefined);
    assert.equal(JSON.stringify(captured).includes('selected-context-sentinel'), true);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Bounded private answer' } }] }));
  });
  t.after(server.close);
  assert.equal(await privateDeftyModelTurn(params(`${server.url}/v1`)), 'Bounded private answer');
  assert.equal(requests, 1);
});

test('private Defty streamed overflow and non-2xx response reject wholly without provider text', async t => {
  let requests = 0;
  const server = await endpoint(async (req, res) => {
    requests++; await body(req);
    res.writeHead(requests === 1 ? 200 : 500, { 'content-type': 'application/json' });
    // Chunked wire: no Content-Length admission shortcut.
    for (let index = 0; index < 10; index++) res.write('x'.repeat(65536));
    res.end();
  });
  t.after(server.close);
  await assert.rejects(privateDeftyModelTurn(params(server.url)), /response exceeds its bound/);
  await assert.rejects(privateDeftyModelTurn(params(server.url)), /response exceeds its bound/);
  assert.equal(requests, 2);
});

test('private Defty actual redirect never forwards reviewed prompt to another endpoint', async t => {
  let redirectedBodies = 0;
  const target = await endpoint(async (req, res) => { await body(req); redirectedBodies++; res.end('{}'); });
  t.after(target.close);
  const source = await endpoint(async (req, res) => {
    await body(req); res.writeHead(307, { location: `${target.url}/stolen` }); res.end();
  });
  t.after(source.close);
  await assert.rejects(privateDeftyModelTurn(params(source.url)));
  assert.equal(redirectedBodies, 0);
});

test('private Defty unexpected model tool request never returns a partial answer', async t => {
  const server = await endpoint(async (req, res) => {
    await body(req); res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: {
      content: 'partial-sentinel', tool_calls: [{ id: 'bad', type: 'function', function: { name: 'send_email', arguments: '{}' } }],
    } }] }));
  });
  t.after(server.close);
  await assert.rejects(privateDeftyModelTurn(params(server.url)), /output unavailable/);
});

test('private Anthropic dispatch binds reviewed endpoint despite SDK environment override', async t => {
  let unreviewed = 0;
  let reviewed = 0;
  let inheritedAuthorization: string | undefined;
  const other = await endpoint(async (req, res) => { await body(req); unreviewed++; res.end('{}'); });
  const approved = await endpoint(async (req, res) => {
    reviewed++; assert.equal(req.url, '/v1/messages');
    inheritedAuthorization = req.headers.authorization;
    const captured = await body(req); assert.deepEqual(captured.tools, []);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'msg_synthetic', type: 'message', role: 'assistant', model: 'test-model',
      content: [{ type: 'text', text: 'Pinned endpoint answer' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const old = process.env.ANTHROPIC_BASE_URL;
  const oldToken = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_AUTH_TOKEN = 'unreviewed-synthetic-token';
  process.env.ANTHROPIC_BASE_URL = other.url;
  t.after(async () => {
    if (old === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = old;
    if (oldToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = oldToken;
    await approved.close(); await other.close();
  });
  const input = params(approved.url);
  const result = await privateDeftyModelTurn({ ...input, resolved: { ...input.resolved, provider: 'anthropic' } });
  assert.equal(result, 'Pinned endpoint answer');
  assert.equal(reviewed, 1); assert.equal(unreviewed, 0);
  assert.equal(inheritedAuthorization, undefined);
});
