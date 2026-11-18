import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { format } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { logCapacityProfile, logId, logJobName, logNumber, logQueueName, logSignal, logStartupHint } from '../src/lib/log-metadata.js';
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

test('startup hints retain closed remediation and never echo supplied values or unknown codes', () => {
  const marker = `PRIVATE-${randomUUID()}`;
  for (const prefix of ['DEFT_HOSTED must be exactly', 'DEFT_PAUSED_START must be exactly',
    'JWT_SECRET must be', 'JWT_REFRESH_SECRET must be', 'ENCRYPTION_KEY must be',
    'DEFT_SETUP_TOKEN_SHA256 must be', 'DEFT_SETUP_TOKEN_EXPIRES_AT must be',
    'Hosted mode needs a usable seat statement setup:', 'DEFT_APP_RUN_APP_ORIGIN_ENABLED=true requires']) {
    const hint = logStartupHint(new Error(`${prefix} ${marker}`));
    assert.notEqual(hint, 'Unclassified fatal error');
    assert.ok(!hint.includes(marker));
  }
  assert.equal(logStartupHint(Object.assign(new Error(marker), { code: marker })), 'Unclassified fatal error');
  assert.equal(logStartupHint({ get code() { throw new Error(marker); } }), 'Unclassified fatal error');
  assert.match(logStartupHint(Object.assign(new Error(marker), { code: 'EADDRINUSE' })), /EADDRINUSE/);
});

test('server import order preserves startup setting diagnostics without their supplied values', () => {
  const bootstrap = new URL('../src/lib/content-free-process-errors.ts', import.meta.url).href;
  const envModule = new URL('../src/lib/env.ts', import.meta.url).href;
  const pausedModule = new URL('../src/lib/paused-start.ts', import.meta.url).href;
  const marker = `PRIVATE-${randomUUID()}`;
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{ DEFT_HOSTED: marker }, /Invalid DEFT_HOSTED/],
    [{ DEFT_PAUSED_START: marker }, /Invalid DEFT_PAUSED_START/],
    [{ NODE_ENV: 'production', JWT_SECRET: `${marker} ` }, /Invalid JWT_SECRET/],
    [{ NODE_ENV: 'production', JWT_SECRET: 's'.repeat(48), JWT_REFRESH_SECRET: 's'.repeat(48) }, /must be different/],
    [{ NODE_ENV: 'production', ENCRYPTION_KEY: 'short' }, /Invalid ENCRYPTION_KEY/],
    [{ DEFT_CELL_ID: marker }, /Hosted-only settings require DEFT_HOSTED=true/],
  ];
  for (const [settings, expected] of cases) {
    const env = { ...process.env };
    for (const key of ['DEFT_SETUP_TOKEN_SHA256', 'DEFT_SETUP_TOKEN_EXPIRES_AT', 'DEFT_CELL_ID',
      'DEFT_SEAT_PUBLIC_KEYS', 'DEFT_SEAT_STATEMENT_URL', 'DEFT_SEAT_FETCH_TOKEN']) delete env[key];
    Object.assign(env, { NODE_ENV: 'test', DEFT_HOSTED: 'false', DEFT_PAUSED_START: 'false',
      JWT_SECRET: 'a'.repeat(48), JWT_REFRESH_SECRET: 'b'.repeat(48), ENCRYPTION_KEY: 'c'.repeat(48),
      DEFT_APP_RUNS_ENABLED: 'false', DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED: 'false',
      DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'false', DEFT_APP_AUTOMATIONS_ENABLED: 'false' }, settings);
    const code = `await import(${JSON.stringify(bootstrap)}); await import(${JSON.stringify(envModule)});
      const paused = await import(${JSON.stringify(pausedModule)}); paused.assertPausedStartSettingValid();`;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), env, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, expected);
    assert.ok(!(child.stdout + child.stderr).includes(marker));
  }
});

test('listen failures retain a safe system code without logging paths or error messages', () => {
  const bootstrap = new URL('../src/lib/content-free-process-errors.ts', import.meta.url).href;
  const code = `await import(${JSON.stringify(bootstrap)}); const net=await import('node:net');
    const first=net.createServer(); await new Promise(resolve=>first.listen(0,'127.0.0.1',resolve));
    net.createServer().listen(first.address().port,'127.0.0.1');`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /EADDRINUSE: API listen port is already in use/);
});

test('Socket.IO debug opt-in cannot print emitted customer event payloads in the server bootstrap', () => {
  const bootstrap = new URL('../src/lib/content-free-process-errors.ts', import.meta.url).href;
  const marker = `PRIVATE-${randomUUID()}`;
  for (const fromEnvironment of [true, false]) {
    const env = { ...process.env };
    if (fromEnvironment) env.DEBUG = 'socket.io*,engine*'; else delete env.DEBUG;
    const code = `await import(${JSON.stringify(bootstrap)});
      const dotenv=(await import('dotenv')).default;
      dotenv.populate(process.env, {DEBUG:'socket.io*,engine*'});
      const {Server}=await import('socket.io');
      const io=new Server(); io.emit('message:new', ${JSON.stringify(marker)});`;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), env, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.ok(!(child.stdout + child.stderr).includes(marker));
  }
});
