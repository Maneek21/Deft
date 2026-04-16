/**
 * Phase 8 — deploy-provision worker handler.
 *
 * Picks up a wizard submission from the job queue, dispatches to the
 * correct DeploymentProvider, and updates the employee + provider_instance
 * rows based on the result.
 *
 * On success:
 *   - provider_instances row inserted with status='running'
 *   - agent_employees row updated: connection_url, provider_instance_id,
 *     connection_status='connected', connection_error=null
 *
 * On failure:
 *   - provider_instances row inserted with status='crashed' (best effort)
 *   - agent_employees row updated: connection_status='error',
 *     connection_error set to the provider's error message
 *
 * The deploy-provision job is non-retryable for managed providers (Railway)
 * because the first attempt may partially create resources; blind retries
 * would leak projects and services. The user clicks "Retry" in the wizard
 * which re-issues the job with a fresh employee row.
 */
import { eq } from 'drizzle-orm';
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import {
  agentEmployees,
  agentEmployeeSkills,
  integrations,
  providerInstances,
  orgs,
  agentEmployeeTemplates,
  skills,
} from '@deft/db/schema';
import type { SkillAgentConfig } from '../../lib/skill-config.js';
import { getProvider } from '../../lib/deployment/index.js';
import type {
  DeployContext,
  DeploymentProviderId,
  ProvisionResult,
} from '../../lib/deployment/types.js';

type DeployProvisionJob = {
  employee_id: string;
  raw_gateway_token: string;
  raw_mcp_token: string;
  integration_id: string | null;
  byo_connection_url: string | null;
  capability_pack_secrets: Record<string, string>;
  anthropic_api_key: string;
  deft_api_url: string;
};

export async function handleDeployProvision(job: JobData): Promise<void> {
  const data = job.data as DeployProvisionJob;

  const [emp] = await db
    .select()
    .from(agentEmployees)
    .where(eq(agentEmployees.id, data.employee_id))
    .limit(1);
  if (!emp) {
    console.warn(`[deploy-provision] Employee ${data.employee_id} not found`);
    return;
  }

  const providerId = emp.deployment_provider as DeploymentProviderId | null;
  if (!providerId) {
    await markEmployeeError(emp.id, 'No deployment_provider set on employee row');
    return;
  }

  const provider = getProvider(providerId);

  // Load integration row (optional — BYO has none).
  let integrationRow = null;
  if (data.integration_id) {
    const [row] = await db
      .select()
      .from(integrations)
      .where(eq(integrations.id, data.integration_id))
      .limit(1);
    integrationRow = row ?? null;
  }

  // Load org.
  const [org] = await db.select().from(orgs).where(eq(orgs.id, emp.org_id)).limit(1);

  // Load template bootstrap files (best-effort).
  let soulMd = '# SOUL\nYou are an employee.';
  let agentsMd = '# AGENTS\nCall deft_platform_context first.';
  let userMd = `# USER\nOrg: ${org?.name ?? 'Unknown'}`;
  let toolsMd = '# TOOLS';
  if (emp.template_slug) {
    const [tpl] = await db
      .select()
      .from(agentEmployeeTemplates)
      .where(eq(agentEmployeeTemplates.slug, emp.template_slug))
      .limit(1);
    if (tpl) {
      soulMd = tpl.soul_md;
      agentsMd = tpl.agents_md;
      userMd = tpl.user_md_template;
      toolsMd = tpl.tools_md;
    }
  }

  const ctx: DeployContext = {
    employee: {
      id: emp.id,
      org_id: emp.org_id,
      slug: emp.slug,
      name: emp.name,
      template_slug: emp.template_slug,
      template_version: emp.template_version,
    },
    org: {
      id: org?.id ?? emp.org_id,
      name: org?.name ?? 'Unknown',
      timezone: org?.timezone ?? 'UTC',
    },
    integration: integrationRow ?? undefined,
    soulMd,
    agentsMd,
    userMd,
    toolsMd,
    gatewayToken: data.raw_gateway_token,
    deftMcpToken: data.raw_mcp_token,
    anthropicApiKey: data.anthropic_api_key,
    capabilityPackSlugs: await resolveCapabilityPackSlugs(emp),
    capabilityPackSecrets: data.capability_pack_secrets,
    deftApiUrl: data.deft_api_url,
    byoConnectionUrl: data.byo_connection_url ?? undefined,
  };

  let result: ProvisionResult;
  try {
    result = await provider.provision(ctx);
  } catch (err) {
    await markEmployeeError(emp.id, (err as Error).message);
    return;
  }

  // Persist provider_instances row.
  const piId = crypto.randomUUID();
  await db.insert(providerInstances).values({
    id: piId,
    org_id: emp.org_id,
    employee_id: emp.id,
    provider: providerId,
    integration_id: data.integration_id ?? null,
    external_instance_id: result.external_instance_id,
    external_project_id: result.external_project_id,
    external_environment_id: result.external_environment_id,
    provider_metadata: result.provider_metadata,
    cost_usd_cents_monthly: result.estimated_cost_usd_cents_monthly,
    deft_orchestration_fee_usd_cents_monthly: 0,
    status: 'running',
    last_status_check_at: new Date(),
  });

  await db
    .update(agentEmployees)
    .set({
      connection_url: result.connection_url || null,
      connection_status: result.connection_url ? 'connected' : 'pending',
      connection_error: null,
      provider_instance_id: piId,
    })
    .where(eq(agentEmployees.id, emp.id));
}

/**
 * Phase 4 Task 4.4 — dual-read shim for capability packs.
 *
 * Transitional helper: unions the legacy `agent_employees.capability_packs[]`
 * inline column with packs derived from bundled skills installed via the
 * `agent_employee_skills` junction (skills.agent_config.capability_packs[]).
 *
 * Background: before Phase 4 a deployment's capability packs lived as a
 * text[] on the employee row. Phase 4 promoted packs to bundled skills so
 * the same primitive can be composed, versioned, and extended by org-
 * authored and marketplace skills. During the cut-over both sources are
 * live; Task 4.12 deletes the legacy column and this shim collapses back
 * to a single query.
 */
async function resolveCapabilityPackSlugs(emp: {
  id: string;
  capability_packs?: string[] | null;
}): Promise<string[]> {
  const inline = emp.capability_packs ?? [];
  const skillRows = await db
    .select({ cfg: skills.agent_config })
    .from(agentEmployeeSkills)
    .innerJoin(skills, eq(skills.id, agentEmployeeSkills.skill_id))
    .where(eq(agentEmployeeSkills.agent_employee_id, emp.id));
  const skillPacks = skillRows.flatMap((row) => {
    const cfg = (row.cfg ?? {}) as SkillAgentConfig;
    return cfg.capability_packs ?? [];
  });
  return [...new Set([...inline, ...skillPacks])];
}

async function markEmployeeError(employeeId: string, message: string) {
  await db
    .update(agentEmployees)
    .set({
      connection_status: 'error',
      connection_error: message.slice(0, 4000),
    })
    .where(eq(agentEmployees.id, employeeId));
}
