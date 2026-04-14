/**
 * Phase 8 — Railway managed deployment provider.
 *
 * Provisions OpenClaw employees onto the user's Railway workspace via the
 * Railway GraphQL API. Deft handles project/service creation, env var
 * injection, deploy triggering, and status polling. The user pays Railway
 * directly for compute; Deft adds an orchestration fee (wired in v1.1).
 *
 * Provision flow:
 *   1. Decrypt + refresh the integration's access token
 *   2. Create a Railway project if we don't already have one cached
 *   3. Create a service pointing at ghcr.io/openclaw/openclaw:latest
 *   4. Trigger the first deploy (if not triggered automatically)
 *   5. Poll for SUCCESS / FAILED with a 5-minute timeout
 *   6. Fetch or create the public railway.app domain
 *   7. Return the ProvisionResult; caller persists the provider_instance row
 */
import type {
  DeployContext,
  DeploymentProvider,
  InstanceStatus,
  ProviderInstanceRecord,
  ProvisionResult,
} from './types.js';
import {
  createRailwayProject,
  createRailwayService,
  deployRailwayService,
  destroyRailwayService,
  getRailwayServiceDomain,
  getRailwayServiceStatus,
  RailwayApiError,
} from '../railway-client.js';
import { getFreshIntegrationAccessToken } from './integration-tokens.js';
import { eq } from 'drizzle-orm';
import { db } from '../db.js';
import { integrations } from '@deft/db/schema';

const OPENCLAW_IMAGE = 'ghcr.io/openclaw/openclaw:latest';

const PROVISION_TIMEOUT_MS = 5 * 60 * 1000;
const STATUS_POLL_INTERVAL_MS = 5000;
const BUILD_WAIT_BEFORE_POLL_MS = 5000;

export class RailwayProvider implements DeploymentProvider {
  readonly id = 'railway' as const;
  readonly displayName = 'Railway Managed';
  readonly isManaged = true;
  readonly isAvailable = true;
  readonly comingSoon = false;

  async provision(ctx: DeployContext): Promise<ProvisionResult> {
    if (!ctx.integration) {
      throw new Error('RailwayProvider.provision requires an integration');
    }
    const token = await getFreshIntegrationAccessToken(ctx.integration.id);

    // Step 1: Ensure a project exists — reuse a cached one per integration.
    let projectId = ctx.integration.external_default_project_id;
    let environmentId: string | undefined;
    if (!projectId) {
      const project = await createRailwayProject(token, {
        name: `deft-${ctx.org.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-employees`,
        workspaceId: ctx.integration.external_workspace_id ?? undefined,
      });
      projectId = project.id;
      environmentId = project.environments[0]?.id;
      await db
        .update(integrations)
        .set({ external_default_project_id: projectId })
        .where(eq(integrations.id, ctx.integration.id));
    }

    if (!environmentId) {
      // Reusing a cached project — we need to look up its environments.
      // The plan assumes the user didn't delete them; if they did,
      // provisioning fails and the error surfaces in the wizard.
      const { railwayGraphQL } = await import('../railway-client.js');
      const data = await railwayGraphQL<{
        project: { environments: { edges: Array<{ node: { id: string } }> } } | null;
      }>(
        token,
        `query ProjEnv($id: String!) { project(id: $id) { environments { edges { node { id } } } } }`,
        { id: projectId },
      );
      environmentId = data.project?.environments?.edges?.[0]?.node?.id;
      if (!environmentId) {
        throw new Error(
          `Railway project ${projectId} has no environments — ensure it's not empty`,
        );
      }
    }

    // Step 2: Create service with env vars baked in.
    const variables = this.buildEnvVars(ctx);
    const service = await createRailwayService(token, {
      projectId,
      environmentId,
      name: ctx.employee.slug,
      imageSource: OPENCLAW_IMAGE,
      variables,
    });

    // Step 3: Trigger deploy (some Railway flows auto-deploy on create).
    try {
      await deployRailwayService(token, service.id, environmentId);
    } catch (err) {
      if (err instanceof RailwayApiError) {
        // Swallow — serviceCreate may already have queued a deploy.
      } else {
        throw err;
      }
    }

    // Step 4: Wait briefly for the build to start, then poll status.
    await sleep(BUILD_WAIT_BEFORE_POLL_MS);
    const finalStatus = await this.pollUntilTerminal(
      token,
      service.id,
      environmentId,
      PROVISION_TIMEOUT_MS,
    );
    if (finalStatus !== 'running') {
      // Best effort: destroy the service so the user isn't billed for a
      // broken deploy. Swallow errors — destroy is a nice-to-have here.
      try {
        await destroyRailwayService(token, service.id);
      } catch {}
      throw new Error(
        `Railway deployment failed: service status is ${finalStatus}`,
      );
    }

    // Step 5: Fetch public domain.
    let connectionUrl = '';
    try {
      connectionUrl = await getRailwayServiceDomain(
        token,
        service.id,
        environmentId,
      );
    } catch {
      // Ignore — we'll return the empty URL and let the caller surface it.
    }

    return {
      external_instance_id: service.id,
      external_project_id: projectId,
      external_environment_id: environmentId,
      connection_url: connectionUrl,
      provider_metadata: {
        railway_project_id: projectId,
        railway_environment_id: environmentId,
        railway_service_id: service.id,
        image: OPENCLAW_IMAGE,
        connection_url: connectionUrl,
      },
      estimated_cost_usd_cents_monthly: this.estimateCostUsdCents(),
    };
  }

  async getStatus(instance: ProviderInstanceRecord): Promise<InstanceStatus> {
    if (!instance.integration_id) return 'unknown';
    if (!instance.external_instance_id || !instance.external_environment_id) {
      return 'unknown';
    }
    try {
      const token = await getFreshIntegrationAccessToken(instance.integration_id);
      return await getRailwayServiceStatus(
        token,
        instance.external_instance_id,
        instance.external_environment_id,
      );
    } catch {
      return 'unknown';
    }
  }

  async destroy(instance: ProviderInstanceRecord): Promise<void> {
    if (!instance.integration_id || !instance.external_instance_id) return;
    const token = await getFreshIntegrationAccessToken(instance.integration_id);
    await destroyRailwayService(token, instance.external_instance_id);
  }

  estimateCostUsdCents(): number | null {
    return 500; // $5/mo placeholder for a small Railway service
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private buildEnvVars(ctx: DeployContext): Record<string, string> {
    const vars: Record<string, string> = {
      ANTHROPIC_API_KEY: ctx.anthropicApiKey,
      OPENCLAW_GATEWAY_TOKEN: ctx.gatewayToken,
      DEFT_MCP_TOKEN: ctx.deftMcpToken,
      DEFT_API_URL: ctx.deftApiUrl,
      DEFT_EMPLOYEE_SLUG: ctx.employee.slug,
    };
    for (const [k, v] of Object.entries(ctx.capabilityPackSecrets || {})) {
      vars[k] = v;
    }
    return vars;
  }

  private async pollUntilTerminal(
    token: string,
    serviceId: string,
    environmentId: string,
    timeoutMs: number,
  ): Promise<InstanceStatus> {
    const deadline = Date.now() + timeoutMs;
    let last: InstanceStatus = 'unknown';
    while (Date.now() < deadline) {
      last = await getRailwayServiceStatus(token, serviceId, environmentId);
      if (last === 'running' || last === 'crashed' || last === 'destroyed') {
        return last;
      }
      await sleep(STATUS_POLL_INTERVAL_MS);
    }
    return last;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
