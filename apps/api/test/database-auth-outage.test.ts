import assert from 'node:assert/strict';
import test from 'node:test';
import { db, closeDb } from '../src/lib/db.js';
import { authenticateWebRequest } from '../src/middleware/auth.js';
import { env } from '../src/lib/env.js';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';

test('storage failures do not deny access or refresh credentials', async t => {
  const originalSelect = db.select;
  const originalTransaction = db.transaction;
  t.after(async () => { db.select = originalSelect; db.transaction = originalTransaction; await closeDb(); });
  const offline = () => { throw new Error('Failed query: rollback', { cause: new Error('Client has encountered a connection error and is not queryable') }); };
  db.select = offline;
  db.transaction = offline;
  const identity = { id: 'user', org_id: 'org', email: 'user@example.test', sid: randomUUID(), jti: randomUUID() };
  const access = jwt.sign({ ...identity, purpose: 'web-access' }, env.JWT_SECRET, { expiresIn: 60 });
  const result = await authenticateWebRequest(new Request('http://local/api/tasks', { headers: { Authorization: `Bearer ${access}` } }), false);
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.status, 503); assert.equal(result.code, 'DATABASE_UNAVAILABLE'); }
  const { app } = await import('../src/index.js');
  const refreshToken = jwt.sign({ ...identity, purpose: 'web-refresh' }, env.JWT_REFRESH_SECRET, { expiresIn: 60 });
  const response = await app.request('/api/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }) });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'DATABASE_UNAVAILABLE');
});
