import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { chromium, type BrowserContext, type Page } from 'playwright';

const WEB_URL = (process.env.DEFT_WEB_URL || 'http://localhost:3000').replace(/\/$/, '');
const API_URL = (process.env.DEFT_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3301').replace(/\/$/, '');
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'tomato123';

type RunOptions = {
  rehearsal: boolean;
  cleanupAfterRun: boolean;
  cleanupOnlyMarker: string | null;
  cleanupDryRun: boolean;
  cleanupOnlyApply: boolean;
  noCleanup: boolean;
  help: boolean;
};

function readOptionValue(args: string[], name: string): string | null {
  const exact = args.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1).trim() || null;
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1]?.trim() || null;
  return null;
}

function parseOptions(args: string[]): RunOptions {
  const set = new Set(args);
  const cleanupOnlyMarker = readOptionValue(args, '--cleanup-only');
  if (set.has('--cleanup-only') && !cleanupOnlyMarker) {
    throw new Error('Usage: --cleanup-only <DENSE-...|REHEARSAL-...|DEMO-CERT-...>');
  }
  return {
    rehearsal: set.has('--rehearsal'),
    cleanupAfterRun: set.has('--cleanup') && !set.has('--no-cleanup'),
    cleanupOnlyMarker,
    cleanupDryRun: set.has('--dry-run'),
    cleanupOnlyApply: set.has('--apply'),
    noCleanup: set.has('--no-cleanup'),
    help: set.has('--help') || set.has('-h'),
  };
}

const RUN_OPTIONS = parseOptions(process.argv.slice(2));
const RUN_ID = process.env.DEFT_DENSE_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
const RUN_PREFIX = RUN_OPTIONS.rehearsal ? 'REHEARSAL' : 'DENSE';
const GENERATED_MARKER = `${RUN_PREFIX}-${RUN_ID.replace(/[^a-zA-Z0-9]/g, '').slice(-10)}`;
const RUN_MARKER = RUN_OPTIONS.cleanupOnlyMarker || GENERATED_MARKER;
const REPORT_SLUG = RUN_OPTIONS.cleanupOnlyMarker
  ? 'certification-cleanup'
  : RUN_OPTIONS.rehearsal
    ? 'demo-rehearsal-certification'
    : 'dense-human-workflow-certification';
const OUT_DIR = path.resolve('reports', REPORT_SLUG, RUN_ID);
const HTML_REPORT = path.resolve('reports', `${REPORT_SLUG}-${RUN_ID}.html`);
const JSON_REPORT = path.resolve('reports', `${REPORT_SLUG}-${RUN_ID}.json`);

type Auth = {
  accessToken: string;
  org_id?: string;
  org?: { id?: string };
  user: { id: string; email: string; org_id?: string; name?: string };
};

type Space = { id: string; name: string; type?: string };
type Status = 'pass' | 'warn' | 'fail';
type Check = { status: Status; name: string; detail?: unknown; ms?: number };
type ExpectedKind = 'task' | 'decision' | 'resource' | 'note' | 'blocker' | 'update' | 'noise';
type SentMessage = {
  id?: string;
  persona: string;
  email: string;
  space: string;
  space_id: string;
  tag: string;
  expected: ExpectedKind;
  content: string;
  ok: boolean;
  error?: string;
};

type Persona = {
  name: string;
  email: string;
  role: string;
  spaces: string[];
  focus: string;
};

type Artifact = {
  run_id: string;
  marker: string;
  mode: 'dense' | 'rehearsal' | 'cleanup-only';
  web_url: string;
  api_url: string;
  started_at: string;
  finished_at?: string;
  checks: Check[];
  screenshots: Record<string, string>;
  sent_messages: SentMessage[];
  evidence: Record<string, unknown>;
  findings: Array<{ severity: 'P0' | 'P1' | 'P2' | 'P3'; title: string; detail: string }>;
};

const personas: Persona[] = [
  {
    name: 'Diego Vargas',
    email: 'diego@testers-tomatoes.com',
    role: 'Manager',
    spaces: ['field-ops', 'sales-and-buyers', 'marketing'],
    focus: 'buyer launch and operational decisions',
  },
  {
    name: 'Lina Bhattacharya',
    email: 'lina@testers-tomatoes.com',
    role: 'Sales Lead',
    spaces: ['marketing', 'sales-and-buyers', 'buyer-updates'],
    focus: 'buyer objections and launch copy',
  },
  {
    name: 'Marigold Patel',
    email: 'marigold@testers-tomatoes.com',
    role: 'Head Grower',
    spaces: ['field-ops', 'greenhouse', 'harvest-room'],
    focus: 'crop quality and greenhouse status',
  },
  {
    name: 'Cesar Okafor',
    email: 'cesar@testers-tomatoes.com',
    role: 'Field Supervisor',
    spaces: ['field-ops', 'harvest-room', 'operations'],
    focus: 'harvest execution and blockers',
  },
  {
    name: 'Tomas Wakefield',
    email: 'tomas@testers-tomatoes.com',
    role: 'Logistics',
    spaces: ['operations', 'logistics', 'buyer-updates'],
    focus: 'route capacity and cold-chain handoffs',
  },
];

const activePersonas = RUN_OPTIONS.rehearsal
  ? personas.filter((persona) => persona.email === 'diego@testers-tomatoes.com')
  : personas;

const artifact: Artifact = {
  run_id: RUN_ID,
  marker: RUN_MARKER,
  mode: RUN_OPTIONS.cleanupOnlyMarker ? 'cleanup-only' : RUN_OPTIONS.rehearsal ? 'rehearsal' : 'dense',
  web_url: WEB_URL,
  api_url: API_URL,
  started_at: new Date().toISOString(),
  checks: [],
  screenshots: {},
  sent_messages: [],
  evidence: {},
  findings: [],
};

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mark(status: Status, name: string, detail?: unknown, ms?: number) {
  artifact.checks.push({ status, name, detail, ms });
  const suffix = detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : '';
  console.log(`[${status.toUpperCase()}] ${name}${suffix}`);
}

async function step<T>(name: string, fn: () => Promise<T>, warnOnly = false): Promise<T | null> {
  const started = Date.now();
  try {
    const value = await fn();
    mark('pass', name, undefined, Date.now() - started);
    return value;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    mark(warnOnly ? 'warn' : 'fail', name, detail, Date.now() - started);
    if (!warnOnly) throw err;
    return null;
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usage() {
  return `Dense/Rehearsal Deft certification harness

Usage:
  pnpm exec tsx scripts/reports/dense-human-workflow-certification.ts
  pnpm exec tsx scripts/reports/dense-human-workflow-certification.ts --rehearsal --cleanup
  pnpm exec tsx scripts/reports/dense-human-workflow-certification.ts --cleanup-only REHEARSAL-abc123 --dry-run
  pnpm exec tsx scripts/reports/dense-human-workflow-certification.ts --cleanup-only REHEARSAL-abc123 --apply

Flags:
  --rehearsal       Run a compact Diego-led demo rehearsal instead of the 100-message dense swarm.
  --cleanup         After a run, apply marker-scoped DB cleanup for generated artifacts.
  --no-cleanup      Explicitly leave generated artifacts behind.
  --cleanup-only    Only inspect/clean artifacts for a marker. Dry-run unless --apply is present.
  --dry-run         Never mutate during cleanup.
  --apply           Apply cleanup-only mutations.

Cleanup requires DATABASE_URL or DEFT_CLEANUP_DATABASE_URL. For localhost API URLs,
the script may fall back to the local docker Postgres port used by the dev stack.`;
}

function assertSafeMarker(marker: string) {
  if (!/^(DENSE|REHEARSAL|DEMO-CERT)-[A-Za-z0-9-]{6,64}$/.test(marker)) {
    throw new Error(`Refusing unsafe cleanup marker: ${marker}`);
  }
}

function isLocalUrl(url: string) {
  try {
    const parsed = new URL(url);
    return ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

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

function cleanupDatabaseUrl(): string | null {
  if (process.env.DEFT_CLEANUP_DATABASE_URL) return process.env.DEFT_CLEANUP_DATABASE_URL;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (!isLocalUrl(API_URL)) return null;
  const dockerUrl = dockerDatabaseUrl();
  if (dockerUrl) return dockerUrl;
  const password = process.env.POSTGRES_PASSWORD || 'postgres';
  const port = process.env.POSTGRES_PORT || '5432';
  return `postgres://postgres:${encodeURIComponent(password)}@localhost:${port}/deft`;
}

function redactUrl(url: string): string {
  return url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
}

async function fetchJson<T = any>(url: string, init?: RequestInit): Promise<{ status: number; ok: boolean; body: T; text: string }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = text as T;
  }
  return { status: res.status, ok: res.ok, body, text };
}

async function loginApi(email: string): Promise<Auth> {
  const res = await fetchJson<Auth>(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok || !res.body?.accessToken) {
    throw new Error(`API login failed for ${email}: ${res.status} ${res.text.slice(0, 240)}`);
  }
  return res.body;
}

async function api<T = any>(auth: Auth, route: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined;
  const res = await fetchJson<T>(`${API_URL}${route}`, {
    ...init,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${auth.accessToken}`,
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${route} returned ${res.status}: ${res.text.slice(0, 500)}`);
  return res.body;
}

type CleanupCounts = {
  messages: number;
  observations: number;
  work_intents: number;
  agent_actions: number;
  receipts: number;
  tasks: number;
  wiki_pages: number;
  notes: number;
};

type CleanupSummary = {
  marker: string;
  mode: 'skipped' | 'dry-run' | 'apply';
  database?: string;
  before?: CleanupCounts;
  after?: CleanupCounts;
  mutations?: Record<string, number>;
  reason?: string;
};

function zeroCounts(): CleanupCounts {
  return {
    messages: 0,
    observations: 0,
    work_intents: 0,
    agent_actions: 0,
    receipts: 0,
    tasks: 0,
    wiki_pages: 0,
    notes: 0,
  };
}

async function createCleanupTempTables(client: pg.Client, auth: Auth, marker: string) {
  const like = `%${marker}%`;
  const orgId = auth.user.org_id ?? auth.org_id ?? auth.org?.id;
  if (!orgId) throw new Error('Cannot resolve org_id for cleanup from auth response');
  await client.query('create temp table cert_cleanup_messages on commit drop as select id from messages where org_id = $1 and content ilike $2', [orgId, like]);
  await client.query(`
    create temp table cert_cleanup_intents on commit drop as
    select id
    from work_intents
    where org_id = $1
      and (
        source_message_id in (select id from cert_cleanup_messages)
        or coalesce(title, '') ilike $2
        or coalesce(summary, '') ilike $2
        or coalesce(dedupe_key, '') ilike $2
        or coalesce(proposed_params::text, '') ilike $2
        or coalesce(metadata::text, '') ilike $2
      )
  `, [orgId, like]);
  await client.query(`
    create temp table cert_cleanup_actions on commit drop as
    select id
    from agent_actions
    where org_id = $1
      and (
        message_id in (select id from cert_cleanup_messages)
        or coalesce(params::text, '') ilike $2
        or coalesce(result::text, '') ilike $2
        or coalesce(before_state::text, '') ilike $2
        or coalesce(after_state::text, '') ilike $2
        or coalesce(error, '') ilike $2
        or params->>'work_intent_id' in (select id from cert_cleanup_intents)
      )
  `, [orgId, like]);
  await client.query(`
    create temp table cert_cleanup_tasks on commit drop as
    select id
    from tasks
    where org_id = $1
      and (
        source_message_id in (select id from cert_cleanup_messages)
        or id in (select converted_task_id from work_intents where id in (select id from cert_cleanup_intents) and converted_task_id is not null)
        or coalesce(title, '') ilike $2
        or coalesce(description, '') ilike $2
        or coalesce(metadata::text, '') ilike $2
      )
  `, [orgId, like]);
  await client.query(`
    create temp table cert_cleanup_wiki_pages on commit drop as
    select id
    from wiki_pages
    where org_id = $1
      and (
        coalesce(title, '') ilike $2
        or coalesce(slug, '') ilike $2
        or coalesce(summary, '') ilike $2
        or coalesce(content, '') ilike $2
        or coalesce(metadata::text, '') ilike $2
      )
  `, [orgId, like]);
  await client.query(`
    create temp table cert_cleanup_notes on commit drop as
    select id
    from notes
    where org_id = $1
      and (
        coalesce(title, '') ilike $2
        or coalesce(content, '') ilike $2
      )
  `, [orgId, like]);
}

async function readCleanupCounts(client: pg.Client): Promise<CleanupCounts> {
  const result = await client.query(`
    select
      (select count(*)::int from messages m join cert_cleanup_messages cm on cm.id = m.id where m.is_deleted = false) as messages,
      (select count(*)::int from message_observations mo join cert_cleanup_messages cm on cm.id = mo.message_id) as observations,
      (select count(*)::int from work_intents wi join cert_cleanup_intents ci on ci.id = wi.id) as work_intents,
      (select count(*)::int from agent_actions aa join cert_cleanup_actions ca on ca.id = aa.id) as agent_actions,
      (select count(*)::int from action_receipts ar join cert_cleanup_actions ca on ca.id = ar.action_id) as receipts,
      (select count(*)::int from tasks t join cert_cleanup_tasks ct on ct.id = t.id where t.is_deleted = false) as tasks,
      (select count(*)::int from wiki_pages wp join cert_cleanup_wiki_pages cw on cw.id = wp.id where wp.is_deleted = false) as wiki_pages,
      (select count(*)::int from notes n join cert_cleanup_notes cn on cn.id = n.id where n.is_deleted = false) as notes
  `);
  return { ...zeroCounts(), ...(result.rows[0] ?? {}) };
}

async function cleanupRunArtifacts(auth: Auth, options: { marker: string; apply: boolean; reason: string }): Promise<CleanupSummary> {
  assertSafeMarker(options.marker);
  const dbUrl = cleanupDatabaseUrl();
  if (!dbUrl) {
    return {
      marker: options.marker,
      mode: 'skipped',
      reason: 'No DATABASE_URL/DEFT_CLEANUP_DATABASE_URL is configured for this non-local API URL, so marker-scoped DB cleanup was skipped.',
    };
  }

  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query('begin');
    await createCleanupTempTables(client, auth, options.marker);
    const before = await readCleanupCounts(client);
    const summary: CleanupSummary = {
      marker: options.marker,
      mode: options.apply ? 'apply' : 'dry-run',
      database: redactUrl(dbUrl),
      before,
      mutations: {},
      reason: options.reason,
    };

    if (!options.apply) {
      await client.query('rollback');
      summary.after = before;
      return summary;
    }

    const mutations: Record<string, number> = {};
    mutations.receipts_deleted = (await client.query('delete from action_receipts where action_id in (select id from cert_cleanup_actions)')).rowCount ?? 0;
    mutations.observations_deleted = (await client.query('delete from message_observations where message_id in (select id from cert_cleanup_messages)')).rowCount ?? 0;
    mutations.work_intents_deleted = (await client.query('delete from work_intents where id in (select id from cert_cleanup_intents)')).rowCount ?? 0;
    mutations.agent_actions_deleted = (await client.query('delete from agent_actions where id in (select id from cert_cleanup_actions)')).rowCount ?? 0;
    mutations.messages_soft_deleted = (await client.query('update messages set is_deleted = true, updated_at = now() where id in (select id from cert_cleanup_messages) and is_deleted = false')).rowCount ?? 0;
    mutations.tasks_soft_deleted = (await client.query('update tasks set is_deleted = true, updated_at = now() where id in (select id from cert_cleanup_tasks) and is_deleted = false')).rowCount ?? 0;
    mutations.wiki_pages_soft_deleted = (await client.query('update wiki_pages set is_deleted = true, updated_at = now() where id in (select id from cert_cleanup_wiki_pages) and is_deleted = false')).rowCount ?? 0;
    mutations.notes_soft_deleted = (await client.query('update notes set is_deleted = true, updated_at = now() where id in (select id from cert_cleanup_notes) and is_deleted = false')).rowCount ?? 0;
    summary.mutations = mutations;
    summary.after = await readCleanupCounts(client);
    await client.query('commit');
    return summary;
  } catch (err) {
    await client.query('rollback').catch(() => null);
    throw err;
  } finally {
    await client.end().catch(() => null);
  }
}

function asArray<T = any>(value: any, keys: string[] = []): T[] {
  if (Array.isArray(value)) return value;
  for (const key of keys) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [];
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const started = Date.now();
  let last: unknown = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value as T;
      last = value;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}. Last: ${JSON.stringify(last)}`);
}

function tagFor(persona: Persona, index: number, expected: ExpectedKind) {
  const short = persona.name.split(' ')[0].toUpperCase();
  return `${RUN_MARKER}-${short}-${String(index).padStart(2, '0')}-${expected.toUpperCase()}`;
}

function makeMessage(persona: Persona, index: number): { expected: ExpectedKind; content: string; space: string; tag: string } {
  const patterns: ExpectedKind[] = [
    'noise', 'task', 'decision', 'note', 'resource',
    'noise', 'blocker', 'task', 'decision', 'update',
    'noise', 'note', 'resource', 'task', 'decision',
    'noise', 'update', 'blocker', 'note', 'task',
  ];
  const expected = patterns[index % patterns.length]!;
  const tag = tagFor(persona, index + 1, expected);
  const space = persona.spaces[index % persona.spaces.length]!;
  const subject = persona.focus;
  const contentByKind: Record<ExpectedKind, string> = {
    noise: `${tag}: Casual FYI from ${persona.name}. No action needed, no task, no decision, no memory. Just saying the tomato room still smells like tomato room.`,
    task: `${tag}: Please create a P2 task to follow up on the ${RUN_MARKER} launch drill for ${subject}; owner should be ${persona.name}; due tomorrow; include the source message so we know why it exists.`,
    decision: `${tag}: Decision: for the ${RUN_MARKER} launch drill around ${subject}, we will use the Tuesday route promise gate before telling buyers the launch is green. Save this as team knowledge.`,
    resource: `${tag}: Resource: ${subject} checklist lives at https://demo.deft.ing/docs/self-hosting and the working steps are confirm capacity, pack samples, and post the buyer update.`,
    note: `${tag}: Fact: the ${RUN_MARKER} launch drill for ${subject} depends on Sun Gold eight-ounce sample boxes staying below 38F until handoff. Keep this as operating memory.`,
    blocker: `${tag}: Blocked: the ${RUN_MARKER} launch drill for ${subject} cannot move because the cold-room staging count and route-capacity board disagree. Please track the blocker.`,
    update: `${tag}: Update: the ${RUN_MARKER} launch drill for ${subject} moved from waiting to ready-for-review after the morning pass. Keep this status update as context; no new task if the existing task can be updated.`,
  };
  return { expected, content: contentByKind[expected], space, tag };
}

function makeRehearsalMessages(persona: Persona): Array<{ expected: ExpectedKind; content: string; space: string; tag: string }> {
  const firstName = persona.name.split(' ')[0].toUpperCase();
  const rows: Array<{ expected: ExpectedKind; space: string; body: string }> = [
    {
      expected: 'noise',
      space: 'marketing',
      body: 'Quick vibe check only. No task, no decision, no memory: the launch channel can keep the tomato puns contained today.',
    },
    {
      expected: 'blocker',
      space: 'field-ops',
      body: 'Blocked: the buyer launch rehearsal cannot go green because cold-room staging says 42 sample boxes but the route board only has capacity for 36. Please track the blocker from this message.',
    },
    {
      expected: 'task',
      space: 'operations',
      body: 'Please create a P1 task for Tomas to reconcile route capacity against cold-room staging before the Tuesday buyer promise gate. Attach this chat message as the source.',
    },
    {
      expected: 'decision',
      space: 'sales-and-buyers',
      body: 'Decision made: Diego confirms we will not promise the buyer drop until cold-chain capacity and the sample-box count match. Save this as a launch decision in team knowledge.',
    },
    {
      expected: 'resource',
      space: 'buyer-updates',
      body: 'Resource: the buyer launch update needs three bullets: harvest confidence, route-capacity status, and sample-box freshness. Link it back to the rehearsal work record.',
    },
    {
      expected: 'note',
      space: 'greenhouse',
      body: 'Fact: Sun Gold eight-ounce sample boxes must stay below 38F until handoff, and Marigold wants any box above that threshold pulled from the buyer batch.',
    },
    {
      expected: 'update',
      space: 'operations',
      body: 'Update: route capacity is now tentatively aligned after Tomas swapped the downtown stop order. Update existing launch context rather than creating a duplicate task if possible.',
    },
    {
      expected: 'noise',
      space: 'marketing',
      body: 'Small aside only. No action, no task, no decision, no memory: the team is done with rehearsal chatter for now.',
    },
  ];
  return rows.map((row, index) => {
    const tag = `${RUN_MARKER}-${firstName}-${String(index + 1).padStart(2, '0')}-${row.expected.toUpperCase()}`;
    return {
      expected: row.expected,
      space: row.space,
      tag,
      content: `${tag}: ${row.body}`,
    };
  });
}

function buildMessages(persona: Persona) {
  if (RUN_OPTIONS.rehearsal) return makeRehearsalMessages(persona);
  return Array.from({ length: 20 }, (_, i) => makeMessage(persona, i));
}

async function screenshot(page: Page, name: string) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => null);
  artifact.screenshots[name] = file;
}

async function loginUi(page: Page, email: string) {
  await page.goto(`${WEB_URL}/login`, { waitUntil: 'domcontentloaded' });
  // Public/demo Next builds can show the form before client hydration finishes.
  // Wait for the login page to go network-quiet so the React submit handler is
  // attached before we click; otherwise the browser may no-op/reload /login.
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => null);
  await page.locator('#login-email').waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(PASSWORD);
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().includes('/api/auth/login'),
    { timeout: 30_000 },
  );
  await Promise.all([
    responsePromise,
    page.getByRole('button', { name: /^sign in$/i }).click(),
  ]);
  const response = await responsePromise;
  if (response.status() >= 400) throw new Error(`UI login failed for ${email}: ${response.status()}`);
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 45_000 });
  await page.locator('main').waitFor({ state: 'visible', timeout: 20_000 });
}

async function sendUiMessage(page: Page, space: Space, message: { expected: ExpectedKind; content: string; space: string; tag: string }, persona: Persona): Promise<SentMessage> {
  const sent: SentMessage = {
    persona: persona.name,
    email: persona.email,
    space: space.name,
    space_id: space.id,
    tag: message.tag,
    expected: message.expected,
    content: message.content,
    ok: false,
  };

  try {
    await page.goto(`${WEB_URL}/chat?space=${encodeURIComponent(space.id)}`, { waitUntil: 'domcontentloaded' });
    await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
    const editor = page.locator('[contenteditable="true"].deft-editor').last();
    await editor.waitFor({ state: 'visible', timeout: 25_000 });
    await editor.fill(message.content);
    const sendButton = page.getByRole('button', { name: /send message/i }).last();
    await waitFor('send button enabled', async () => {
      const disabled = await sendButton.evaluate((button) => (button as HTMLButtonElement).disabled).catch(() => true);
      return disabled ? null : true;
    }, { timeoutMs: 10_000, intervalMs: 250 });
    const post = page.waitForResponse(
      (response) => {
        if (response.request().method() !== 'POST') return false;
        try {
          const url = new URL(response.url());
          return url.pathname === `/api/messages/${space.id}` || url.pathname.startsWith(`/api/messages/${space.id}/`);
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    );
    await sendButton.click();
    const response = await post;
    if (response.status() >= 400) {
      const body = await response.text().catch(() => '');
      throw new Error(`send failed ${response.status()}: ${body.slice(0, 200)}`);
    }
    const body = await response.json().catch(() => null);
    sent.id = body?.id;
    sent.ok = true;
  } catch (err) {
    sent.error = err instanceof Error ? err.message : String(err);
  }
  artifact.sent_messages.push(sent);
  return sent;
}

async function sendPersonaBatch(context: BrowserContext, persona: Persona, spacesByName: Map<string, Space>) {
  const page = await context.newPage();
  const consoleIssues: string[] = [];
  page.on('console', (msg) => {
    if (['error', 'warning'].includes(msg.type())) consoleIssues.push(`${msg.type()}: ${msg.text()}`);
  });
  await loginUi(page, persona.email);
  await screenshot(page, `login-${persona.email.split('@')[0]}`);

  const messages = buildMessages(persona);
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    const space = spacesByName.get(message.space) ?? spacesByName.values().next().value;
    if (!space) throw new Error(`No space found for ${message.space}`);
    await sendUiMessage(page, space, message, persona);
    await delay(150 + ((i + persona.name.length) % 5) * 80);
  }
  await screenshot(page, `after-messages-${persona.email.split('@')[0]}`);
  return { persona: persona.name, consoleIssues };
}

async function sendLoggedPersonaMessages(page: Page, persona: Persona, spacesByName: Map<string, Space>) {
  const messages = buildMessages(persona);
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    const space = spacesByName.get(message.space) ?? spacesByName.values().next().value;
    if (!space) throw new Error(`No space found for ${message.space}`);
    await sendUiMessage(page, space, message, persona);
    await delay(150 + ((i + persona.name.length) % 5) * 80);
  }
  await screenshot(page, `after-messages-${persona.email.split('@')[0]}`);
}

async function getSpaces(auth: Auth): Promise<Space[]> {
  const body = await api<any>(auth, '/api/spaces');
  return asArray<Space>(body, ['spaces']);
}

async function getRunIntents(auth: Auth) {
  const body = await api<any>(auth, '/api/work-intents?limit=100');
  const runMessageIds = new Set(artifact.sent_messages.map((message) => message.id).filter(Boolean));
  return asArray<any>(body, ['intents']).filter((intent) =>
    (intent.source_message_id && runMessageIds.has(intent.source_message_id))
    || JSON.stringify(intent).includes(RUN_MARKER)
  );
}

async function getRunActions(auth: Auth) {
  const body = await api<any>(auth, '/api/agent/actions');
  const runMessageIds = new Set(artifact.sent_messages.map((message) => message.id).filter(Boolean));
  return asArray<any>(body).filter((action) => {
    const params = action.params && typeof action.params === 'object' ? action.params : {};
    return JSON.stringify(action).includes(RUN_MARKER)
      || (params.source_message_id && runMessageIds.has(params.source_message_id))
      || (params.origin_message_id && runMessageIds.has(params.origin_message_id));
  });
}

async function getRunObservations(auth: Auth) {
  const body = await api<any>(
    auth,
    `/api/work-intents/observations?limit=500&marker=${encodeURIComponent(RUN_MARKER)}`,
  );
  const runMessageIds = new Set(artifact.sent_messages.map((message) => message.id).filter(Boolean));
  return asArray<any>(body, ['observations']).filter((observation) =>
    observation.message_id && runMessageIds.has(observation.message_id)
  );
}

function summarizeCaptures(intents: any[]) {
  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const intent of intents) {
    byKind[intent.kind] = (byKind[intent.kind] || 0) + 1;
    byStatus[intent.status] = (byStatus[intent.status] || 0) + 1;
  }
  return { byKind, byStatus };
}

function summarizeObservations(observations: any[]) {
  const byStatus: Record<string, number> = {};
  const byIgnoredReason: Record<string, number> = {};
  for (const observation of observations) {
    byStatus[observation.status] = (byStatus[observation.status] || 0) + 1;
    if (observation.ignored_reason) {
      byIgnoredReason[observation.ignored_reason] = (byIgnoredReason[observation.ignored_reason] || 0) + 1;
    }
  }
  return { byStatus, byIgnoredReason };
}

function expectedMatches(kind: ExpectedKind, intentKind: string) {
  if (kind === 'task') return intentKind === 'task_candidate';
  if (kind === 'decision') return intentKind === 'decision_candidate';
  if (kind === 'resource') return intentKind === 'resource_candidate';
  if (kind === 'note') return intentKind === 'note_candidate';
  if (kind === 'blocker') return intentKind === 'blocker_candidate' || intentKind === 'task_candidate';
  if (kind === 'update') return intentKind === 'task_candidate' || intentKind === 'note_candidate';
  return false;
}

function normalizedRepeatKey(message: SentMessage) {
  const body = message.content
    .replace(/^(DENSE|REHEARSAL)-[^:]+:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return `${message.expected}:${body}`;
}

function observationReachedTerminal(observation: any | undefined) {
  return observation && ['ignored', 'no_capture', 'captured'].includes(observation.status);
}

function observationRoutedForExpected(kind: ExpectedKind, observation: any | undefined) {
  const jobs = Array.isArray(observation?.downstream_jobs) ? observation.downstream_jobs : [];
  const names = new Set(jobs.map((job: any) => job?.name).filter(Boolean));
  if (kind === 'task') return names.has('task-extract');
  if (kind === 'blocker') return names.has('blocked-alert');
  if (kind === 'decision' || kind === 'resource' || kind === 'note') return names.has('memory-capture');
  if (kind === 'update') return names.has('task-extract') || names.has('memory-capture');
  return false;
}

function classifyCoverage(intents: any[], observations: any[]) {
  const byMessageId = new Map<string, any[]>();
  for (const intent of intents) {
    if (intent.source_message_id) {
      const list = byMessageId.get(intent.source_message_id) ?? [];
      list.push(intent);
      byMessageId.set(intent.source_message_id, list);
    }
  }
  const observationsByMessageId = new Map<string, any>();
  for (const observation of observations) {
    if (observation.message_id) observationsByMessageId.set(observation.message_id, observation);
  }
  const sentOk = artifact.sent_messages.filter((message) => message.ok && message.id);
  const baseRows = sentOk.map((message) => {
    const captures = byMessageId.get(message.id!) ?? [];
    const directMatched = message.expected === 'noise'
      ? captures.length === 0
      : captures.some((intent) => expectedMatches(message.expected, intent.kind));
    const observation = observationsByMessageId.get(message.id!);
    return {
      tag: message.tag,
      expected: message.expected,
      message_id: message.id,
      captures: captures.map((intent) => `${intent.kind}:${intent.status}`),
      direct_matched: directMatched,
      repeat_key: normalizedRepeatKey(message),
      observation_status: observation?.status ?? null,
      downstream_jobs: Array.isArray(observation?.downstream_jobs)
        ? observation.downstream_jobs.map((job: any) => job?.name).filter(Boolean)
        : [],
    };
  });
  const directMatchedRepeatKeys = new Set(
    baseRows
      .filter((row) => row.expected !== 'noise' && row.direct_matched)
      .map((row) => row.repeat_key),
  );
  const rows = baseRows.map((row) => {
    const observation = observationsByMessageId.get(row.message_id!);
    const dedupedRepeat = row.expected !== 'noise'
      && !row.direct_matched
      && directMatchedRepeatKeys.has(row.repeat_key)
      && observationReachedTerminal(observation)
      && observationRoutedForExpected(row.expected, observation);
    const matched = row.expected === 'noise'
      ? row.direct_matched
      : row.direct_matched || dedupedRepeat;
    return {
      tag: row.tag,
      expected: row.expected,
      message_id: row.message_id,
      captures: row.captures,
      observation_status: row.observation_status,
      downstream_jobs: row.downstream_jobs,
      matched,
      matched_via: row.direct_matched ? 'capture' : dedupedRepeat ? 'deduped_repeat' : 'miss',
    };
  });
  const expectedRows = rows.filter((row) => row.expected !== 'noise');
  const noiseRows = rows.filter((row) => row.expected === 'noise');
  const falseNegatives = expectedRows.filter((row) => !row.matched);
  const falsePositives = noiseRows.filter((row) => !row.matched);
  const dedupedRepeatCount = rows.filter((row) => row.matched_via === 'deduped_repeat').length;
  return {
    rows,
    expected_count: expectedRows.length,
    noise_count: noiseRows.length,
    matched_expected: expectedRows.length - falseNegatives.length,
    false_negative_count: falseNegatives.length,
    false_positive_count: falsePositives.length,
    deduped_repeat_count: dedupedRepeatCount,
    false_negatives: falseNegatives.slice(0, 20),
    false_positives: falsePositives.slice(0, 20),
  };
}

async function approveSomeViaUi(page: Page) {
  await page.goto(`${WEB_URL}/inbox?tab=captures`, { waitUntil: 'domcontentloaded' });
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  await screenshot(page, 'captures-before-dense-approvals');
  const targets = ['Create task', 'Create task', 'Save decision', 'Save resource', 'Save knowledge'];
  let clicked = 0;
  for (const buttonText of targets) {
    const didClick = await page.evaluate(({ marker, buttonText }) => {
      const target = buttonText.toLowerCase();
      for (const button of Array.from(document.querySelectorAll('button'))) {
        const label = `${button.textContent || ''} ${button.getAttribute('aria-label') || ''}`.trim().toLowerCase();
        if (label !== target) continue;
        let node: HTMLElement | null = button;
        for (let i = 0; i < 12 && node; i += 1) {
          if ((node.textContent || '').includes(marker)) {
            button.click();
            return true;
          }
          node = node.parentElement;
        }
      }
      return false;
    }, { marker: RUN_MARKER, buttonText });
    if (didClick) {
      clicked += 1;
      await delay(1_400);
    }
  }
  await screenshot(page, 'captures-after-dense-approvals');
  artifact.evidence.approval_clicks = clicked;
  if (clicked === 0) {
    artifact.findings.push({
      severity: 'P1',
      title: 'No dense-run captures could be approved in the UI',
      detail: 'The test found capture proposals but could not click any run-scoped approval card.',
    });
  }
}

async function createAndPromoteNote(page: Page, auth: Auth) {
  await page.goto(`${WEB_URL}/notes`, { waitUntil: 'domcontentloaded' });
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  await screenshot(page, 'notes-before-dense-note');
  const createResponse = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().includes('/api/daily-notes'),
    { timeout: 20_000 },
  ).catch(() => null);
  await page.getByRole('button', { name: /new note/i }).first().click();
  const blankNote = page.getByRole('button', { name: /blank note/i }).first();
  if (await blankNote.isVisible().catch(() => false)) await blankNote.click();
  const created = await createResponse;
  if (created && created.status() >= 400) throw new Error(`New note failed with ${created.status()}`);
  await page.waitForTimeout(1_500);
  const noteTitle = `Dense manager field note ${RUN_MARKER}`;
  await page.locator('input[placeholder="Untitled"]').first().fill(noteTitle);
  const editor = page.locator('[contenteditable="true"].deft-notes-editor').first();
  await editor.waitFor({ state: 'visible', timeout: 20_000 });
  await editor.fill(`Dense note ${RUN_MARKER}: Diego recorded that route capacity, Sun Gold sample boxes, and buyer-copy timing must stay connected in the workspace memory before launch.`);
  await delay(2_000);
  await screenshot(page, 'notes-dense-note-before-promote');
  await page.getByRole('button', { name: /promote to wiki/i }).first().click();
  await page.getByRole('button', { name: /^fact$/i }).click();
  page.once('dialog', async (dialog) => { await dialog.accept(); });
  await page.getByRole('button', { name: /^promote$/i }).click();
  await delay(1_500);
  const wiki = await waitFor<any>('dense promoted note searchable', async () => {
    const body = await api<any>(auth, `/api/wiki?q=${encodeURIComponent(noteTitle)}&limit=10`);
    const pages = asArray<any>(body, ['pages']);
    return pages.find((page) => page.title === noteTitle || JSON.stringify(page).includes(RUN_MARKER)) ? { pages, body } : null;
  }, { timeoutMs: 45_000, intervalMs: 2_000 });
  artifact.evidence.promoted_note = wiki.pages.map((page: any) => ({ id: page.id, title: page.title, slug: page.slug, type: page.type }));
  await page.goto(`${WEB_URL}/knowledge`, { waitUntil: 'domcontentloaded' });
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  const search = page.locator('input[placeholder*="Search"], input[placeholder*="search"]').first();
  if (await search.isVisible().catch(() => false)) await search.fill(RUN_MARKER);
  await delay(800);
  await screenshot(page, 'knowledge-after-dense-note');
}

async function verifyReceipts(auth: Auth, actionIds: string[]) {
  const results = [];
  for (const id of actionIds) {
    try {
      const receipt = await api<any>(auth, `/api/agent/actions/${id}/receipt`);
      results.push({ action_id: id, ok: Boolean(receipt.verified), decision: receipt.receipt?.decision, action: receipt.receipt?.action_name });
    } catch (err) {
      results.push({ action_id: id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

function addFindings(
  coverage: ReturnType<typeof classifyCoverage>,
  sentCount: number,
  failedSends: SentMessage[],
  intents: any[],
  actions: any[],
  receipts: any[],
  observations: any[],
) {
  if (failedSends.length > 0) {
    artifact.findings.push({
      severity: 'P1',
      title: 'Some human-like UI sends failed',
      detail: `${failedSends.length}/${sentCount} sends failed. First: ${failedSends[0]?.error}`,
    });
  }
  const sentOk = artifact.sent_messages.filter((message) => message.ok && message.id);
  const observedIds = new Set(observations.map((observation) => observation.message_id).filter(Boolean));
  const missingObservationCount = sentOk.filter((message) => !observedIds.has(message.id)).length;
  if (missingObservationCount > 0) {
    artifact.findings.push({
      severity: 'P1',
      title: 'Some UI-created messages were not durably observed',
      detail: `${missingObservationCount}/${sentOk.length} sent messages did not have message_observations rows.`,
    });
  }
  const incompleteObservations = observations.filter((observation) =>
    ['queued', 'processing', 'retrying', 'failed'].includes(observation.status)
  );
  if (incompleteObservations.length > 0) {
    artifact.findings.push({
      severity: incompleteObservations.some((observation) => observation.status === 'failed') ? 'P1' : 'P2',
      title: 'Some observations did not finish cleanly',
      detail: JSON.stringify(incompleteObservations.slice(0, 8).map((observation) => ({
        message_id: observation.message_id,
        status: observation.status,
        error: observation.last_error,
      }))),
    });
  }
  if (coverage.false_positive_count > 0) {
    artifact.findings.push({
      severity: 'P1',
      title: 'No-action messages still become Defty captures',
      detail: `${coverage.false_positive_count}/${coverage.noise_count} explicit no-action/no-memory messages produced captures.`,
    });
  }
  const fnRate = coverage.expected_count ? coverage.false_negative_count / coverage.expected_count : 0;
  if (fnRate > 0.2) {
    artifact.findings.push({
      severity: 'P1',
      title: 'Capture recall is too inconsistent under realistic chatter',
      detail: `${coverage.false_negative_count}/${coverage.expected_count} non-noise messages did not produce the expected capture kind.`,
    });
  } else if (coverage.false_negative_count > 0) {
    artifact.findings.push({
      severity: 'P2',
      title: 'Some expected captures were missed',
      detail: `${coverage.false_negative_count}/${coverage.expected_count} expected work/memory messages missed their expected capture kind.`,
    });
  }
  const verifiedReceiptCount = receipts.filter((receipt) => receipt.ok).length;
  if (verifiedReceiptCount === 0 && actions.length < intents.filter((intent) => intent.status === 'proposed').length * 0.5) {
    artifact.findings.push({
      severity: 'P2',
      title: 'Not every proposed work intent surfaced as an approval action',
      detail: `${intents.length} run-scoped intents produced ${actions.length} run-scoped actions in the latest action list.`,
    });
  } else if (verifiedReceiptCount > actions.length) {
    artifact.findings.push({
      severity: 'P3',
      title: 'Action-list marker evidence undercounts approved actions',
      detail: `The action list returned ${actions.length} run-scoped action(s), but converted intents and receipts verified ${verifiedReceiptCount} approved action(s). This looks like a test-evidence query limitation, not a failed approval path.`,
    });
  }
  if (receipts.some((receipt) => !receipt.ok)) {
    artifact.findings.push({
      severity: 'P1',
      title: 'One or more approved actions lack verified receipts',
      detail: JSON.stringify(receipts.filter((receipt) => !receipt.ok).slice(0, 5)),
    });
  }
}

async function writeReport() {
  artifact.finished_at = new Date().toISOString();
  await fs.mkdir(path.dirname(HTML_REPORT), { recursive: true });
  await fs.writeFile(JSON_REPORT, JSON.stringify(artifact, null, 2));

  const rel = (file: string) => path.relative(path.dirname(HTML_REPORT), file).replace(/\\/g, '/');
  const counts = artifact.checks.reduce((acc, check) => {
    acc[check.status] = (acc[check.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const metrics = artifact.evidence.metrics as any;
  const coverage = artifact.evidence.coverage as any;
  const captureSummary = artifact.evidence.capture_summary as any;
  const observationSummary = artifact.evidence.observation_summary as any;
  const reportTitle = RUN_OPTIONS.rehearsal
    ? 'Demo Rehearsal Certification'
    : RUN_OPTIONS.cleanupOnlyMarker
      ? 'Certification Cleanup Report'
      : 'Dense Deft Human Workflow Certification';
  const reportKicker = RUN_OPTIONS.rehearsal
    ? 'Compact UI-first demo rehearsal'
    : RUN_OPTIONS.cleanupOnlyMarker
      ? 'Marker-scoped cleanup'
      : 'Dense multi-user UI-first dogfood';

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(reportTitle)} - ${escapeHtml(RUN_MARKER)}</title>
  <style>
    :root { color-scheme: light; --ink:#191714; --muted:#716a60; --line:#ddd5c8; --paper:#faf7ef; --card:#fffdf8; --green:#168a5b; --amber:#a86700; --red:#bf3b2f; --accent:#6f5fda; }
    body { margin:0; background:var(--paper); color:var(--ink); font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height:1.45; }
    main { max-width:1180px; margin:0 auto; padding:42px 24px 72px; }
    h1 { margin:0 0 10px; font-size:36px; line-height:1.03; letter-spacing:0; }
    h2 { margin:34px 0 12px; font-size:21px; }
    p { color:var(--muted); max-width:900px; }
    .hero,.card,table,figure,pre { border:1px solid var(--line); background:var(--card); border-radius:8px; }
    .hero { padding:28px; }
    .pill { display:inline-flex; padding:5px 10px; border:1px solid var(--line); border-radius:999px; background:#fff; color:var(--muted); font-size:12px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; }
    .card { padding:16px; }
    .metric { font-size:28px; font-weight:760; color:var(--ink); }
    table { width:100%; border-collapse:collapse; overflow:hidden; }
    th,td { text-align:left; vertical-align:top; padding:11px 12px; border-bottom:1px solid var(--line); font-size:13px; }
    th { background:#f3eee5; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
    tr:last-child td { border-bottom:0; }
    .pass { color:var(--green); font-weight:750; }
    .warn { color:var(--amber); font-weight:750; }
    .fail { color:var(--red); font-weight:750; }
    .screens { display:grid; grid-template-columns:repeat(auto-fit,minmax(310px,1fr)); gap:14px; }
    figure { margin:0; overflow:hidden; }
    figure img { width:100%; display:block; background:#111; }
    figcaption { padding:9px 11px; color:var(--muted); font-size:12px; border-top:1px solid var(--line); }
    pre { white-space:pre-wrap; overflow-wrap:anywhere; padding:14px; font-size:12px; color:#38312a; }
    code { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  </style>
</head>
<body>
<main>
  <section class="hero">
    <span class="pill">${escapeHtml(reportKicker)}</span>
    <h1>${escapeHtml(reportTitle)}</h1>
    <p>Run marker <code>${escapeHtml(RUN_MARKER)}</code>. Mode <code>${escapeHtml(artifact.mode)}</code>. Seeded employees used real browser sessions against <code>${escapeHtml(WEB_URL)}</code>, posted a total of ${metrics?.attempted_messages ?? 0} tagged messages across several spaces, then Defty captures, approvals, receipts, notes, and wiki search were verified where applicable.</p>
    <div class="grid">
      <div class="card"><div class="metric">${metrics?.sent_messages ?? 0}/${metrics?.attempted_messages ?? 0}</div><span>UI chat sends succeeded</span></div>
      <div class="card"><div class="metric">${metrics?.completed_observation_count ?? 0}/${metrics?.sent_messages ?? 0}</div><span>Messages durably observed</span></div>
      <div class="card"><div class="metric">${metrics?.intent_count ?? 0}</div><span>Run-scoped work intents</span></div>
      <div class="card"><div class="metric">${coverage?.matched_expected ?? 0}/${coverage?.expected_count ?? 0}</div><span>Expected captures matched</span></div>
      <div class="card"><div class="metric">${coverage?.deduped_repeat_count ?? 0}</div><span>Repeated work messages deduped</span></div>
      <div class="card"><div class="metric">${coverage?.false_positive_count ?? 0}/${coverage?.noise_count ?? 0}</div><span>No-action messages over-captured</span></div>
    </div>
  </section>

  <h2>Verdict</h2>
  <table>
    <thead><tr><th>Area</th><th>Status</th><th>Evidence</th></tr></thead>
    <tbody>
      <tr><td>Multi-user chat realism</td><td class="${(metrics?.failed_sends ?? 0) === 0 ? 'pass' : 'fail'}">${(metrics?.failed_sends ?? 0) === 0 ? 'Passed' : 'Failed'}</td><td>${metrics?.sent_messages ?? 0} messages posted through UI; ${metrics?.failed_sends ?? 0} failed sends.</td></tr>
      <tr><td>Durable observation</td><td class="${(metrics?.completed_observation_count ?? 0) === (metrics?.sent_messages ?? -1) ? 'pass' : 'fail'}">${(metrics?.completed_observation_count ?? 0) === (metrics?.sent_messages ?? -1) ? 'Passed' : 'Incomplete'}</td><td>${metrics?.completed_observation_count ?? 0}/${metrics?.sent_messages ?? 0} sent messages reached a terminal observation state.</td></tr>
      <tr><td>Chat becomes context</td><td class="${(coverage?.false_negative_count ?? 0) === 0 ? 'pass' : 'warn'}">${(coverage?.false_negative_count ?? 0) === 0 ? 'Strong' : 'Partial'}</td><td>${coverage?.matched_expected ?? 0}/${coverage?.expected_count ?? 0} non-noise messages produced expected capture kinds.</td></tr>
      <tr><td>Noise guardrails</td><td class="${(coverage?.false_positive_count ?? 0) === 0 ? 'pass' : 'fail'}">${(coverage?.false_positive_count ?? 0) === 0 ? 'Passed' : 'Needs work'}</td><td>${coverage?.false_positive_count ?? 0}/${coverage?.noise_count ?? 0} explicit no-action messages produced captures.</td></tr>
      <tr><td>Approvals and receipts</td><td class="${(artifact.evidence.receipts as any[])?.every((r) => r.ok) ? 'pass' : 'warn'}">Checked</td><td>${(artifact.evidence.receipts as any[])?.length ?? 0} approved actions checked for receipts.</td></tr>
      <tr><td>Notes become memory</td><td class="${artifact.evidence.promoted_note ? 'pass' : 'fail'}">${artifact.evidence.promoted_note ? 'Passed' : 'Not proven'}</td><td>Manager note promoted to wiki and found through wiki search.</td></tr>
    </tbody>
  </table>

  <h2>Findings</h2>
  ${artifact.findings.length === 0 ? '<p>No blocker findings from this run.</p>' : `<table><thead><tr><th>Severity</th><th>Issue</th><th>Detail</th></tr></thead><tbody>${artifact.findings.map((finding) => `<tr><td class="${finding.severity === 'P1' || finding.severity === 'P0' ? 'fail' : finding.severity === 'P2' ? 'warn' : ''}">${escapeHtml(finding.severity)}</td><td>${escapeHtml(finding.title)}</td><td>${escapeHtml(finding.detail)}</td></tr>`).join('')}</tbody></table>`}

  <h2>Cleanup</h2>
  <pre>${escapeHtml(JSON.stringify(artifact.evidence.cleanup ?? {
    mode: RUN_OPTIONS.noCleanup ? 'disabled by --no-cleanup' : RUN_OPTIONS.cleanupAfterRun ? 'not run yet' : 'not requested',
  }, null, 2))}</pre>

  <h2>Capture Summary</h2>
  <div class="grid">
    <div class="card"><strong>By kind</strong><pre>${escapeHtml(JSON.stringify(captureSummary?.byKind ?? {}, null, 2))}</pre></div>
    <div class="card"><strong>By status</strong><pre>${escapeHtml(JSON.stringify(captureSummary?.byStatus ?? {}, null, 2))}</pre></div>
    <div class="card"><strong>Observations by status</strong><pre>${escapeHtml(JSON.stringify(observationSummary?.byStatus ?? {}, null, 2))}</pre></div>
    <div class="card"><strong>Ignored reasons</strong><pre>${escapeHtml(JSON.stringify(observationSummary?.byIgnoredReason ?? {}, null, 2))}</pre></div>
  </div>

  <h2>Screenshots</h2>
  <div class="screens">
    ${Object.entries(artifact.screenshots).slice(0, 12).map(([name, file]) => `<figure><img src="${escapeHtml(rel(file))}" alt="${escapeHtml(name)}"><figcaption>${escapeHtml(name)}</figcaption></figure>`).join('')}
  </div>

  <h2>Coverage Detail</h2>
  <pre>${escapeHtml(JSON.stringify({
    metrics,
    observation_summary: observationSummary,
    coverage: {
      expected_count: coverage?.expected_count,
      matched_expected: coverage?.matched_expected,
      false_negative_count: coverage?.false_negative_count,
      false_positive_count: coverage?.false_positive_count,
      deduped_repeat_count: coverage?.deduped_repeat_count,
      false_negatives: coverage?.false_negatives,
      false_positives: coverage?.false_positives,
    },
    receipts: artifact.evidence.receipts,
    promoted_note: artifact.evidence.promoted_note,
  }, null, 2))}</pre>
</main>
</body>
</html>`;

  await fs.writeFile(HTML_REPORT, html);
  console.log(`HTML_REPORT=${HTML_REPORT}`);
  console.log(`JSON_REPORT=${JSON_REPORT}`);
}

let reportAlreadyWritten = false;

async function writeReportOnce() {
  if (reportAlreadyWritten) return;
  await writeReport();
  reportAlreadyWritten = true;
}

async function main() {
  if (RUN_OPTIONS.help) {
    console.log(usage());
    return;
  }

  if (RUN_OPTIONS.cleanupOnlyMarker) {
    assertSafeMarker(RUN_MARKER);
    await fs.mkdir(OUT_DIR, { recursive: true });
    const auth = await step('Manager API login works for cleanup', () => loginApi(process.env.DEFT_TEST_EMAIL || 'diego@testers-tomatoes.com')) as Auth;
    const apply = RUN_OPTIONS.cleanupOnlyApply && !RUN_OPTIONS.cleanupDryRun;
    const cleanup = await step(
      apply ? `Apply marker-scoped cleanup for ${RUN_MARKER}` : `Dry-run marker-scoped cleanup for ${RUN_MARKER}`,
      () => cleanupRunArtifacts(auth, { marker: RUN_MARKER, apply, reason: 'cleanup-only' }),
    );
    artifact.evidence.cleanup = cleanup;
    await writeReportOnce();
    return;
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const contexts: BrowserContext[] = [];
  let cleanupAuth: Auth | null = null;
  try {
    const managerAuth = await step('Manager API login works', () => loginApi('diego@testers-tomatoes.com')) as Auth;
    cleanupAuth = managerAuth;
    const spaces = await step('Load workspace spaces', () => getSpaces(managerAuth)) as Space[];
    const spacesByName = new Map(spaces.map((space) => [space.name, space]));
    artifact.evidence.spaces_used = Array.from(new Set(activePersonas.flatMap((persona) => persona.spaces))).filter((name) => spacesByName.has(name));

    const sessions = await step(RUN_OPTIONS.rehearsal ? 'Log in Diego demo browser session' : 'Log in five human browser sessions', async () => {
      const logged: Array<{ persona: Persona; page: Page; consoleIssues: string[] }> = [];
      for (const persona of activePersonas) {
        const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
        contexts.push(context);
        const page = await context.newPage();
        const consoleIssues: string[] = [];
        page.on('console', (msg) => {
          if (['error', 'warning'].includes(msg.type())) consoleIssues.push(`${msg.type()}: ${msg.text()}`);
        });
        await loginUi(page, persona.email);
        await screenshot(page, `login-${persona.email.split('@')[0]}`);
        logged.push({ persona, page, consoleIssues });
      }
      return logged;
    }) as Array<{ persona: Persona; page: Page; consoleIssues: string[] }>;

    await step(RUN_OPTIONS.rehearsal ? 'Run compact Diego demo rehearsal through UI chat' : 'Run five concurrent human UI chat sessions', async () => {
      await Promise.all(sessions.map(({ page, persona }) => sendLoggedPersonaMessages(page, persona, spacesByName)));
    });

    const failedSends = artifact.sent_messages.filter((message) => !message.ok);
    const sentOk = artifact.sent_messages.filter((message) => message.ok);
    artifact.evidence.metrics = {
      attempted_messages: artifact.sent_messages.length,
      sent_messages: sentOk.length,
      failed_sends: failedSends.length,
      personas: activePersonas.length,
      spaces: artifact.evidence.spaces_used,
    };

    const captureBundle = await step('Wait for Defty observations and captures after dense traffic', () => waitFor('dense observations and work intents', async () => {
      const observations = await getRunObservations(managerAuth);
      const intents = await getRunIntents(managerAuth);
      const nonNoiseSent = sentOk.filter((message) => message.expected !== 'noise').length;
      const allObserved = observations.length >= sentOk.length &&
        observations.every((observation) => ['ignored', 'no_capture', 'captured'].includes(observation.status));
      const minCaptureCount = RUN_OPTIONS.rehearsal
        ? Math.max(4, Math.floor(nonNoiseSent * 0.75))
        : Math.max(8, Math.floor(nonNoiseSent * 0.25));
      const enoughCaptures = intents.length >= minCaptureCount;
      return allObserved && enoughCaptures ? { intents, observations } : null;
    }, { timeoutMs: 180_000, intervalMs: 5_000 }), true) as any | null;

    const intents = Array.isArray(captureBundle)
      ? captureBundle
      : (captureBundle?.intents ?? await getRunIntents(managerAuth));
    const observations = Array.isArray(captureBundle)
      ? await getRunObservations(managerAuth)
      : (captureBundle?.observations ?? await getRunObservations(managerAuth));
    const actions = await getRunActions(managerAuth);
    const coverage = classifyCoverage(intents, observations);
    const captureSummary = summarizeCaptures(intents);
    const observationSummary = summarizeObservations(observations);
    artifact.evidence.capture_summary = captureSummary;
    artifact.evidence.observation_summary = observationSummary;
    artifact.evidence.coverage = coverage;
    artifact.evidence.metrics = {
      ...(artifact.evidence.metrics as Record<string, unknown>),
      observation_count: observations.length,
      completed_observation_count: observations.filter((observation) => ['ignored', 'no_capture', 'captured'].includes(observation.status)).length,
      intent_count: intents.length,
      action_count: actions.length,
      expected_capture_count: coverage.expected_count,
      matched_expected: coverage.matched_expected,
      false_negative_count: coverage.false_negative_count,
      false_positive_count: coverage.false_positive_count,
      deduped_repeat_count: coverage.deduped_repeat_count,
    };

    const managerContext = await browser.newContext({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 });
    contexts.push(managerContext);
    const managerPage = await managerContext.newPage();
    await loginUi(managerPage, 'diego@testers-tomatoes.com');
    await step('Approve representative dense captures through UI', () => approveSomeViaUi(managerPage), true);

    await delay(2_500);
    const finalIntents = await getRunIntents(managerAuth);
    const finalActions = await getRunActions(managerAuth);
    const finalObservations = await getRunObservations(managerAuth);
    const finalCoverage = classifyCoverage(finalIntents, finalObservations);
    const finalCaptureSummary = summarizeCaptures(finalIntents);
    const finalObservationSummary = summarizeObservations(finalObservations);
    artifact.evidence.capture_summary = finalCaptureSummary;
    artifact.evidence.observation_summary = finalObservationSummary;
    artifact.evidence.coverage = finalCoverage;
    artifact.evidence.metrics = {
      ...(artifact.evidence.metrics as Record<string, unknown>),
      observation_count: finalObservations.length,
      completed_observation_count: finalObservations.filter((observation) => ['ignored', 'no_capture', 'captured'].includes(observation.status)).length,
      intent_count: finalIntents.length,
      action_count: finalActions.length,
      expected_capture_count: finalCoverage.expected_count,
      matched_expected: finalCoverage.matched_expected,
      false_negative_count: finalCoverage.false_negative_count,
      false_positive_count: finalCoverage.false_positive_count,
      deduped_repeat_count: finalCoverage.deduped_repeat_count,
    };
    const approvedActionIds = Array.from(new Set([
      ...finalActions.filter((action) => action.approval_status === 'approved').map((action) => action.id),
      ...finalIntents.map((intent) => intent.converted_action_id).filter((id): id is string => typeof id === 'string'),
    ])).slice(0, 12);
    const receipts = await verifyReceipts(managerAuth, approvedActionIds);
    artifact.evidence.final_intents = finalIntents.map((intent) => ({
      id: intent.id,
      kind: intent.kind,
      status: intent.status,
      source_message_id: intent.source_message_id,
      converted_action_id: intent.converted_action_id,
      converted_task_id: intent.converted_task_id,
      title: intent.title,
    }));
    artifact.evidence.final_actions = finalActions.map((action) => ({
      id: action.id,
      action: action.action,
      approval_status: action.approval_status,
      has_receipt: action.has_receipt,
    }));
    artifact.evidence.final_observations = finalObservations.map((observation) => ({
      id: observation.id,
      message_id: observation.message_id,
      status: observation.status,
      ignored_reason: observation.ignored_reason,
      capture_count: observation.capture_count,
      downstream_jobs: observation.downstream_jobs,
      last_error: observation.last_error,
    }));
    artifact.evidence.receipts = receipts;

    await step('Create note and promote to wiki through UI', () => createAndPromoteNote(managerPage, managerAuth), true);

    await step('Capture final dashboard/tasks/inbox surfaces', async () => {
      for (const [route, name] of [
        ['/dashboard', 'surface-dashboard-final'],
        ['/inbox?tab=captures', 'surface-captures-final'],
        ['/tasks', 'surface-tasks-final'],
        ['/knowledge', 'surface-knowledge-final'],
      ] as Array<[string, string]>) {
        await managerPage.goto(`${WEB_URL}${route}`, { waitUntil: 'domcontentloaded' });
        await managerPage.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
        await delay(700);
        await screenshot(managerPage, name);
      }
    }, true);

    addFindings(finalCoverage, artifact.sent_messages.length, failedSends, finalIntents, finalActions, receipts, finalObservations);
    mark(artifact.findings.some((finding) => finding.severity === 'P0' || finding.severity === 'P1') ? 'warn' : 'pass', `${RUN_OPTIONS.rehearsal ? 'Demo rehearsal' : 'Dense certification'} completed with findings`, artifact.findings.length);
  } finally {
    for (const context of contexts) await context.close().catch(() => null);
    await browser.close();
    if (RUN_OPTIONS.cleanupAfterRun) {
      if (!cleanupAuth) {
        artifact.evidence.cleanup = { marker: RUN_MARKER, mode: 'skipped', reason: 'Manager API login never completed, so cleanup could not be scoped to an org.' };
      } else {
        const apply = !RUN_OPTIONS.cleanupDryRun;
        const cleanup = await step(
          apply ? `Apply marker-scoped cleanup for ${RUN_MARKER}` : `Dry-run marker-scoped cleanup for ${RUN_MARKER}`,
          () => cleanupRunArtifacts(cleanupAuth!, { marker: RUN_MARKER, apply, reason: 'after-run' }),
          true,
        );
        artifact.evidence.cleanup = cleanup;
        const sentCount = artifact.sent_messages.filter((message) => message.ok).length;
        const beforeMessages = (cleanup as CleanupSummary | null)?.before?.messages ?? null;
        if (sentCount > 0 && beforeMessages === 0) {
          artifact.findings.push({
            severity: 'P2',
            title: 'Cleanup DB target did not see run-created chat rows',
            detail: `The UI/API run posted ${sentCount} message(s), but the configured cleanup database found 0 visible marker messages. This usually means DATABASE_URL does not match the API process database; set DEFT_CLEANUP_DATABASE_URL to the API database before relying on cleanup.`,
          });
        }
      }
    }
    await writeReportOnce();
  }
}

main().catch(async (err) => {
  artifact.findings.push({
    severity: 'P1',
    title: 'Dense certification stopped early',
    detail: err instanceof Error ? err.stack || err.message : String(err),
  });
  await writeReportOnce();
  console.error(err);
  process.exit(1);
});
