import { DatabaseSync } from 'node:sqlite';

const [command, path, key] = process.argv.slice(2);
if (!command || !path || !key) throw new Error('provider command, ledger path and key required');
const db = new DatabaseSync(path);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
  CREATE TABLE IF NOT EXISTS effects (
    id INTEGER PRIMARY KEY, effect_key TEXT NOT NULL, created_at TEXT NOT NULL,
    process_id INTEGER NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS effects_idempotent ON effects(effect_key)
    WHERE effect_key LIKE 'idempotent:%';`);
if (command === 'effect') {
  db.prepare('INSERT OR IGNORE INTO effects(effect_key,created_at,process_id) VALUES (?,?,?)')
    .run(key, new Date().toISOString(), process.pid);
  process.stdout.write('recorded\n');
} else if (command === 'lookup') {
  const found = db.prepare('SELECT COUNT(*) AS n FROM effects WHERE effect_key=?').get(key).n;
  process.stdout.write(`${found}\n`);
} else if (command === 'count') {
  const found = db.prepare('SELECT COUNT(*) AS n FROM effects').get().n;
  process.stdout.write(`${found}\n`);
} else throw new Error('unknown command');
db.close();
