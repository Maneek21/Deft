import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { format } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { logCapacityProfile, logId, logJobName, logNumber, logQueueName, logSignal } from '../src/lib/log-metadata.js';
import { createAgentMessage } from '../src/lib/agent-llm.js';
import { llm } from '../src/lib/llm.js';
import { printRequestLogLine } from '../src/lib/request-logger.js';

test('metadata formatters retain counts, known jobs, queues and generated IDs without coercing text', () => {
  const marker = `PRIVATE-${randomUUID()}`;
  const hostile = { toString() { throw new Error(marker); } };
  for (const value of [marker, hostile, undefined, NaN, Infinity]) {
    for (const formatter of [logNumber, logId, logJobName, logQueueName, logSignal]) {
      assert.ok(!String(formatter(value)).includes(marker));
    }
  }
  assert.equal(logNumber(42), 42);
  const id = randomUUID();
  assert.equal(logId(id), id);
  assert.equal(logId(id.slice(0, 8)), id.slice(0, 8));
  assert.equal(logJobName('agent-reply'), 'agent-reply');
  assert.equal(logQueueName('scheduled-jobs'), 'scheduled-jobs');
  assert.equal(logSignal('SIGTERM'), 'SIGTERM');
  const registry = readFileSync(new URL('../src/workers/index.ts', import.meta.url), 'utf8');
  for (const [, name] of registry.matchAll(/case '([^']+)'/g)) assert.equal(logJobName(name), name, `Register diagnostic name: ${name}`);
});

test('capacity events remain parseable by the certifier and reject text or extra fields', () => {
  const marker = `PRIVATE-${randomUUID()}`;
  const lines = [
    logCapacityProfile('notification_fanout', { requested: 4, allowed: 3, total_ms: 2.5,
      attention_mode: 'queued', error: marker, token: marker, notification_insert_ms: marker }),
    logCapacityProfile('attention_projection', { notifications: 3, projected_items: 3,
      queue_delay_ms: null, projection_ms: 1.5, end_to_end_ms: 4, error: marker }),
    logCapacityProfile(marker as any, { requested: marker }),
  ];
  assert.ok(!lines.join('\n').includes(marker));
  // Use the actual certification parser, without executing its live workload.
  const source = readFileSync(new URL('../../../scripts/certify-60-person.mjs', import.meta.url), 'utf8');
  const parser = source.slice(source.indexOf('function parseCapacityProfiles('), source.indexOf('\nfunction addGateFinding('));
  const parse = new Function('latencySummary', `${parser}; return parseCapacityProfiles;`)(
    (values: number[]) => ({ p95_ms: values.length ? Math.max(...values) : null }));
  const result = parse(lines.join('\n'));
  assert.equal(result.samples, 1);
  assert.equal(result.requested_notifications, 4);
  assert.equal(result.attention_projection.jobs, 1);
  assert.equal(result.attention_projection.projected_items, 3);
  assert.equal(result.attention_projection.projection.p95_ms, 1.5);
});

test('real request middleware retains successful and failed status with color enabled and disabled', () => {
  const logger = new URL('../src/lib/request-logger.ts', import.meta.url).href;
  const code = `import {Hono} from 'hono'; import {requestLogger} from ${JSON.stringify(logger)};
    const app=new Hono(); app.use('*',requestLogger); app.get('/ok',c=>c.text('ok'));
    app.get('/fail',c=>c.text('failed',500)); await app.request('/ok'); await app.request('/fail');`;
  for (const color of [true, false]) {
    const env = { ...process.env };
    if (color) delete env.NO_COLOR; else env.NO_COLOR = '1';
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), env, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /--> GET <redacted> 200 /);
    assert.match(child.stdout, /--> GET <redacted> 500 /);
    assert.ok(!child.stdout.includes('\x1b'));
  }
});

test('request formatter retains long durations and rejects unrecognized status text', t => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => { lines.push(line); });
  printRequestLogLine('--> GET /private \x1b[31m500\x1b[0m 1,234s');
  printRequestLogLine('--> GET /private PRIVATE-STATUS PRIVATE-TIME');
  assert.equal(lines[0], '--> GET <redacted> 500 1234s');
  assert.equal(lines[1], '--> GET <redacted>');
});

test('provider debug environment cannot log prompts, keys or provider errors through either Anthropic adapter', async t => {
  const previous = process.env.ANTHROPIC_LOG;
  process.env.ANTHROPIC_LOG = 'debug';
  const marker = `PRIVATE-${randomUUID()}`;
  const lines: string[] = [];
  for (const method of ['debug', 'info', 'warn', 'error', 'log'] as const) {
    t.mock.method(console, method, (...args: unknown[]) => { lines.push(format(...args)); });
  }
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return new Response(marker, { status: 400, headers: { 'Content-Type': 'text/plain' } });
  });
  try {
    await assert.rejects(createAgentMessage({ resolved: { provider: 'anthropic', model: 'test', apiKey: marker },
      system: marker, messages: [{ role: 'user', content: marker }], tools: [], maxTokens: 8 }));
    await assert.rejects(llm({ task: 'classify', system: marker, messages: [{ role: 'user', content: marker }],
      orgConfig: { ai_models: { classify: { provider: 'anthropic', model: 'test' } }, api_keys: { anthropic: marker } } }));
    assert.equal(requests, 2, 'both real SDK adapters must reach the fake transport');
    assert.ok(!lines.join('\n').includes(marker));
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_LOG; else process.env.ANTHROPIC_LOG = previous;
  }
});

test('fatal exceptions and rejections exit without Node printing customer-bearing errors', () => {
  const module = new URL('../src/lib/content-free-process-errors.ts', import.meta.url).href;
  const marker = `PRIVATE-${randomUUID()}`;
  for (const mode of ['throw', 'reject']) {
    const code = `await import(${JSON.stringify(module)}); const error=Object.assign(new Error(${JSON.stringify(marker)}),
      {query:${JSON.stringify(marker)},cause:new Error(${JSON.stringify(marker)})});
      ${mode === 'throw' ? 'throw error;' : 'Promise.reject(error);'}`;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /\[process\] Un(?:caught exception|handled rejection); exiting/);
    assert.ok(!(child.stdout + child.stderr).includes(marker));
  }
});
