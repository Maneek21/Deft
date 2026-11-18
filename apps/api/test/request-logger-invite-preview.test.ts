import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { redactLogTarget, requestLogger } from '../src/lib/request-logger.js';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzZWNyZXQiOiJ5ZXMifQ.c2lnbmF0dXJlLXNlY3JldA';

test('redactLogTarget hides credential paths and arbitrary customer targets', () => {
  const encodedFirst = `%${TOKEN.charCodeAt(0).toString(16)}${TOKEN.slice(1)}`;
  for (const target of [
    `/api/invites/preview/${TOKEN}`,
    `/api/invites/preview/${TOKEN}?x=1`,
    `/api/invites/preview/${encodedFirst}`,
    `/api/invites/%70review/${TOKEN}`,
    `/api/invites//preview/${TOKEN}`,
    `/API/INVITES/PREVIEW/${TOKEN}`,
    `/api/invites/preview/%zz${TOKEN}`,
  ]) {
    assert.equal(redactLogTarget(target), '/api/invites/preview/<redacted>', target);
  }
  assert.equal(redactLogTarget('/api/invites/preview'), '<redacted>');
  assert.equal(redactLogTarget('/api/invites/accept'), '<redacted>');
  assert.equal(redactLogTarget('/api/ics/feed/abc'), '/api/ics/feed/<redacted>');
  assert.equal(redactLogTarget('/api/other/abc?q=1'), '<redacted>');
});

test('request log lines for the legacy invite preview never contain the token', async () => {
  const logged: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void logged.push(a.map(String).join(' '));
  try {
    const app = new Hono();
    app.use('*', requestLogger);
    app.get('/api/invites/preview/:token', (c) => c.json({ ok: true }));
    app.post('/api/invites/preview', (c) => c.json({ ok: true }));
    assert.equal((await app.request(`/api/invites/preview/${TOKEN}`)).status, 200);
    assert.equal((await app.request(`/api/invites/preview/${TOKEN}?from=link`)).status, 200);
    assert.equal((await app.request('/api/invites/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }),
    })).status, 200);
  } finally {
    console.log = orig;
  }
  assert.equal(logged.length, 6, logged.join('\n'));
  const all = logged.join('\n');
  assert.ok(!all.includes(TOKEN.slice(4)), all);
  assert.ok(!all.includes('c2lnbmF0dXJl'), all);
  for (const line of logged.slice(0, 4)) assert.match(line, /^(<--|-->) GET \/api\/invites\/preview\/<redacted>( |$)/, line);
  for (const line of logged.slice(4)) assert.match(line, /^(<--|-->) POST <redacted>( |$)/, line);
});
