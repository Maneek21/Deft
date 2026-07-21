import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const requireApi = createRequire(path.join(root, 'apps/api/package.json'));
const requireWeb = createRequire(path.join(root, 'apps/web/package.json'));
const { Client, Pool } = requireApi('pg');
const bcrypt = requireApi('bcryptjs');
const jwt = requireApi('jsonwebtoken');
const { io } = requireWeb('socket.io-client');

const USERS = Number(process.env.CERT_USERS || 60);
const BURST_MESSAGES = Number(process.env.CERT_BURST_MESSAGES || USERS);
const SUSTAINED_MESSAGES = Number(process.env.CERT_SUSTAINED_MESSAGES || USERS * 2);
const SUSTAINED_STAGGER_MS = Number(process.env.CERT_SUSTAINED_STAGGER_MS || 250);
const QUEUE_JOBS = Number(process.env.CERT_QUEUE_JOBS || 120);
const PORT = Number(process.env.CERT_API_PORT || 3391);
const MAX_WRITE_P95_MS = Number(process.env.CERT_MAX_WRITE_P95_MS || 5000);
const MAX_INBOX_READ_P95_MS = Number(process.env.CERT_MAX_INBOX_READ_P95_MS || 3000);
const MAX_QUEUE_DRAIN_SECONDS = Number(process.env.CERT_MAX_QUEUE_DRAIN_SECONDS || 90);
const MAX_RECOVERY_SECONDS = Number(process.env.CERT_MAX_RECOVERY_SECONDS || 45);
const MAX_ATTENTION_PROJECTION_SECONDS = Number(process.env.CERT_MAX_ATTENTION_PROJECTION_SECONDS || 30);
const MAX_ATTENTION_PROJECTION_P95_MS = Number(process.env.CERT_MAX_ATTENTION_PROJECTION_P95_MS || 5000);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'Certification-only-Password-42!';
const runId = new Date().toISOString().replace(/[-:.TZ]/g, '');
const databaseName = `deft_cert_${runId}_${process.pid}`.toLowerCase();
const startedAt = Date.now();
const results = {
  run_id: runId,
  started_at: new Date().toISOString(),
  configuration: {
    users: USERS,
    burst_messages: BURST_MESSAGES,
    sustained_messages: SUSTAINED_MESSAGES,
    sustained_duration_seconds: Math.round(SUSTAINED_MESSAGES * SUSTAINED_STAGGER_MS / 1000),
    queue_jobs: QUEUE_JOBS,
    budgets: {
      message_write_p95_ms: MAX_WRITE_P95_MS,
      inbox_read_p95_ms: MAX_INBOX_READ_P95_MS,
      queue_drain_seconds: MAX_QUEUE_DRAIN_SECONDS,
      recovery_seconds: MAX_RECOVERY_SECONDS,
      attention_projection_seconds: MAX_ATTENTION_PROJECTION_SECONDS,
      attention_projection_p95_ms: MAX_ATTENTION_PROJECTION_P95_MS,
    },
  },
  phases: {},
  findings: [],
  boundaries: [
    'This certifies one Deft API instance. Multi-instance Socket.IO fanout is not covered because the current server uses in-memory room and presence state.',
    'Queue pressure uses deterministic no-op jobs to isolate dispatcher throughput and stale-job recovery. External AI-provider latency, quotas, and cost are not certified here.',
    'Browser rendering is outside this backend/realtime load run; product UI has separate dogfood coverage.',
  ],
};

if (!Number.isInteger(USERS) || USERS < 12) {
  throw new Error('CERT_USERS must be an integer of at least 12 so policy and concurrency probes are valid');
}

function parseEnv(source) {
  const out = {};
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[match[1]] = value;
  }
  return out;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = p <= 0 ? 0 : Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[index] * 10) / 10;
}

function latencySummary(values) {
  return { count: values.length, min_ms: percentile(values, 0), p50_ms: percentile(values, 50), p95_ms: percentile(values, 95), p99_ms: percentile(values, 99), max_ms: percentile(values, 100) };
}

function parseCapacityProfiles(log) {
  const allRows = log.split(/\r?\n/).flatMap((line) => {
    const marker = line.indexOf('[capacity-profile] ');
    if (marker < 0) return [];
    try {
      return [JSON.parse(line.slice(marker + '[capacity-profile] '.length))];
    } catch {
      return [];
    }
  });
  const rows = allRows.filter((row) => row.event === 'notification_fanout');
  const projectionRows = allRows.filter((row) => row.event === 'attention_projection');
  const metric = (key) => latencySummary(rows.map((row) => Number(row[key]) || 0));
  return {
    samples: rows.length,
    requested_notifications: rows.reduce((sum, row) => sum + Number(row.requested || 0), 0),
    allowed_notifications: rows.reduce((sum, row) => sum + Number(row.allowed || 0), 0),
    policy_read: metric('policy_read_ms'),
    notification_insert: metric('notification_insert_ms'),
    attention_enqueue: metric('attention_enqueue_ms'),
    total: metric('total_ms'),
    attention_projection: {
      jobs: projectionRows.length,
      notifications: projectionRows.reduce((sum, row) => sum + Number(row.notifications || 0), 0),
      projected_items: projectionRows.reduce((sum, row) => sum + Number(row.projected_items || 0), 0),
      queue_delay: latencySummary(projectionRows.flatMap((row) => row.queue_delay_ms === null ? [] : [Number(row.queue_delay_ms) || 0])),
      projection: latencySummary(projectionRows.map((row) => Number(row.projection_ms) || 0)),
      end_to_end: latencySummary(projectionRows.flatMap((row) => row.end_to_end_ms === null ? [] : [Number(row.end_to_end_ms) || 0])),
    },
  };
}

function addGateFinding(condition, title, detail) {
  if (!condition) return;
  results.findings.push({ severity: 'high', title, detail });
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(predicate, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms; last=${JSON.stringify(last)}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: options.env || process.env, shell: process.platform === 'win32', windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; if (options.live) process.stdout.write(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += chunk; if (options.live) process.stderr.write(chunk); });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} ${args.join(' ')} failed (${code})\n${stdout}\n${stderr}`)));
  });
}

let apiProcess = null;
let apiLog = '';
function startApi(env) {
  apiProcess = spawn('pnpm', ['--filter', '@deft/api', 'exec', 'tsx', 'src/server.ts'], {
    cwd: root, env, shell: process.platform === 'win32', windowsHide: true,
  });
  apiProcess.stdout.on('data', (chunk) => { apiLog += chunk.toString(); });
  apiProcess.stderr.on('data', (chunk) => { apiLog += chunk.toString(); });
  return apiProcess;
}

async function stopApi() {
  if (!apiProcess || apiProcess.exitCode !== null) return;
  const pid = apiProcess.pid;
  if (process.platform === 'win32') {
    await run('taskkill', ['/pid', String(pid), '/t', '/f']).catch(() => {});
  } else {
    apiProcess.kill('SIGTERM');
  }
  await sleep(700);
  apiProcess = null;
}

async function waitForApiReady(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastHealth = null;
  while (Date.now() < deadline) {
    if (apiProcess?.exitCode !== null && apiProcess?.exitCode !== undefined) {
      throw new Error(`API exited before readiness with code ${apiProcess.exitCode}.\n${apiLog.slice(-4000)}`);
    }
    lastHealth = await timedFetch(`${BASE_URL}/health`);
    if (lastHealth.ok) return;
    await sleep(400);
  }
  throw new Error(`API readiness timed out after ${timeoutMs}ms. Last health=${JSON.stringify(lastHealth)}\n${apiLog.slice(-4000)}`);
}

async function assertCertificationSchema(connection) {
  const requiredTables = [
    'orgs',
    'users',
    'org_members',
    'spaces',
    'space_members',
    'messages',
    'notifications',
    'attention_items',
    'attention_events',
    'attention_deliveries',
    'job_queue',
  ];
  const tableRows = await connection.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1)",
    [requiredTables],
  );
  const present = new Set(tableRows.rows.map((row) => row.table_name));
  const missingTables = requiredTables.filter((table) => !present.has(table));
  const columnRows = await connection.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name=ANY($1)",
    [['profile_summary', 'notification_preferences']],
  );
  const columns = new Set(columnRows.rows.map((row) => row.column_name));
  const missingColumns = ['profile_summary', 'notification_preferences'].filter((column) => !columns.has(column));
  if (missingTables.length || missingColumns.length) {
    throw new Error(`Certification schema is stale. Missing tables: ${missingTables.join(', ') || 'none'}; missing users columns: ${missingColumns.join(', ') || 'none'}`);
  }
  return { required_tables: requiredTables.length, required_user_columns: 2 };
}

async function timedFetch(url, init = {}) {
  const start = performance.now();
  try {
    const response = await fetch(url, init);
    const text = await response.text();
    let body = text;
    try { body = text ? JSON.parse(text) : null; } catch {}
    return { ok: response.ok, status: response.status, ms: performance.now() - start, body };
  } catch (error) {
    return { ok: false, status: 0, ms: performance.now() - start, error: String(error) };
  }
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function connectSockets(tokens, spaceId) {
  const counters = tokens.map(() => ({ messages: 0, notifications: 0, presence: 0 }));
  const marker = `[CERT:${runId}:`;
  const sockets = await Promise.all(tokens.map((token, index) => new Promise((resolve, reject) => {
    const socket = io(BASE_URL, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 10000 });
    const timer = setTimeout(() => { socket.close(); reject(new Error(`socket ${index} timeout`)); }, 12000);
    socket.on('message:new', (message) => {
      if (String(message?.content ?? '').includes(marker)) counters[index].messages += 1;
    });
    socket.on('notification:new', (notification) => {
      if (String(notification?.body ?? '').includes(marker)) counters[index].notifications += 1;
    });
    socket.on('presence:update', () => { counters[index].presence += 1; });
    socket.on('connect_error', (error) => { clearTimeout(timer); reject(error); });
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.emit('space:join', spaceId);
      resolve(socket);
    });
  })));
  await sleep(800);
  return { sockets, counters };
}

async function postMessages({ users, tokens, spaceId, count, staggerMs = 0, prefix }) {
  const posts = [];
  for (let i = 0; i < count; i += 1) {
    if (staggerMs) await sleep(staggerMs);
    const sender = i % users.length;
    const target = (sender + 1) % users.length;
    const mention = prefix === 'burst' ? ` <@${users[target].id}|${users[target].name}>` : '';
    posts.push(timedFetch(`${BASE_URL}/api/messages/${spaceId}`, {
      method: 'POST', headers: authHeaders(tokens[sender]), body: JSON.stringify({ content: `[CERT:${runId}:${prefix}:${i + 1}] realistic coordination update${mention}` }),
    }));
  }
  const rows = await Promise.all(posts);
  return {
    attempted: rows.length,
    succeeded: rows.filter((row) => row.ok).length,
    failed: rows.filter((row) => !row.ok).map((row) => ({ status: row.status, body: row.body, error: row.error })),
    latency: latencySummary(rows.map((row) => row.ms)),
  };
}

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function renderReport(report) {
  const phaseRows = Object.entries(report.phases).map(([name, value]) => `<tr><th>${htmlEscape(name.replaceAll('_', ' '))}</th><td><pre>${htmlEscape(JSON.stringify(value, null, 2))}</pre></td></tr>`).join('');
  const findingRows = report.findings.map((item) => `<li class="${item.severity}"><strong>${htmlEscape(item.severity.toUpperCase())}: ${htmlEscape(item.title)}</strong><p>${htmlEscape(item.detail)}</p></li>`).join('');
  const passed = report.verdict === 'PASS';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Deft ${report.configuration.users}-person certification</title><style>
  :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#111114;color:#ececf1;font:15px/1.55 Inter,system-ui,sans-serif}main{max-width:1060px;margin:auto;padding:48px 28px 80px}header{border-bottom:1px solid #303038;padding-bottom:28px;margin-bottom:28px}.eyebrow{color:#9b8cff;text-transform:uppercase;font-size:12px;font-weight:750;letter-spacing:.08em}h1{font-size:44px;line-height:1.06;margin:10px 0 14px;letter-spacing:0}h2{margin-top:38px}.verdict{display:inline-flex;padding:7px 13px;border-radius:999px;background:${passed ? '#123b2b' : '#442225'};color:${passed ? '#64e7a4' : '#ff8f98'};font-weight:800}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.metric{background:#1b1b20;border:1px solid #303038;border-radius:8px;padding:16px}.metric b{font-size:24px;display:block}.metric span{color:#a6a6b1;font-size:12px}table{border-collapse:collapse;width:100%;background:#17171b;border:1px solid #303038}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #303038;padding:14px}th{width:210px;text-transform:capitalize}pre{white-space:pre-wrap;margin:0;color:#cfcfd8;font:12px/1.45 ui-monospace,monospace}.high strong{color:#ff8f98}.medium strong{color:#ffd36c}.low strong{color:#87d7ff}li{margin-bottom:16px}p{color:#b9b9c3}.boundary{border-left:3px solid #7b68ee;padding-left:14px}</style></head><body><main><header><div class="eyebrow">Deft capacity evidence</div><h1>${report.configuration.users}-person certification</h1><p>One disposable workspace, ${report.configuration.users} people, real HTTP + Socket.IO traffic, notification volume, queue pressure, forced restart, and recovery.</p><span class="verdict">${htmlEscape(report.verdict)}</span></header><section class="grid"><div class="metric"><b>${report.configuration.users}</b><span>connected people</span></div><div class="metric"><b>${report.summary?.messages_succeeded ?? 0}</b><span>messages accepted</span></div><div class="metric"><b>${report.summary?.socket_fanout_ratio ?? 0}%</b><span>message fanout</span></div><div class="metric"><b>${report.summary?.recovery_seconds ?? 'n/a'}s</b><span>service recovery</span></div></section><h2>Findings</h2><ul>${findingRows || '<li>No findings.</li>'}</ul><h2>Evidence</h2><table>${phaseRows}</table><h2>Proven boundary</h2>${report.boundaries.map((item) => `<p class="boundary">${htmlEscape(item)}</p>`).join('')}<p>Generated ${htmlEscape(report.completed_at)} in ${htmlEscape(report.duration_seconds)} seconds. Temporary database removed: ${htmlEscape(report.cleanup?.database_removed ?? false)}.</p></main></body></html>`;
}

let admin = null;
let adminConnected = false;
let pool = null;
let sockets = [];
let tempDbUrl = '';
let databaseRemoved = false;
try {
  const envFile = parseEnv(await readFile(path.join(root, '.env'), 'utf8'));
  const baseDbUrl = process.env.DATABASE_URL || envFile.DATABASE_URL;
  if (!baseDbUrl) throw new Error('DATABASE_URL is required in .env');
  const parsed = new URL(baseDbUrl);
  const adminUrl = new URL(baseDbUrl);
  adminUrl.pathname = '/postgres';
  admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  adminConnected = true;
  const templateDatabase = process.env.CERT_TEMPLATE_DATABASE?.trim();
  if (templateDatabase && !/^[a-zA-Z0-9_]+$/.test(templateDatabase)) throw new Error('CERT_TEMPLATE_DATABASE contains unsafe characters');
  await admin.query(templateDatabase
    ? `CREATE DATABASE "${databaseName}" TEMPLATE "${templateDatabase}"`
    : `CREATE DATABASE "${databaseName}"`);
  parsed.pathname = `/${databaseName}`;
  tempDbUrl = parsed.toString();

  process.stdout.write(`[cert] Preparing disposable database ${databaseName}\n`);
  const certEnv = {
    ...process.env, ...envFile, DATABASE_URL: tempDbUrl, PORT: String(PORT), API_PORT: String(PORT),
    NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'http://localhost:3000', NEXT_PUBLIC_API_URL: BASE_URL,
    OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: '', OLLAMA_URL: '',
    DEFT_AUTH_RATE_LIMIT_PER_MINUTE: process.env.DEFT_AUTH_RATE_LIMIT_PER_MINUTE || '10',
    DEFT_LOGIN_IP_RATE_LIMIT_PER_MINUTE: process.env.DEFT_LOGIN_IP_RATE_LIMIT_PER_MINUTE || '120',
    DEFT_DEFAULT_RATE_LIMIT_PER_MINUTE: '5000', DEFT_WORKER_BATCH_SIZE: '10', DEFT_WORKER_POLL_INTERVAL_MS: '250',
    DEFT_CAPACITY_TRACE: '1',
  };
  pool = new Pool({ connectionString: tempDbUrl, max: 20 });
  const schemaStart = performance.now();
  if (templateDatabase) {
    const tableRows = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    const tableNames = tableRows.rows.map((row) => `"${String(row.tablename).replaceAll('"', '""')}"`);
    if (tableNames.length) await pool.query(`TRUNCATE TABLE ${tableNames.join(', ')} RESTART IDENTITY CASCADE`);
  } else {
    await run('pnpm', ['db:push-full'], { env: certEnv });
  }
  const schemaProof = await assertCertificationSchema(pool);
  results.phases.database_bootstrap = {
    seconds: Math.round((performance.now() - schemaStart) / 100) / 10,
    method: templateDatabase ? `schema clone of ${templateDatabase}, all data truncated` : 'db:push-full',
    schema_proof: schemaProof,
  };

  const orgId = randomUUID();
  const spaceId = randomUUID();
  const passwordHash = await bcrypt.hash(PASSWORD, 8);
  const users = Array.from({ length: USERS }, (_, i) => ({ id: randomUUID(), name: `Cert User ${String(i + 1).padStart(2, '0')}`, email: `cert-${runId}-${i + 1}@deft.invalid` }));
  await pool.query('BEGIN');
  try {
    await pool.query('INSERT INTO orgs (id,name,slug,agent_enabled,ai_config) VALUES ($1,$2,$3,false,$4)', [orgId, `${USERS} Person Certification`, `cert-${runId}`, {}]);
    for (let i = 0; i < users.length; i += 1) {
      const user = users[i];
      await pool.query('INSERT INTO users (id,email,name,password_hash,email_verified,kind) VALUES ($1,$2,$3,$4,true,\'human\')', [user.id, user.email, user.name, passwordHash]);
      await pool.query('INSERT INTO org_members (id,org_id,user_id,role,is_active) VALUES ($1,$2,$3,$4,true)', [randomUUID(), orgId, user.id, i === 0 ? 'owner' : i < 4 ? 'admin' : 'member']);
    }
    await pool.query('INSERT INTO spaces (id,org_id,name,description,type,is_default,agent_enabled,created_by) VALUES ($1,$2,$3,$4,\'public\',true,false,$5)', [spaceId, orgId, 'certification-room', 'Disposable capacity test room', users[0].id]);
    for (const user of users) await pool.query('INSERT INTO space_members (id,space_id,user_id,notification_level) VALUES ($1,$2,$3,\'all\')', [randomUUID(), spaceId, user.id]);
    await pool.query('COMMIT');
  } catch (error) { await pool.query('ROLLBACK'); throw error; }
  results.phases.seed = { orgs: 1, users: users.length, shared_space_members: users.length };

  process.stdout.write('[cert] Starting API and workers\n');
  startApi(certEnv);
  const bootStarted = performance.now();
  await waitForApiReady();
  results.phases.initial_boot = { seconds: Math.round((performance.now() - bootStarted) / 100) / 10 };

  process.stdout.write('[cert] Measuring production login burst\n');
  const logins = await Promise.all(users.map((user) => timedFetch(`${BASE_URL}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: user.email, password: PASSWORD }) })));
  results.phases.login_burst = {
    succeeded: logins.filter((row) => row.ok).length,
    rate_limited: logins.filter((row) => row.status === 429).length,
    other_failures: logins.filter((row) => !row.ok && row.status !== 429).length,
    latency: latencySummary(logins.map((row) => row.ms)),
  };
  if (results.phases.login_burst.rate_limited) results.findings.push({ severity: 'medium', title: 'Same-office login burst hits the production IP limiter', detail: `${results.phases.login_burst.rate_limited} of ${USERS} simultaneous logins were rate-limited. Existing sessions and per-user application traffic are unaffected, but onboarding/re-auth after an outage behind one NAT needs a better account-aware login limiter.` });

  const jwtSecret = certEnv.JWT_SECRET || 'dev-jwt-secret-change-me';
  const tokens = users.map((user) => jwt.sign({ id: user.id, email: user.email, org_id: orgId }, jwtSecret, { expiresIn: '30m' }));

  process.stdout.write(`[cert] Connecting ${USERS} realtime clients\n`);
  const socketStart = performance.now();
  let connection = await connectSockets(tokens, spaceId);
  sockets = connection.sockets;
  const counters = connection.counters;
  results.phases.websocket_connect = { connected: sockets.length, seconds: Math.round((performance.now() - socketStart) / 100) / 10 };

  process.stdout.write('[cert] Running simultaneous message + notification burst\n');
  const burst = await postMessages({ users, tokens, spaceId, count: BURST_MESSAGES, prefix: 'burst' });
  await sleep(1500);
  const sustained = await postMessages({ users, tokens, spaceId, count: SUSTAINED_MESSAGES, staggerMs: SUSTAINED_STAGGER_MS, prefix: 'sustained' });
  await sleep(2000);
  const totalSucceeded = burst.succeeded + sustained.succeeded;
  const expectedMessageDeliveries = totalSucceeded * USERS;
  const actualMessageDeliveries = counters.reduce((sum, item) => sum + item.messages, 0);
  const expectedNotificationDeliveries = totalSucceeded * (USERS - 1);
  const actualNotificationDeliveries = counters.reduce((sum, item) => sum + item.notifications, 0);
  results.phases.message_and_notification_load = {
    burst, sustained,
    socket_message_deliveries: { expected: expectedMessageDeliveries, actual: actualMessageDeliveries, ratio: expectedMessageDeliveries ? Math.round(actualMessageDeliveries / expectedMessageDeliveries * 10000) / 100 : 0 },
    socket_notification_deliveries: { expected: expectedNotificationDeliveries, actual: actualNotificationDeliveries, ratio: expectedNotificationDeliveries ? Math.round(actualNotificationDeliveries / expectedNotificationDeliveries * 10000) / 100 : 0 },
  };
  results.phases.notification_fanout_profile = parseCapacityProfiles(apiLog);
  if (burst.failed.length || sustained.failed.length) results.findings.push({ severity: 'high', title: 'Message writes failed under load', detail: `${burst.failed.length + sustained.failed.length} message writes failed.` });
  if (actualMessageDeliveries !== expectedMessageDeliveries) results.findings.push({ severity: 'high', title: 'Socket message fanout was not exactly once', detail: `${actualMessageDeliveries}/${expectedMessageDeliveries} expected room deliveries arrived.` });
  if (actualNotificationDeliveries !== expectedNotificationDeliveries) results.findings.push({ severity: 'high', title: 'Realtime notification fanout was not exactly once', detail: `${actualNotificationDeliveries}/${expectedNotificationDeliveries} expected user-room deliveries arrived.` });

  process.stdout.write('[cert] Waiting for durable notification-to-attention projection\n');
  const attentionProjectionStarted = performance.now();
  await waitFor(async () => {
    const { rows } = await pool.query(`
      SELECT count(*)::int projected
      FROM attention_events ae
      INNER JOIN notifications n ON ae.source_event_id = 'notification:' || n.id
      WHERE ae.event_type = 'source_event'
        AND n.org_id = $1
        AND n.body LIKE $2
    `, [orgId, `[CERT:${runId}:%`]);
    return rows[0].projected === expectedNotificationDeliveries ? rows[0].projected : false;
  }, Math.max(5000, MAX_ATTENTION_PROJECTION_SECONDS * 1000), 250);
  const attentionProjectionSeconds = Math.round((performance.now() - attentionProjectionStarted) / 100) / 10;
  results.phases.notification_fanout_profile = parseCapacityProfiles(apiLog);
  const attentionProjectionProof = await pool.query(`
    SELECT count(*)::int projected
    FROM attention_events ae
    INNER JOIN notifications n ON ae.source_event_id = 'notification:' || n.id
    WHERE ae.event_type = 'source_event'
      AND n.org_id = $1
      AND n.body LIKE $2
  `, [orgId, `[CERT:${runId}:%`]);
  results.phases.attention_projection = {
    expected: expectedNotificationDeliveries,
    actual: attentionProjectionProof.rows[0].projected,
    post_load_drain_seconds: attentionProjectionSeconds,
    end_to_end_p95_ms: results.phases.notification_fanout_profile.attention_projection.end_to_end.p95_ms,
  };
  addGateFinding(attentionProjectionSeconds > MAX_ATTENTION_PROJECTION_SECONDS, 'Attention projection exceeded the release budget', `Projection took ${attentionProjectionSeconds}s; the configured budget is ${MAX_ATTENTION_PROJECTION_SECONDS}s.`);
  addGateFinding(
    (results.phases.attention_projection.end_to_end_p95_ms ?? Number.POSITIVE_INFINITY) > MAX_ATTENTION_PROJECTION_P95_MS,
    'Attention projection p95 exceeded the release budget',
    `End-to-end p95 was ${results.phases.attention_projection.end_to_end_p95_ms ?? 'unavailable'}ms; the configured budget is ${MAX_ATTENTION_PROJECTION_P95_MS}ms.`,
  );

  process.stdout.write('[cert] Verifying notification preference policy under the bulk path\n');
  const policyUsers = users.slice(0, 4);
  await pool.query("UPDATE users SET status_text='Do Not Disturb' WHERE id=$1", [policyUsers[0].id]);
  await pool.query("UPDATE users SET notification_preferences=jsonb_set(notification_preferences,'{channels,chat}','false'::jsonb) WHERE id=$1", [policyUsers[1].id]);
  await pool.query('UPDATE space_members SET is_muted=true WHERE space_id=$1 AND user_id=$2', [spaceId, policyUsers[2].id]);
  await pool.query("UPDATE space_members SET notification_level='mentions' WHERE space_id=$1 AND user_id=$2", [spaceId, policyUsers[3].id]);
  const policyMarker = `[CERT:${runId}:policy]`;
  const policyPost = await timedFetch(`${BASE_URL}/api/messages/${spaceId}`, {
    method: 'POST', headers: authHeaders(tokens[10]), body: JSON.stringify({ content: `${policyMarker} preference integrity proof` }),
  });
  await sleep(500);
  const policyRows = await pool.query('SELECT user_id FROM notifications WHERE org_id=$1 AND body LIKE $2', [orgId, `${policyMarker}%`]);
  const blockedIds = new Set(policyUsers.map((user) => user.id));
  const leakedIds = policyRows.rows.map((row) => row.user_id).filter((id) => blockedIds.has(id));
  const expectedPolicyRecipients = USERS - 1 - policyUsers.length;
  results.phases.notification_policy_integrity = {
    post_succeeded: policyPost.ok,
    expected_recipients: expectedPolicyRecipients,
    actual_recipients: policyRows.rowCount,
    blocked_policy_leaks: leakedIds.length,
    policies_checked: ['do_not_disturb', 'chat_channel_disabled', 'space_muted', 'space_mentions_only'],
  };
  if (!policyPost.ok || policyRows.rowCount !== expectedPolicyRecipients || leakedIds.length) {
    results.findings.push({ severity: 'high', title: 'Bulk notification policy changed recipient semantics', detail: `Expected ${expectedPolicyRecipients}, inserted ${policyRows.rowCount}, blocked-policy leaks ${leakedIds.length}.` });
  }
  await pool.query('UPDATE users SET status_text=NULL WHERE id=$1', [policyUsers[0].id]);
  await pool.query("UPDATE users SET notification_preferences=jsonb_set(notification_preferences,'{channels,chat}','true'::jsonb) WHERE id=$1", [policyUsers[1].id]);
  await pool.query('UPDATE space_members SET is_muted=false WHERE space_id=$1 AND user_id=$2', [spaceId, policyUsers[2].id]);
  await pool.query("UPDATE space_members SET notification_level='all' WHERE space_id=$1 AND user_id=$2", [spaceId, policyUsers[3].id]);

  process.stdout.write(`[cert] Reading ${USERS} inboxes concurrently\n`);
  const inboxReads = await Promise.all(tokens.map((token) => timedFetch(`${BASE_URL}/api/notifications`, { headers: authHeaders(token) })));
  results.phases.notification_inbox_reads = {
    succeeded: inboxReads.filter((row) => row.ok).length,
    latency: latencySummary(inboxReads.map((row) => row.ms)),
    unread_min: Math.min(...inboxReads.filter((row) => row.ok).map((row) => row.body.unread_count)),
    unread_max: Math.max(...inboxReads.filter((row) => row.ok).map((row) => row.body.unread_count)),
  };

  const jobCount = await pool.query("SELECT status,count(*)::int count FROM job_queue WHERE data->>'orgId'=$1 GROUP BY status", [orgId]);
  results.phases.org_job_backlog = { observed: Object.fromEntries(jobCount.rows.map((row) => [row.status, row.count])) };

  process.stdout.write(`[cert] Pressuring queue with ${QUEUE_JOBS} jobs\n`);
  await stopApi();
  sockets.forEach((socket) => socket.close()); sockets = [];
  for (let i = 0; i < QUEUE_JOBS; i += 1) {
    await pool.query("INSERT INTO job_queue (id,queue,name,data,status,max_attempts,run_at) VALUES ($1,'agent-jobs','certification-noop',$2,'pending',3,now())", [randomUUID(), { certRunId: runId, ordinal: i }]);
  }
  const staleIds = [];
  for (let i = 0; i < 5; i += 1) {
    const id = randomUUID(); staleIds.push(id);
    await pool.query("INSERT INTO job_queue (id,queue,name,data,status,attempts,max_attempts,run_at,started_at) VALUES ($1,'agent-jobs','certification-noop',$2,'running',1,3,now(),now()-interval '6 minutes')", [id, { certRunId: runId, stale: true }]);
  }
  const restartStarted = performance.now();
  apiLog = '';
  startApi(certEnv);
  await waitForApiReady();
  const healthRecoverySeconds = Math.round((performance.now() - restartStarted) / 100) / 10;
  const drainStarted = performance.now();
  await waitFor(async () => {
    const { rows } = await pool.query("SELECT count(*)::int remaining FROM job_queue WHERE data->>'certRunId'=$1 AND status IN ('pending','running')", [runId]);
    return rows[0].remaining === 0 ? true : false;
  }, 90000, 500);
  const queueDrainSeconds = Math.round((performance.now() - drainStarted) / 100) / 10;
  const queueState = await pool.query("SELECT status,count(*)::int count FROM job_queue WHERE data->>'certRunId'=$1 GROUP BY status", [runId]);
  const staleState = await pool.query('SELECT status,count(*)::int count FROM job_queue WHERE id=ANY($1) GROUP BY status', [staleIds]);
  results.phases.queue_pressure_and_recovery = {
    service_health_recovery_seconds: healthRecoverySeconds,
    injected_pending_jobs: QUEUE_JOBS,
    injected_stale_running_jobs: staleIds.length,
    drain_seconds: queueDrainSeconds,
    final_states: Object.fromEntries(queueState.rows.map((row) => [row.status, row.count])),
    stale_final_states: Object.fromEntries(staleState.rows.map((row) => [row.status, row.count])),
  };

  process.stdout.write('[cert] Reconnecting all clients after restart\n');
  connection = await connectSockets(tokens, spaceId);
  sockets = connection.sockets;
  const recoveryCounters = connection.counters;
  const proof = await postMessages({ users, tokens, spaceId, count: 1, prefix: 'recovery' });
  await sleep(1200);
  const recoveryDeliveries = recoveryCounters.reduce((sum, item) => sum + item.messages, 0);
  results.phases.post_restart_proof = { post_succeeded: proof.succeeded, connected: sockets.length, socket_deliveries_expected: USERS, socket_deliveries_actual: recoveryDeliveries };
  if (recoveryDeliveries !== USERS) results.findings.push({ severity: 'high', title: 'Post-restart socket proof was incomplete', detail: `${recoveryDeliveries}/${USERS} clients received the recovery message.` });

  const p95Write = Math.max(burst.latency.p95_ms || 0, sustained.latency.p95_ms || 0);
  const inboxP95 = results.phases.notification_inbox_reads.latency.p95_ms || 0;
  addGateFinding(p95Write > MAX_WRITE_P95_MS, 'Message write latency exceeded the release budget', `Worst phase p95 was ${p95Write}ms; the configured budget is ${MAX_WRITE_P95_MS}ms.`);
  addGateFinding(inboxP95 > MAX_INBOX_READ_P95_MS, 'Inbox read latency exceeded the release budget', `Concurrent inbox-read p95 was ${inboxP95}ms; the configured budget is ${MAX_INBOX_READ_P95_MS}ms.`);
  addGateFinding(queueDrainSeconds > MAX_QUEUE_DRAIN_SECONDS, 'Queue drain exceeded the release budget', `Queue drain took ${queueDrainSeconds}s; the configured budget is ${MAX_QUEUE_DRAIN_SECONDS}s.`);
  addGateFinding(healthRecoverySeconds > MAX_RECOVERY_SECONDS, 'Service recovery exceeded the release budget', `Health recovery took ${healthRecoverySeconds}s; the configured budget is ${MAX_RECOVERY_SECONDS}s.`);
  results.summary = {
    messages_succeeded: totalSucceeded + proof.succeeded,
    socket_fanout_ratio: results.phases.message_and_notification_load.socket_message_deliveries.ratio,
    notification_fanout_ratio: results.phases.message_and_notification_load.socket_notification_deliveries.ratio,
    worst_message_write_p95_ms: p95Write,
    notification_read_p95_ms: results.phases.notification_inbox_reads.latency.p95_ms,
    queue_drain_seconds: queueDrainSeconds,
    recovery_seconds: healthRecoverySeconds,
    attention_projection_seconds: attentionProjectionSeconds,
    attention_projection_p95_ms: results.phases.attention_projection.end_to_end_p95_ms,
  };
  const hardFailures = results.findings.filter((item) => item.severity === 'high').length;
  results.verdict = hardFailures === 0 ? 'PASS' : 'FAIL';
} catch (error) {
  results.verdict = 'FAIL';
  results.error = String(error?.stack || error);
  results.findings.push({ severity: 'high', title: 'Certification harness did not complete', detail: String(error?.message || error) });
  process.stderr.write(`${results.error}\n`);
} finally {
  sockets.forEach((socket) => socket.close());
  await stopApi();
  if (pool) await pool.end().catch(() => {});
  if (adminConnected && admin && databaseName) {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName]).catch(() => {});
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      const proof = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [databaseName]);
      databaseRemoved = proof.rowCount === 0;
    } catch (error) {
      results.findings.push({ severity: 'high', title: 'Disposable database cleanup failed', detail: String(error?.message || error) });
    }
    await admin.end().catch(() => {});
  }
  results.cleanup = { database_name: databaseName, database_removed: databaseRemoved };
  if (!databaseRemoved) results.verdict = 'FAIL';
  results.completed_at = new Date().toISOString();
  results.duration_seconds = Math.round((Date.now() - startedAt) / 100) / 10;
  results.api_log_tail = apiLog.split(/\r?\n/).slice(-40).join('\n');
  const reportDir = path.join(root, 'reports');
  await mkdir(reportDir, { recursive: true });
  const stem = `deft-${USERS}-person-certification-${runId}`;
  await writeFile(path.join(reportDir, `${stem}.json`), JSON.stringify(results, null, 2));
  await writeFile(path.join(reportDir, `${stem}.html`), renderReport(results));
  process.stdout.write(`[cert] ${results.verdict} in ${results.duration_seconds}s\n[cert] Report: ${path.join(reportDir, `${stem}.html`)}\n`);
}

if (results.verdict !== 'PASS') process.exitCode = 1;
