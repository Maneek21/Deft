import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@deft/db/schema';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = target && ['localhost', '127.0.0.1'].includes(new URL(target).hostname)
  && /^\/(?:preview_[a-z0-9_]+|deft_test)$/.test(new URL(target).pathname);

// Real PostgreSQL locks and the production rotation function. Only its database
// and token-secret module boundaries are replaced, using an isolated SQL schema.
test('refresh completes with all other ordinary connections waiting on its session row', { skip: !safe, timeout: 15_000 }, async t => {
  const namespace = `refresh_${randomUUID().replaceAll('-', '')}`;
  const applicationName = namespace;
  const admin = new pg.Pool({ connectionString: target, max: 1 });
  const pool = new pg.Pool({ connectionString: target, max: 4, application_name: applicationName,
    options: `-c search_path=${namespace}` });
  const readers: Promise<unknown>[] = [];
  let rotation: Promise<unknown> | undefined;
  t.after(async () => {
    // Also release a failing regression's intentional lock/pool wait cycle.
    await admin.query('SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type=\'Lock\'', [applicationName]);
    await Promise.allSettled(readers);
    await rotation?.catch(() => {});
    await pool.end();
    await admin.query(`DROP SCHEMA ${namespace} CASCADE`);
    await admin.end();
    mock.restoreAll();
  });
  await admin.query(`CREATE SCHEMA ${namespace};
    CREATE TABLE ${namespace}.web_sessions (id text PRIMARY KEY, user_id text, org_id text,
      refresh_token_hash text, expires_at timestamptz, revoked_at timestamptz, created_at timestamptz DEFAULT now());
    CREATE TABLE ${namespace}.org_members (id text, org_id text, user_id text, role text, is_active boolean);`);
  const database = drizzle(pool, { schema });
  const secret = 'disposable-refresh-pool-regression';
  mock.module(new URL('../src/lib/db.ts', import.meta.url).href, { namedExports: { db: database } });
  mock.module(new URL('../src/lib/env.ts', import.meta.url).href, { namedExports: { env: { JWT_SECRET: secret, JWT_REFRESH_SECRET: secret } } });
  const { rotateWebSession } = await import('../src/lib/web-sessions.js');
  const sid = randomUUID(), user = randomUUID(), org = randomUUID();
  const token = jwt.sign({ id: user, org_id: org, email: 'fixture@invalid.local', sid, jti: randomUUID(), purpose: 'web-refresh' }, secret, { expiresIn: 600 });
  await pool.query('INSERT INTO web_sessions(id,user_id,org_id,refresh_token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval \'10 minutes\')',
    [sid, user, org, createHash('sha256').update(token).digest('hex')]);
  await pool.query('INSERT INTO org_members VALUES($1,$2,$3,\'owner\',true)', [randomUUID(), org, user]);

  // Delay delivery of the real FOR UPDATE result until three real readers have
  // used the remaining pool slots and are blocked behind that transaction.
  let intercepted = false;
  let ready!: () => void;
  const readersBlocked = new Promise<void>(resolve => { ready = resolve; });
  pool.on('acquire', client => {
    if ((client as any).refreshIntercepted) return;
    (client as any).refreshIntercepted = true;
    const query = client.query.bind(client);
    (client as any).query = (...args: any[]) => {
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
      const result = (query as any)(...args);
      if (intercepted || !/select .*web_sessions.*for update/i.test(text ?? '')) return result;
      intercepted = true;
      return result.then(async (rows: unknown) => {
        for (let index = 0; index < 3; index++) {
          const reader = pool.connect().then(async connection => {
            try {
              await connection.query('BEGIN');
              await connection.query('SELECT id FROM web_sessions WHERE id=$1 FOR SHARE', [sid]);
            } finally {
              await connection.query('ROLLBACK');
              connection.release();
            }
          });
          reader.catch(() => {});
          readers.push(reader);
        }
        for (let attempt = 0; attempt < 100; attempt++) {
          const result = await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type=\'Lock\'', [applicationName]);
          if (result.rows[0].count === 3) {
            assert.equal(pool.totalCount, 4);
            assert.equal(pool.idleCount, 0);
            ready();
            return rows;
          }
          await delay(10);
        }
        throw new Error('three session readers did not reach the lock barrier');
      });
    };
  });
  rotation = rotateWebSession(token);
  await Promise.race([readersBlocked, rotation.then(() => { throw new Error('refresh bypassed the lock barrier'); }), delay(5000).then(() => { throw new Error('session lock barrier timed out'); })]);
  const rotated = await Promise.race([rotation, delay(1500).then(() => { throw new Error('refresh deadlocked with three session readers occupying the four-connection pool'); })]) as { refreshToken: string };
  assert.ok(intercepted, 'the real session lock reached the contention barrier');
  assert.notEqual(rotated.refreshToken, token);
  await Promise.all(readers);
  await pool.query('UPDATE org_members SET is_active=false');
  await assert.rejects(rotateWebSession(rotated.refreshToken), /not an active member/);
  await pool.query('UPDATE org_members SET is_active=true');
  await pool.query('UPDATE web_sessions SET revoked_at=now()');
  await assert.rejects(rotateWebSession(rotated.refreshToken), /Session revoked/);
});
