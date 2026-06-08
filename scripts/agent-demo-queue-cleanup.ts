import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const args = new Set(process.argv.slice(2));
const shouldApply = args.has('--apply');
const olderThanArg = process.argv.find((arg) => arg.startsWith('--older-than-minutes='));
const olderThanMinutes = Number(olderThanArg?.split('=')[1] ?? '0');
const slugArg = process.argv.find((arg) => arg.startsWith('--slugs='));
const slugs = slugArg
  ? slugArg.split('=')[1]!.split(',').map((slug) => slug.trim()).filter(Boolean)
  : [];

function dockerDatabaseUrl(): string | null {
  try {
    const portOut = execFileSync('docker', ['port', 'deft-codex-pg', '5432/tcp'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const port = portOut.match(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d+)/)?.[1];
    if (!port) return null;
    const password = execFileSync('docker', ['exec', 'deft-codex-pg', 'printenv', 'POSTGRES_PASSWORD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || 'postgres';
    const dbName = execFileSync('docker', ['exec', 'deft-codex-pg', 'printenv', 'POSTGRES_DB'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || 'deft';
    return `postgres://postgres:${encodeURIComponent(password)}@localhost:${port}/${dbName}`;
  } catch {
    return null;
  }
}

function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const dockerUrl = dockerDatabaseUrl();
  if (dockerUrl) return dockerUrl;
  const password = process.env.POSTGRES_PASSWORD || 'postgres';
  const port = process.env.POSTGRES_PORT || '5432';
  return `postgres://postgres:${encodeURIComponent(password)}@localhost:${port}/deft`;
}

function redactUrl(url: string): string {
  return url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
}

const client = new pg.Client({ connectionString: databaseUrl() });

async function main() {
  try {
    await client.connect();
    const cutoff = new Date(Date.now() - Math.max(0, olderThanMinutes) * 60_000);
    const params: unknown[] = [cutoff];
    let slugFilter = '';
    if (slugs.length > 0) {
      params.push(slugs);
      slugFilter = `and ae.slug = any($${params.length}::text[])`;
    }

    const selectSql = `
      select a.id, a.action, a.source, a.created_at, ae.slug, ae.name, ae.runtime_kind
      from agent_actions a
      join agent_employees ae on ae.id = a.agent_employee_id
      where a.approval_status = 'pending'
        and a.approval_tier = 'auto'
        and a.created_at <= $1
        and a.source in ('mention', 'task_assignment')
        and ae.runtime_kind in ('codex', 'openclaw', 'hermes')
        ${slugFilter}
      order by a.created_at asc
    `;
    const pending = await client.query(selectSql, params);

    console.log(JSON.stringify({
      mode: shouldApply ? 'apply' : 'dry-run',
      database: redactUrl(databaseUrl()),
      cutoff,
      slugs: slugs.length ? slugs : 'all codex/openclaw/hermes',
      pending_count: pending.rowCount,
      sample: pending.rows.slice(0, 20),
    }, null, 2));

    if (shouldApply && pending.rowCount > 0) {
      const ids = pending.rows.map((row) => row.id);
      const update = await client.query(
        `
          update agent_actions
          set approval_status = 'expired',
              error = coalesce(error, 'Expired by local demo queue cleanup')
          where id = any($1::text[])
          returning id
        `,
        [ids],
      );
      console.log(JSON.stringify({ expired_count: update.rowCount }, null, 2));
    }
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
