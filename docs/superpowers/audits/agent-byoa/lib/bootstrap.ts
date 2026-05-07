// docs/superpowers/audits/agent-byoa/lib/bootstrap.ts
import { randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { eq, and, ilike, or } from 'drizzle-orm';
import { db, schema } from '../../lib/db.js';

const SNAPSHOT_PATH = process.env.DEFT_TEST_TOKEN_SNAPSHOT
  || 'docs/superpowers/audits/agent-byoa/.token-snapshot.json';

interface Snapshot {
  agent_id: string;
  agent_slug: string;
  org_id: string;
  original_hash: string | null;
  created_at: string;
}

interface BootstrapResult {
  apiUrl: string;
  loginUserId: string;
  orgId: string;
  agent: { id: string; slug: string; trust_level: string };
  rawToken: string;
}

const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';

export async function bootstrap(): Promise<BootstrapResult> {
  const email = process.env.DEFT_TEST_EMAIL || 'maneek@test.com';
  const password = process.env.DEFT_TEST_PASSWORD || 'test1234';

  // 1. Login
  const loginRes = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!loginRes.ok) {
    throw new Error(`Login failed: ${loginRes.status} ${await loginRes.text()}`);
  }
  const login = (await loginRes.json()) as { user?: { id?: string; org_id?: string }, accessToken?: string, access_token?: string, org_id?: string };
  const loginUserId = login.user?.id;
  const orgId = (login.org_id ?? login.user?.org_id) as string | undefined;
  if (!loginUserId || !orgId) {
    throw new Error(`Login response missing user/org: ${JSON.stringify(login)}`);
  }

  // 2. Find "maneek's claude code"
  const rows = await db
    .select({
      id: schema.agentEmployees.id,
      slug: schema.agentEmployees.slug,
      trust_level: schema.agentEmployees.trust_level,
      mcp_token_hash: schema.agentEmployees.mcp_token_hash,
    })
    .from(schema.agentEmployees)
    .where(
      and(
        eq(schema.agentEmployees.org_id, orgId),
        or(
          ilike(schema.agentEmployees.name, '%maneek%claude%code%'),
          ilike(schema.agentEmployees.slug, '%maneek%claude%code%'),
        ),
      ),
    )
    .limit(1);
  const agent = rows[0];
  if (!agent) {
    throw new Error(`Could not find agent "maneek's claude code" in org ${orgId}. Create it via /settings/agent-employees/create first.`);
  }

  // 3. Snapshot existing token (idempotent — preserve first snapshot)
  if (!existsSync(SNAPSHOT_PATH)) {
    const snap: Snapshot = {
      agent_id: agent.id,
      agent_slug: agent.slug,
      org_id: orgId,
      original_hash: agent.mcp_token_hash,
      created_at: new Date().toISOString(),
    };
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(snap, null, 2));
  }

  // 4. Install a known token (always rotate fresh on bootstrap so reruns work)
  const rawToken = `byoatest_${randomBytes(24).toString('base64url')}`;
  const newHash = await bcrypt.hash(rawToken, 10);
  await db
    .update(schema.agentEmployees)
    .set({ mcp_token_hash: newHash })
    .where(eq(schema.agentEmployees.id, agent.id));

  return {
    apiUrl: API_URL,
    loginUserId,
    orgId,
    agent: { id: agent.id, slug: agent.slug, trust_level: agent.trust_level as string },
    rawToken,
  };
}

export async function restoreToken(): Promise<void> {
  if (!existsSync(SNAPSHOT_PATH)) {
    console.warn(`[restoreToken] no snapshot at ${SNAPSHOT_PATH}, nothing to do`);
    return;
  }
  const snap = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Snapshot;
  await db
    .update(schema.agentEmployees)
    .set({ mcp_token_hash: snap.original_hash })
    .where(eq(schema.agentEmployees.id, snap.agent_id));
  unlinkSync(SNAPSHOT_PATH);
  console.log('[restoreToken] original mcp_token_hash restored, snapshot deleted');
}

// CLI: invoked directly via `tsx bootstrap.ts` or `tsx bootstrap.ts --restore`.
// Uses path-comparison via fileURLToPath so it works on both Windows and POSIX.
function isMainModule(): boolean {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const argvFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return path.resolve(thisFile) === argvFile;
  } catch {
    return false;
  }
}

async function cliMain(): Promise<void> {
  const arg = process.argv[2];
  if (arg === '--restore') {
    await restoreToken();
    return;
  }
  const r = await bootstrap();
  // Emit shell-evalable env block on stdout
  process.stdout.write([
    `export DEFT_TEST_AGENT_ID='${r.agent.id}'`,
    `export DEFT_TEST_AGENT_SLUG='${r.agent.slug}'`,
    `export DEFT_TEST_AGENT_TOKEN='${r.rawToken}'`,
    `# trust_level=${r.agent.trust_level}, org_id=${r.orgId}`,
    '',
  ].join('\n'));
}

if (isMainModule()) {
  cliMain()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
}
