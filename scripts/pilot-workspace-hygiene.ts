import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const args = new Set(process.argv.slice(2));
const shouldApply = args.has('--apply');
const orgSlugArg = process.argv.find((arg) => arg.startsWith('--org-slug='));
const orgSlug = orgSlugArg?.split('=')[1]?.trim();

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

type HygieneStep = {
  key: string;
  label: string;
  selectSql: string;
  applySql: string;
  params: unknown[];
};

async function countRows(sql: string, params: unknown[]): Promise<number> {
  const result = await client.query(sql, params);
  return Number(result.rows[0]?.count ?? 0);
}

async function applyStep(sql: string, params: unknown[]): Promise<number> {
  const result = await client.query(sql, params);
  return result.rowCount ?? 0;
}

function orgFilter(alias = ''): { clause: string; params: unknown[] } {
  if (!orgSlug) return { clause: '', params: [] };
  const prefix = alias ? `${alias}.` : '';
  return {
    clause: `and ${prefix}org_id = (select id from orgs where slug = $1 limit 1)`,
    params: [orgSlug],
  };
}

async function main() {
  await client.connect();
  try {
    const scoped = orgFilter();
    const scopedAgent = orgFilter('a');
    const scopedEmployee = orgFilter('ae');
    const scopedSpace = orgFilter('s');
    const scopedProject = orgFilter('p');
    const scopedNotification = orgFilter('n');

    const steps: HygieneStep[] = [
      {
        key: 'stale-agent-actions',
        label: 'Expire stale pending audit/employee agent actions',
        selectSql: `
          select count(*)::int as count
          from agent_actions a
          where a.approval_status = 'pending'
            and (
              a.source in ('mention', 'task_assignment', 'blocked_classifier', 'mcp', 'audit')
              or exists (
                select 1
                from agent_employees ae
                where ae.id = a.agent_employee_id
                  and (
                    ae.slug like 'auditagent-%'
                    or ae.slug like 'wizard-smoke-%'
                    or ae.slug like 'test-openclaw-pm-%'
                    or ae.slug like 'codex-qa-battery-%'
                    or ae.slug like 'codex-work-runner-%'
                    or ae.slug like 'codex-byoa-full-battery-%'
                    or ae.slug like 'codex-byoa-agent-%'
                    or ae.slug like 'audit-byoa-agent-%'
                    or ae.slug like 'hermes-comms-%'
                    or ae.slug like 'openclaw-ops-%'
                    or ae.slug like 'codex-pilot-engineer-%'
                    or ae.slug like 'codex-qa%'
                    or ae.slug like 'b31-source-%'
                  )
              )
            )
            ${scopedAgent.clause}
        `,
        applySql: `
          update agent_actions a
          set approval_status = 'expired',
              error = coalesce(error, 'Expired by pilot workspace hygiene')
          where a.approval_status = 'pending'
            and (
              a.source in ('mention', 'task_assignment', 'blocked_classifier', 'mcp', 'audit')
              or exists (
                select 1
                from agent_employees ae
                where ae.id = a.agent_employee_id
                  and (
                    ae.slug like 'auditagent-%'
                    or ae.slug like 'wizard-smoke-%'
                    or ae.slug like 'test-openclaw-pm-%'
                    or ae.slug like 'codex-qa-battery-%'
                    or ae.slug like 'codex-work-runner-%'
                    or ae.slug like 'codex-byoa-full-battery-%'
                    or ae.slug like 'codex-byoa-agent-%'
                    or ae.slug like 'audit-byoa-agent-%'
                    or ae.slug like 'hermes-comms-%'
                    or ae.slug like 'openclaw-ops-%'
                    or ae.slug like 'codex-pilot-engineer-%'
                    or ae.slug like 'codex-qa%'
                    or ae.slug like 'b31-source-%'
                  )
              )
            )
            ${scopedAgent.clause}
        `,
        params: scopedAgent.params,
      },
      {
        key: 'audit-agents',
        label: 'Soft-delete obvious audit-created agent employees',
        selectSql: `
          select count(*)::int as count
          from agent_employees ae
          where ae.is_deleted = false
            and (
              ae.slug like 'auditagent-%'
              or ae.slug like 'wizard-smoke-%'
              or ae.slug like 'test-openclaw-pm-%'
              or ae.slug like 'codex-qa-battery-%'
              or ae.slug like 'codex-work-runner-%'
              or ae.slug like 'codex-byoa-full-battery-%'
              or ae.slug like 'codex-byoa-agent-%'
              or ae.slug like 'audit-byoa-agent-%'
              or ae.slug like 'hermes-comms-%'
              or ae.slug like 'openclaw-ops-%'
              or ae.slug like 'codex-pilot-engineer-%'
              or ae.slug like 'codex-qa%'
              or ae.slug like 'b31-source-%'
              or ae.name in ('Test OpenClaw PM', 'Test UI Employee PM', 'Test UI Employee Eng')
            )
            and ae.slug not in ('tom', 'maya')
            ${scopedEmployee.clause}
        `,
        applySql: `
          update agent_employees ae
          set is_deleted = true,
              is_active = false,
              deleted_at = now()
          where ae.is_deleted = false
            and (
              ae.slug like 'auditagent-%'
              or ae.slug like 'wizard-smoke-%'
              or ae.slug like 'test-openclaw-pm-%'
              or ae.slug like 'codex-qa-battery-%'
              or ae.slug like 'codex-work-runner-%'
              or ae.slug like 'codex-byoa-full-battery-%'
              or ae.slug like 'codex-byoa-agent-%'
              or ae.slug like 'audit-byoa-agent-%'
              or ae.slug like 'hermes-comms-%'
              or ae.slug like 'openclaw-ops-%'
              or ae.slug like 'codex-pilot-engineer-%'
              or ae.slug like 'codex-qa%'
              or ae.slug like 'b31-source-%'
              or ae.name in ('Test OpenClaw PM', 'Test UI Employee PM', 'Test UI Employee Eng')
            )
            and ae.slug not in ('tom', 'maya')
            ${scopedEmployee.clause}
        `,
        params: scopedEmployee.params,
      },
      {
        key: 'audit-spaces',
        label: 'Archive obvious audit/scratch spaces',
        selectSql: `
          select count(*)::int as count
          from spaces s
          where s.is_archived = false
            and s.is_default = false
            and (
              s.name like 'audit-%'
              or s.name like 'wizard-smoke-%'
              or s.name like 'byoa-%'
              or s.name like 'scratch-%'
              or s.name like 'test-%'
              or s.name like 'agent-coworker-lab-%'
              or s.name like 'defty-reliability-lab-%'
              or s.name like 'codex-byoa-lab-%'
              or s.name like 'three-agent-dogfood-%'
              or s.name like 'codex-byoa-dogfood-%'
            )
            and s.name not like 'tom-marketing-dogfood-%'
            ${scopedSpace.clause}
        `,
        applySql: `
          update spaces s
          set is_archived = true,
              updated_at = now()
          where s.is_archived = false
            and s.is_default = false
            and (
              s.name like 'audit-%'
              or s.name like 'wizard-smoke-%'
              or s.name like 'byoa-%'
              or s.name like 'scratch-%'
              or s.name like 'test-%'
              or s.name like 'agent-coworker-lab-%'
              or s.name like 'defty-reliability-lab-%'
              or s.name like 'codex-byoa-lab-%'
              or s.name like 'three-agent-dogfood-%'
              or s.name like 'codex-byoa-dogfood-%'
            )
            and s.name not like 'tom-marketing-dogfood-%'
            ${scopedSpace.clause}
        `,
        params: scopedSpace.params,
      },
      {
        key: 'audit-projects',
        label: 'Soft-delete obvious audit/scratch projects',
        selectSql: `
          select count(*)::int as count
          from projects p
          where p.is_deleted = false
            and (
              p.prefix in ('AUD', 'TST', 'BYOA', 'SMK')
              or p.name ilike 'audit %'
              or p.name ilike 'byoa %'
              or p.name ilike 'scratch %'
              or p.name ilike 'smoke %'
              or p.name ilike 'three runtime byoa battery%'
              or p.name ilike 'defty ui reliability%'
              or p.name ilike 'codex byoa behavior%'
              or p.name ilike 'three agent dogfood%'
              or p.name ilike 'codex byoa dogfood%'
              or p.prefix like 'RT%'
              or p.prefix like 'DF%'
              or p.prefix like 'CX%'
              or p.prefix like 'TG%'
            )
            and p.name not ilike 'tom marketing dogfood%'
            ${scopedProject.clause}
        `,
        applySql: `
          update projects p
          set is_deleted = true,
              is_archived = true,
              deleted_at = now(),
              updated_at = now()
          where p.is_deleted = false
            and (
              p.prefix in ('AUD', 'TST', 'BYOA', 'SMK')
              or p.name ilike 'audit %'
              or p.name ilike 'byoa %'
              or p.name ilike 'scratch %'
              or p.name ilike 'smoke %'
              or p.name ilike 'three runtime byoa battery%'
              or p.name ilike 'defty ui reliability%'
              or p.name ilike 'codex byoa behavior%'
              or p.name ilike 'three agent dogfood%'
              or p.name ilike 'codex byoa dogfood%'
              or p.prefix like 'RT%'
              or p.prefix like 'DF%'
              or p.prefix like 'CX%'
              or p.prefix like 'TG%'
            )
            and p.name not ilike 'tom marketing dogfood%'
            ${scopedProject.clause}
        `,
        params: scopedProject.params,
      },
      {
        key: 'notifications',
        label: 'Mark old pilot/audit notifications as read',
        selectSql: `
          select count(*)::int as count
          from notifications n
          where n.is_read = false
            and n.created_at < now() - interval '1 day'
            and (
              n.type in ('agent_suggestion', 'blocked', 'system')
              or n.title ilike '%audit%'
              or n.title ilike '%blocked%'
              or n.title ilike '%agent%'
            )
            ${scopedNotification.clause}
        `,
        applySql: `
          update notifications n
          set is_read = true,
              updated_at = now()
          where n.is_read = false
            and n.created_at < now() - interval '1 day'
            and (
              n.type in ('agent_suggestion', 'blocked', 'system')
              or n.title ilike '%audit%'
              or n.title ilike '%blocked%'
              or n.title ilike '%agent%'
            )
            ${scopedNotification.clause}
        `,
        params: scopedNotification.params,
      },
    ];

    console.log(JSON.stringify({
      mode: shouldApply ? 'apply' : 'dry-run',
      database: redactUrl(databaseUrl()),
      org_slug: orgSlug || 'all orgs',
    }, null, 2));

    for (const step of steps) {
      const count = await countRows(step.selectSql, step.params);
      let changed = 0;
      if (shouldApply && count > 0) {
        changed = await applyStep(step.applySql, step.params);
      }
      console.log(JSON.stringify({
        key: step.key,
        label: step.label,
        matched: count,
        changed,
      }, null, 2));
    }

    if (!shouldApply) {
      console.log('Dry run only. Re-run with --apply to make changes.');
    }
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
