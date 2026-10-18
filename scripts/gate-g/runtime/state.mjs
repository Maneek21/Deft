import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const LEASE_MS = 1_500;

export function openHost(path) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      installation_id TEXT NOT NULL, version_id TEXT NOT NULL, grant_id TEXT NOT NULL,
      epoch INTEGER NOT NULL, retry_class TEXT NOT NULL, state TEXT NOT NULL,
      cancelled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, number INTEGER NOT NULL,
      state TEXT NOT NULL, claim_token TEXT, lease_until INTEGER,
      sequence INTEGER NOT NULL DEFAULT 0, UNIQUE(run_id, number));`);
  return db;
}

export function seed(db, id, retryClass) {
  db.prepare(`INSERT INTO runs VALUES (?, 'org-A', 'actor-A', 'installation-A',
    'version-A', 'grant-A', 7, ?, 'pending', 0)`).run(id, retryClass);
  db.prepare(`INSERT INTO attempts(id,run_id,number,state) VALUES (?,?,1,'pending')`)
    .run(`${id}:1`, id);
}

export function run(db, id) {
  return db.prepare('SELECT * FROM runs WHERE id=?').get(id);
}

export function attempts(db, id) {
  return db.prepare('SELECT * FROM attempts WHERE run_id=? ORDER BY number').all(id);
}

function identityMatches(row, expected) {
  return row && row.org_id === expected.org_id && row.actor_id === expected.actor_id
    && row.installation_id === expected.installation_id
    && row.version_id === expected.version_id && row.grant_id === expected.grant_id
    && row.epoch === expected.epoch;
}

export const identity = Object.freeze({
  org_id: 'org-A', actor_id: 'actor-A', installation_id: 'installation-A',
  version_id: 'version-A', grant_id: 'grant-A', epoch: 7,
});

export function claim(db, runId, expected = identity) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = run(db, runId);
    if (!identityMatches(row, expected) || row.cancelled || row.state !== 'pending') {
      db.exec('ROLLBACK');
      return null;
    }
    const attempt = db.prepare(`SELECT * FROM attempts WHERE run_id=? AND state='pending'
      ORDER BY number LIMIT 1`).get(runId);
    if (!attempt) { db.exec('ROLLBACK'); return null; }
    const token = randomUUID();
    const lease = Date.now() + LEASE_MS;
    const changed = db.prepare(`UPDATE attempts SET state='claimed',claim_token=?,lease_until=?
      WHERE id=? AND state='pending'`).run(token, lease, attempt.id);
    db.exec('COMMIT');
    return changed.changes === 1 ? { id: attempt.id, token, lease } : null;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function heartbeat(db, attemptId, token, sequence) {
  const changed = db.prepare(`UPDATE attempts SET lease_until=?,sequence=?
    WHERE id=? AND claim_token=? AND sequence=? AND lease_until>?
    AND state IN ('claimed','provider_call_started')
    AND EXISTS (SELECT 1 FROM runs WHERE runs.id=attempts.run_id AND cancelled=0)`)
    .run(Date.now() + LEASE_MS, sequence, attemptId, token, sequence - 1, Date.now());
  return changed.changes === 1;
}

export function startCall(db, attemptId, token) {
  const changed = db.prepare(`UPDATE attempts SET state='provider_call_started'
    WHERE id=? AND claim_token=? AND state='claimed' AND lease_until>?
    AND EXISTS (SELECT 1 FROM runs WHERE runs.id=attempts.run_id AND cancelled=0)`)
    .run(attemptId, token, Date.now());
  return changed.changes === 1;
}

export function complete(db, attemptId, token, expected = identity) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const attempt = db.prepare('SELECT * FROM attempts WHERE id=?').get(attemptId);
    const row = attempt && run(db, attempt.run_id);
    if (!identityMatches(row, expected) || row.cancelled || row.state !== 'pending'
      || attempt.state !== 'provider_call_started' || attempt.claim_token !== token
      || attempt.lease_until <= Date.now()) {
      db.exec('ROLLBACK'); return false;
    }
    db.prepare("UPDATE attempts SET state='succeeded' WHERE id=?").run(attemptId);
    db.prepare("UPDATE runs SET state='succeeded' WHERE id=?").run(attempt.run_id);
    db.exec('COMMIT'); return true;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function cancel(db, runId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE runs SET cancelled=1,state='cancelled' WHERE id=?").run(runId);
    db.prepare("UPDATE attempts SET state='cancelled' WHERE run_id=? AND state IN ('pending','claimed','provider_call_started')")
      .run(runId);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function recover(db, runId, providerLookup) {
  const current = run(db, runId);
  if (!current || current.cancelled || current.state !== 'pending') return 'no_work';
  const attempt = db.prepare(`SELECT * FROM attempts WHERE run_id=?
    AND state IN ('claimed','provider_call_started') ORDER BY number DESC LIMIT 1`).get(runId);
  if (!attempt || attempt.lease_until > Date.now()) return 'lease_live';
  // The provider lookup is outside the host transaction. Only an idempotent,
  // durable lookup by the stable Run key is allowed to resolve an ambiguous call.
  const observed = attempt.state === 'provider_call_started'
    && current.retry_class === 'idempotent_with_key' ? providerLookup(runId) : false;
  db.exec('BEGIN IMMEDIATE');
  try {
    const latest = db.prepare('SELECT * FROM attempts WHERE id=?').get(attempt.id);
    if (latest.state !== attempt.state || latest.claim_token !== attempt.claim_token
      || latest.lease_until > Date.now() || run(db, runId).state !== 'pending') {
      db.exec('ROLLBACK'); return 'changed';
    }
    if (observed) {
      db.prepare("UPDATE attempts SET state='succeeded' WHERE id=?").run(attempt.id);
      db.prepare("UPDATE runs SET state='succeeded' WHERE id=?").run(runId);
      db.exec('COMMIT'); return 'reconciled_success';
    }
    const ambiguous = attempt.state === 'provider_call_started';
    db.prepare('UPDATE attempts SET state=? WHERE id=?')
      .run(ambiguous ? 'unknown_outcome' : 'failed', attempt.id);
    if (ambiguous && current.retry_class !== 'idempotent_with_key') {
      db.prepare("UPDATE runs SET state='unknown_outcome' WHERE id=?").run(runId);
      db.exec('COMMIT'); return 'unknown_outcome';
    }
    db.prepare("INSERT INTO attempts(id,run_id,number,state) VALUES (?,?,?,'pending')")
      .run(`${runId}:${attempt.number + 1}`, runId, attempt.number + 1);
    db.exec('COMMIT'); return 'retry_prepared';
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
