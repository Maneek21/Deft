import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { Hono } from 'hono';
import { requestLogger } from '../src/lib/request-logger.js';
import { contentFreeErrorHandler } from '../src/lib/content-free-error-handler.js';
import { clientSafeErrorMessage } from '../src/lib/client-safe-error.js';
import { withAppDataDiagnostic } from '../src/lib/app-data-diagnostics.js';

const root = fileURLToPath(new URL('../src/', import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? (entry.name === 'scripts' ? [] : files(join(dir, entry.name)))
      : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []);
}
function literal(node: ts.Node): boolean {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    || ts.isNumericLiteral(node) || (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.PlusToken && literal(node.left) && literal(node.right));
}

test('API and workers never pass customer-controlled values to console', () => {
  const leaks: string[] = [];
  for (const file of files(root)) {
    // This dedicated sink has behavioral coverage below for attacker-controlled URLs.
    if (relative(root, file).replaceAll('\\', '/') === 'lib/request-logger.ts') continue;
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.expression.getText(source) === 'console'
        && node.arguments.some(arg => !literal(arg))) {
        const name = relative(root, file).replaceAll('\\', '/');
        // Audited structured telemetry uses a closed vocabulary and generated
        // request IDs; client error references are generated random hex IDs.
        // Pin the exact sinks so adding another dynamic call fails this test.
        const audited = (name === 'lib/app-data-diagnostics.ts'
          && node.getText(source) === 'console.info(JSON.stringify(event))')
          || (name === 'lib/client-safe-error.ts'
          && node.getText(source) === "console.error('[client-safe-error] Action failed; reference:', reference)");
        if (!audited) leaks.push(`${name}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(leaks, [], 'Dynamic log arguments can contain query parameters, exception messages, or customer content');
});

test('structured diagnostics and error references exclude underlying customer text', async () => {
  const marker = `PRIVATE-${Date.now()}-diagnostic`;
  const output: unknown[][] = [];
  const originalError = console.error, originalInfo = console.info;
  console.error = console.info = (...args) => { output.push(args); };
  try {
    const response = clientSafeErrorMessage(new Error(`Failed query: ${marker}`), marker);
    assert.match(response, /Reference: [a-f0-9]{8}$/);
    assert.ok(output.some(args => args.includes(response.slice(-8))), 'support can correlate the reference');
    await assert.rejects(withAppDataDiagnostic('authority', async () => { throw new Error(marker); }, marker));
  } finally { console.error = originalError; console.info = originalInfo; }
  assert.ok(output.length >= 2);
  assert.ok(!JSON.stringify(output).includes(marker));
});

test('unhandled errors omit messages, causes and properties while retaining HTTP behavior', async () => {
  const marker = `PRIVATE-${Date.now()}-exception`;
  const output: unknown[][] = [];
  const original = console.error;
  console.error = (...args) => { output.push(args); };
  try {
    const app = new Hono();
    app.onError(contentFreeErrorHandler);
    app.get('/fail', () => {
      throw Object.assign(new Error(marker, { cause: new Error(marker) }), { query: marker });
    });
    const response = await app.request('/fail');
    assert.equal(response.status, 500);
    assert.equal(await response.text(), 'Internal Server Error');
  } finally { console.error = original; }
  assert.ok(output.length > 0);
  assert.ok(!JSON.stringify(output).includes(marker));
});

test('request logging omits arbitrary content in paths, queries, headers and failed bodies', async () => {
  const marker = `PRIVATE-${Date.now()}-request`;
  const output: string[] = [];
  const original = console.log;
  console.log = (...args) => { output.push(args.map(String).join(' ')); };
  try {
    const app = new Hono();
    app.use('*', requestLogger);
    app.post('/api/messages/:space', async c => {
      await c.req.json();
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    });
    const response = await app.request(`/api/messages/${marker}?q=${marker}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${marker}` },
      body: JSON.stringify({ content: marker }),
    });
    assert.equal(response.status, 400);
    assert.equal((await app.request(`/unknown/${marker}?token=${marker}`)).status, 404);
  } finally { console.log = original; }
  assert.ok(output.length > 0, 'capture must exercise the request logger');
  assert.ok(!output.join('\n').includes(marker), output.join('\n'));
});
