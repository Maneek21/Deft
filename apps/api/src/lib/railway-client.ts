/**
 * Phase 8 — Railway GraphQL client.
 *
 * Thin wrapper around Railway's `https://backboard.railway.com/graphql/v2`
 * endpoint. One exported `railwayGraphQL` primitive, plus a handful of
 * strongly-typed mutation/query helpers that the DeploymentProvider calls.
 *
 * Railway's API is versioned by endpoint (currently v2). The plan doc §8
 * pins the OpenClaw container image at `ghcr.io/openclaw/openclaw:latest`.
 *
 * Rate limits (Hobby tier): 1000 requests/hour, ~10 RPS. More than enough
 * for orchestration. Every call wraps its error in a RailwayApiError with
 * the full GraphQL error body attached for debugging.
 *
 * Empirical notes (filled in during Phase 8 dev):
 *   - Post-creation env var updates: Railway exposes `variableSet` mutation
 *     taking `{projectId, environmentId, serviceId, name, value}`. We use
 *     this to add secrets after service creation when necessary.
 *   - Public domain query: `service(id).serviceInstances.edges.node.domains`
 *     returns both `serviceDomains` (railway.app subdomains) and `customDomains`.
 *     If no domain is attached we call `serviceDomainCreate` to spawn a
 *     *.up.railway.app domain.
 *   - DeploymentStatus enum values observed: BUILDING, INITIALIZING,
 *     DEPLOYING, SUCCESS, FAILED, CRASHED, REMOVED, REMOVING, SKIPPED,
 *     QUEUED, WAITING. Mapping in getRailwayServiceStatus() below.
 *
 * If any of the above shapes drift, introspect the live schema with:
 *   { __schema { mutationType { fields { name } } } }
 * and update this file accordingly.
 */
import type { InstanceStatus } from './deployment/types.js';

export const RAILWAY_GRAPHQL_ENDPOINT =
  process.env.RAILWAY_GRAPHQL_ENDPOINT || 'https://backboard.railway.com/graphql/v2';

export class RailwayApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly errorBody?: unknown,
  ) {
    super(message);
    this.name = 'RailwayApiError';
  }
}

/**
 * Execute a raw GraphQL query against Railway. Throws `RailwayApiError` on
 * non-2xx or GraphQL-level errors. The `token` must be a raw access token
 * from the integration (already decrypted + refreshed by the caller).
 */
export async function railwayGraphQL<T = unknown>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(RAILWAY_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    throw new RailwayApiError(
      0,
      'network',
      `Railway API network error: ${(err as Error).message}`,
    );
  }

  let body: any;
  try {
    body = await res.json();
  } catch {
    throw new RailwayApiError(
      res.status,
      'bad_response',
      `Railway API returned non-JSON response (status ${res.status})`,
    );
  }

  if (!res.ok) {
    throw new RailwayApiError(
      res.status,
      'http_error',
      `Railway API HTTP ${res.status}: ${JSON.stringify(body?.errors ?? body)}`,
      body,
    );
  }

  if (body?.errors?.length) {
    throw new RailwayApiError(
      200,
      'graphql_error',
      `Railway GraphQL errors: ${body.errors.map((e: any) => e.message).join('; ')}`,
      body.errors,
    );
  }

  return body.data as T;
}

// ─── Helpers ──────────────────────────────────────────────────────────

export type RailwayProject = {
  id: string;
  name: string;
  environments: { edges: Array<{ node: { id: string; name: string } }> };
};

export async function createRailwayProject(
  token: string,
  input: { name: string; workspaceId?: string },
): Promise<{ id: string; environments: Array<{ id: string; name: string }> }> {
  const query = `
    mutation CreateProject($input: ProjectCreateInput!) {
      projectCreate(input: $input) {
        id
        name
        environments {
          edges { node { id name } }
        }
      }
    }
  `;
  const vars: Record<string, unknown> = { input: { name: input.name } };
  if (input.workspaceId) (vars.input as any).teamId = input.workspaceId;
  const data = await railwayGraphQL<{ projectCreate: RailwayProject }>(
    token,
    query,
    vars,
  );
  return {
    id: data.projectCreate.id,
    environments: data.projectCreate.environments.edges.map((e) => ({
      id: e.node.id,
      name: e.node.name,
    })),
  };
}

export async function createRailwayService(
  token: string,
  input: {
    projectId: string;
    environmentId: string;
    name: string;
    imageSource: string;
    variables: Record<string, string>;
  },
): Promise<{ id: string }> {
  const query = `
    mutation CreateService($input: ServiceCreateInput!) {
      serviceCreate(input: $input) {
        id
        name
      }
    }
  `;
  const vars = {
    input: {
      projectId: input.projectId,
      name: input.name,
      source: { image: input.imageSource },
      variables: input.variables,
    },
  };
  const data = await railwayGraphQL<{ serviceCreate: { id: string; name: string } }>(
    token,
    query,
    vars,
  );
  return { id: data.serviceCreate.id };
}

export async function deployRailwayService(
  token: string,
  serviceId: string,
  environmentId: string,
): Promise<{ id: string; status: string }> {
  const query = `
    mutation Deploy($serviceId: String!, $environmentId: String!) {
      serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) {
        id
        status
      }
    }
  `;
  try {
    const data = await railwayGraphQL<{
      serviceInstanceDeployV2: { id: string; status: string };
    }>(token, query, { serviceId, environmentId });
    return data.serviceInstanceDeployV2;
  } catch (err) {
    // Some Railway environments deploy automatically after serviceCreate
    // and reject an explicit deploy. Treat that as a soft no-op.
    if (err instanceof RailwayApiError && err.code === 'graphql_error') {
      return { id: '', status: 'BUILDING' };
    }
    throw err;
  }
}

export async function getRailwayServiceStatus(
  token: string,
  serviceId: string,
  environmentId: string,
): Promise<InstanceStatus> {
  const query = `
    query ServiceStatus($serviceId: String!, $environmentId: String!) {
      serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
        latestDeployment {
          id
          status
          createdAt
        }
      }
    }
  `;
  const data = await railwayGraphQL<{
    serviceInstance: { latestDeployment: { status: string } | null } | null;
  }>(token, query, { serviceId, environmentId });
  const status = data.serviceInstance?.latestDeployment?.status?.toUpperCase?.();
  return mapRailwayDeploymentStatus(status);
}

export function mapRailwayDeploymentStatus(
  raw: string | undefined | null,
): InstanceStatus {
  if (!raw) return 'unknown';
  switch (raw) {
    case 'SUCCESS':
      return 'running';
    case 'BUILDING':
    case 'INITIALIZING':
    case 'DEPLOYING':
    case 'QUEUED':
    case 'WAITING':
      return 'provisioning';
    case 'FAILED':
    case 'CRASHED':
      return 'crashed';
    case 'REMOVED':
    case 'REMOVING':
      return 'destroyed';
    case 'SKIPPED':
    case 'STOPPED':
      return 'stopped';
    default:
      return 'unknown';
  }
}

export async function getRailwayServiceDomain(
  token: string,
  serviceId: string,
  environmentId: string,
): Promise<string> {
  const query = `
    query ServiceDomain($serviceId: String!, $environmentId: String!) {
      serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
        domains {
          serviceDomains { domain }
          customDomains { domain }
        }
      }
    }
  `;
  const data = await railwayGraphQL<{
    serviceInstance: {
      domains: {
        serviceDomains: Array<{ domain: string }>;
        customDomains: Array<{ domain: string }>;
      };
    } | null;
  }>(token, query, { serviceId, environmentId });

  const domains = data.serviceInstance?.domains;
  const custom = domains?.customDomains?.[0]?.domain;
  if (custom) return `https://${custom}`;
  const svc = domains?.serviceDomains?.[0]?.domain;
  if (svc) return `https://${svc}`;

  // No attached domain — create one. Falls back to an empty string if the
  // provisioning mutation isn't available in this Railway account tier.
  try {
    await createRailwayServiceDomain(token, serviceId, environmentId);
  } catch {
    return '';
  }
  // Re-poll.
  const data2 = await railwayGraphQL<{
    serviceInstance: {
      domains: { serviceDomains: Array<{ domain: string }> };
    } | null;
  }>(token, query, { serviceId, environmentId });
  const svc2 = data2.serviceInstance?.domains?.serviceDomains?.[0]?.domain;
  return svc2 ? `https://${svc2}` : '';
}

export async function createRailwayServiceDomain(
  token: string,
  serviceId: string,
  environmentId: string,
): Promise<void> {
  const query = `
    mutation CreateDomain($serviceId: String!, $environmentId: String!) {
      serviceDomainCreate(input: { serviceId: $serviceId, environmentId: $environmentId }) {
        id
      }
    }
  `;
  await railwayGraphQL(token, query, { serviceId, environmentId });
}

export async function destroyRailwayService(
  token: string,
  serviceId: string,
): Promise<void> {
  const query = `
    mutation DeleteService($id: String!) {
      serviceDelete(id: $id)
    }
  `;
  await railwayGraphQL(token, query, { id: serviceId });
}

/** Introspect the Railway account's workspaces + the authenticated user. */
export async function getRailwayMe(
  token: string,
): Promise<{
  email: string;
  workspaces: Array<{ id: string; name: string }>;
}> {
  const query = `
    query Me {
      me {
        email
        workspaces {
          id
          name
        }
      }
    }
  `;
  try {
    const data = await railwayGraphQL<{
      me: { email: string; workspaces: Array<{ id: string; name: string }> };
    }>(token, query);
    return data.me;
  } catch (err) {
    // Fall back to `teams` if `workspaces` isn't the field name in this API version.
    const fallbackQuery = `
      query Me {
        me {
          email
          teams {
            edges { node { id name } }
          }
        }
      }
    `;
    const data = await railwayGraphQL<{
      me: { email: string; teams?: { edges: Array<{ node: { id: string; name: string } }> } };
    }>(token, fallbackQuery);
    return {
      email: data.me.email,
      workspaces: data.me.teams?.edges?.map((e) => e.node) ?? [],
    };
  }
}
