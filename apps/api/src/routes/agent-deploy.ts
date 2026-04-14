/**
 * Phase 8 — Wizard submission routes.
 *
 * Routes:
 *   POST /api/agents/deploy/start        — wizard submission. Creates a
 *                                          pending agent_employees row and
 *                                          kicks off provisioning in a worker.
 *   GET  /api/agents/deploy/:id/status   — wizard polls this every 2s.
 *   POST /api/agents/deploy/:id/handshake — hits <url>/v1/models.
 *   GET  /api/agents/deploy/wizard-config — static lookup (templates, packs,
 *                                          provider cards) for the UI.
 *
 * This route file is NEW. Existing agent-employees.ts is not touched (see
 * plan constraints — frozen for the flows Phase 3-6.5 depend on).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, eq } from 'drizzle-orm';
import { db } from '../lib/db.js';
import {
  agentEmployees,
  integrations,
  providerInstances,
  users,
  agentEmployeeTemplates,
  orgs,
} from '@deft/db/schema';
import { encrypt, decrypt } from '../lib/encryption.js';
import {
  CAPABILITY_PACKS,
  TEMPLATE_DEFAULT_PACKS,
  getCapabilityPack,
} from '../lib/capability-packs.js';
import { listWizardProviders, getProvider } from '../lib/deployment/index.js';
import { enqueue } from '../lib/queues.js';
import { env } from '../lib/env.js';

export const agentDeployRoutes = new Hono();

// ─── Wizard config ───────────────────────────────────────────────────
agentDeployRoutes.get('/wizard-config', async (c) => {
  // Phase 9: the wizard reads templates ONLY from the real table. The
  // synthesised alex-pm fallback from Phase 8 has been removed — if the
  // table is empty, we return a pointed error telling the operator how
  // to seed it.
  const templates = await db
    .select({
      slug: agentEmployeeTemplates.slug,
      name: agentEmployeeTemplates.name,
      description: agentEmployeeTemplates.description,
      version: agentEmployeeTemplates.version,
      role: agentEmployeeTemplates.role,
      default_trust_level: agentEmployeeTemplates.default_trust_level,
      default_trigger_subscriptions: agentEmployeeTemplates.default_trigger_subscriptions,
      default_capability_packs: agentEmployeeTemplates.default_capability_packs,
    })
    .from(agentEmployeeTemplates)
    .where(eq(agentEmployeeTemplates.is_public, true));

  if (templates.length === 0) {
    return c.json(
      {
        error:
          'No templates available. Run `pnpm tsx apps/api/src/scripts/seed-templates.ts` to seed the defaults.',
        code: 'TEMPLATES_NOT_SEEDED',
      },
      500,
    );
  }

  // Phase 9 — all 8 first-party templates are fully implemented. The
  // `ready_in_phase_8` flag is retained on the wire for backward compat
  // with any older wizard UI still in the field, but now returns `true`
  // for every template so no cards are disabled.
  const templateCards = templates.map((t) => ({
    ...t,
    ready_in_phase_8: true,
    // Prefer the DB column; fall back to the Phase 8 hashmap for rows
    // that predate migration 0016 and haven't been re-seeded yet.
    default_capability_packs:
      t.default_capability_packs ?? TEMPLATE_DEFAULT_PACKS[t.slug] ?? [],
  }));

  return c.json({
    templates: templateCards,
    capability_packs: CAPABILITY_PACKS,
    providers: listWizardProviders(),
  });
});

// ─── Submit wizard form ───────────────────────────────────────────────
const StartSchema = z.object({
  template_slug: z.string().min(1),
  name: z.string().min(1).max(100),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  capability_packs: z.array(z.string()).default([]),
  capability_pack_secrets: z.record(z.string(), z.string()).default({}),
  provider: z.enum(['railway', 'byo', 'deft_cloud']),
  integration_id: z.string().optional(),
  byo_connection_url: z.string().url().optional(),
  byo_gateway_token: z.string().optional(),
  trigger_subscriptions: z.array(z.string()).default([]),
  trust_level: z.enum(['conservative', 'standard']).default('standard'),
  anthropic_api_key: z.string().optional(),
});

agentDeployRoutes.post('/start', async (c) => {
  const user = c.get('user');
  const parsed = StartSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: 'Invalid payload', details: parsed.error.issues }, 400);
  }
  const body = parsed.data;

  // Provider-specific validation
  if (body.provider === 'deft_cloud') {
    return c.json(
      { error: 'Deft Cloud is coming soon — use Railway Managed or BYO for now', code: 'COMING_SOON' },
      400,
    );
  }
  if (body.provider === 'byo') {
    if (!body.byo_connection_url || !body.byo_gateway_token) {
      return c.json(
        { error: 'BYO provider requires byo_connection_url + byo_gateway_token', code: 'MISSING_FIELDS' },
        400,
      );
    }
  }
  if (body.provider === 'railway') {
    if (!body.integration_id) {
      return c.json(
        { error: 'Railway provider requires integration_id (connect Railway first)', code: 'MISSING_INTEGRATION' },
        400,
      );
    }
  }

  // Trigger uniqueness: block deploy if any other employee in the org
  // already claims one of the requested triggers.
  if (body.trigger_subscriptions.length > 0) {
    const existing = await db
      .select({
        id: agentEmployees.id,
        slug: agentEmployees.slug,
        trigger_subscriptions: agentEmployees.trigger_subscriptions,
      })
      .from(agentEmployees)
      .where(and(eq(agentEmployees.org_id, user.org_id), eq(agentEmployees.is_active, true)));

    for (const emp of existing) {
      for (const claim of emp.trigger_subscriptions ?? []) {
        if (body.trigger_subscriptions.includes(claim)) {
          return c.json(
            {
              error: `Trigger "${claim}" is already claimed by employee ${emp.slug}`,
              code: 'TRIGGER_CONFLICT',
            },
            409,
          );
        }
      }
    }
  }

  // Capability pack sanity check — user_provides_secret packs need a secret.
  const missingSecrets: string[] = [];
  for (const slug of body.capability_packs) {
    const pack = getCapabilityPack(slug);
    if (!pack) continue;
    if (pack.user_provides_secret && pack.provider_env_var) {
      if (!body.capability_pack_secrets[pack.provider_env_var]) {
        missingSecrets.push(pack.display_name);
      }
    }
  }
  // Missing secrets are a warning, not a blocker — the wizard can choose
  // to disable those packs client-side. We echo them back in the response.

  // Shadow user for this employee (matches Phase 2 convention).
  const empId = crypto.randomUUID();
  const shadowUserId = crypto.randomUUID();
  await db.insert(users).values({
    id: shadowUserId,
    email: `${body.slug}+${empId.slice(0, 8)}@agent.deft.local`,
    name: body.name,
    is_agent: true,
    agent_employee_id: empId,
  });

  // Generate tokens. Gateway token stored encrypted; MCP token stored as
  // bcrypt hash just like existing Phase 3 flow.
  const rawGatewayToken =
    body.provider === 'byo' ? body.byo_gateway_token! : randomBytes(32).toString('base64url');
  const rawMcpToken = randomBytes(32).toString('base64url');
  const mcpTokenHash = await bcrypt.hash(rawMcpToken, 10);

  // For BYO the connection_url is known upfront; Railway fills it in later.
  const connectionUrl = body.provider === 'byo' ? body.byo_connection_url! : null;

  await db.insert(agentEmployees).values({
    id: empId,
    org_id: user.org_id,
    user_id: shadowUserId,
    name: body.name,
    slug: body.slug,
    role:
      body.template_slug === 'alex-pm'
        ? 'project_manager'
        : body.template_slug === 'designer'
          ? 'custom'
          : 'custom',
    system_prompt: `You are ${body.name}, deployed via the Phase 8 setup wizard using the ${body.template_slug} template.`,
    kind: 'openclaw',
    deployment_provider: body.provider,
    connection_url: connectionUrl,
    gateway_token_encrypted: encrypt(rawGatewayToken),
    mcp_token_hash: mcpTokenHash,
    connection_status: 'pending',
    template_slug: body.template_slug,
    template_version: '1.0.0',
    trigger_subscriptions: body.trigger_subscriptions,
    trust_level: body.trust_level,
    capability_packs: body.capability_packs,
    created_by: user.id,
  });

  // Kick off provisioning asynchronously. The worker finishes the
  // provider_instances row + updates connection_url/status.
  await enqueue('agent-jobs', 'deploy-provision', {
    employee_id: empId,
    raw_gateway_token: rawGatewayToken,
    raw_mcp_token: rawMcpToken,
    integration_id: body.integration_id ?? null,
    byo_connection_url: body.byo_connection_url ?? null,
    capability_pack_secrets: body.capability_pack_secrets ?? {},
    anthropic_api_key: body.anthropic_api_key ?? env.ANTHROPIC_API_KEY,
    deft_api_url: env.NEXT_PUBLIC_APP_URL.replace(':3000', ':3001'),
  });

  return c.json({
    employee_id: empId,
    status: 'pending',
    missing_secrets: missingSecrets,
  });
});

// ─── Poll provisioning status ─────────────────────────────────────────
agentDeployRoutes.get('/:id/status', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const [row] = await db
    .select({
      id: agentEmployees.id,
      connection_status: agentEmployees.connection_status,
      connection_url: agentEmployees.connection_url,
      connection_error: agentEmployees.connection_error,
      deployment_provider: agentEmployees.deployment_provider,
      provider_instance_id: agentEmployees.provider_instance_id,
    })
    .from(agentEmployees)
    .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)))
    .limit(1);
  if (!row) {
    return c.json({ error: 'Employee not found', code: 'NOT_FOUND' }, 404);
  }

  let providerInstance = null;
  if (row.provider_instance_id) {
    const [pi] = await db
      .select({
        id: providerInstances.id,
        status: providerInstances.status,
        provider: providerInstances.provider,
        external_instance_id: providerInstances.external_instance_id,
        provider_metadata: providerInstances.provider_metadata,
      })
      .from(providerInstances)
      .where(eq(providerInstances.id, row.provider_instance_id))
      .limit(1);
    providerInstance = pi ?? null;
  }

  return c.json({ employee: row, provider_instance: providerInstance });
});

// ─── Handshake test ──────────────────────────────────────────────────
agentDeployRoutes.post('/:id/handshake', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const [emp] = await db
    .select()
    .from(agentEmployees)
    .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, user.org_id)))
    .limit(1);
  if (!emp) return c.json({ error: 'Employee not found', code: 'NOT_FOUND' }, 404);
  if (!emp.connection_url) {
    return c.json({ success: false, error: 'No connection_url set' }, 400);
  }

  const base = emp.connection_url.replace(/\/$/, '');
  let gatewayToken = '';
  try {
    gatewayToken = emp.gateway_token_encrypted ? decrypt(emp.gateway_token_encrypted) : '';
  } catch {
    // Ignore — fallback to no-auth handshake, will likely 401 which is itself informative
  }
  try {
    const res = await fetch(`${base}/v1/models`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(gatewayToken ? { Authorization: `Bearer ${gatewayToken}` } : {}),
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      await db
        .update(agentEmployees)
        .set({ connection_status: 'error', connection_error: `Handshake HTTP ${res.status}` })
        .where(eq(agentEmployees.id, id));
      return c.json({ success: false, error: `HTTP ${res.status}` });
    }
    const body = (await res.json()) as any;
    const models: Array<{ id: string }> = body.data || body.models || [];
    const expected = `openclaw/${emp.slug}`;
    const anyExpected = models.some((m) => m.id === expected || m.id === 'default');
    if (!anyExpected && models.length === 0) {
      await db
        .update(agentEmployees)
        .set({ connection_status: 'error', connection_error: 'Empty models list from Gateway' })
        .where(eq(agentEmployees.id, id));
      return c.json({ success: false, error: 'Empty models list' });
    }
    await db
      .update(agentEmployees)
      .set({ connection_status: 'connected', connection_error: null })
      .where(eq(agentEmployees.id, id));
    return c.json({ success: true, models: models.map((m) => m.id) });
  } catch (err) {
    await db
      .update(agentEmployees)
      .set({ connection_status: 'error', connection_error: (err as Error).message })
      .where(eq(agentEmployees.id, id));
    return c.json({ success: false, error: (err as Error).message });
  }
});
