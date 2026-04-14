/**
 * Phase 8 — RailwayProvider unit tests.
 *
 * Covers:
 *   1. mapRailwayDeploymentStatus handles all known enum values
 *   2. railwayGraphQL error paths (HTTP 4xx + GraphQL errors)
 *   3. createRailwayService + deployRailwayService happy-path posts
 *      the expected query + returns the parsed id
 *
 * The full provision() flow hits the integrations table (DB-coupled) so we
 * cover it end-to-end via the agent-deploy-routes test harness instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapRailwayDeploymentStatus,
  railwayGraphQL,
  createRailwayProject,
  createRailwayService,
  deployRailwayService,
  getRailwayServiceStatus,
  getRailwayServiceDomain,
  destroyRailwayService,
  RailwayApiError,
} from '../src/lib/railway-client.js';

type FetchCall = { url: string; body: any; headers: Record<string, string> };

function mockFetch(responder: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call = { url: String(url), body, headers };
    calls.push(call);
    return responder(call);
  }) as any;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test('mapRailwayDeploymentStatus covers all known enum values', () => {
  assert.equal(mapRailwayDeploymentStatus('SUCCESS'), 'running');
  assert.equal(mapRailwayDeploymentStatus('BUILDING'), 'provisioning');
  assert.equal(mapRailwayDeploymentStatus('INITIALIZING'), 'provisioning');
  assert.equal(mapRailwayDeploymentStatus('DEPLOYING'), 'provisioning');
  assert.equal(mapRailwayDeploymentStatus('QUEUED'), 'provisioning');
  assert.equal(mapRailwayDeploymentStatus('WAITING'), 'provisioning');
  assert.equal(mapRailwayDeploymentStatus('FAILED'), 'crashed');
  assert.equal(mapRailwayDeploymentStatus('CRASHED'), 'crashed');
  assert.equal(mapRailwayDeploymentStatus('REMOVED'), 'destroyed');
  assert.equal(mapRailwayDeploymentStatus('REMOVING'), 'destroyed');
  assert.equal(mapRailwayDeploymentStatus('STOPPED'), 'stopped');
  assert.equal(mapRailwayDeploymentStatus('WHAT_IS_THIS'), 'unknown');
  assert.equal(mapRailwayDeploymentStatus(null), 'unknown');
  assert.equal(mapRailwayDeploymentStatus(undefined), 'unknown');
});

test('railwayGraphQL throws RailwayApiError on HTTP 5xx', async () => {
  const m = mockFetch(() => new Response(JSON.stringify({ errors: [{ message: 'boom' }] }), { status: 500 }));
  try {
    await assert.rejects(
      () => railwayGraphQL('token', '{ foo }', {}),
      (err: any) => {
        assert.ok(err instanceof RailwayApiError);
        assert.equal(err.status, 500);
        return true;
      },
    );
  } finally {
    m.restore();
  }
});

test('railwayGraphQL throws RailwayApiError on GraphQL-level errors', async () => {
  const m = mockFetch(() =>
    new Response(
      JSON.stringify({ errors: [{ message: 'Not authenticated' }] }),
      { status: 200 },
    ),
  );
  try {
    await assert.rejects(
      () => railwayGraphQL('token', '{ foo }', {}),
      (err: any) => {
        assert.ok(err instanceof RailwayApiError);
        assert.equal(err.code, 'graphql_error');
        assert.match(err.message, /Not authenticated/);
        return true;
      },
    );
  } finally {
    m.restore();
  }
});

test('createRailwayProject returns id + first environment', async () => {
  const m = mockFetch(() =>
    new Response(
      JSON.stringify({
        data: {
          projectCreate: {
            id: 'proj-123',
            name: 'test',
            environments: {
              edges: [{ node: { id: 'env-1', name: 'production' } }],
            },
          },
        },
      }),
      { status: 200 },
    ),
  );
  try {
    const result = await createRailwayProject('token', { name: 'test', workspaceId: 'ws-1' });
    assert.equal(result.id, 'proj-123');
    assert.deepEqual(result.environments, [{ id: 'env-1', name: 'production' }]);
    assert.equal(m.calls.length, 1);
    assert.equal(m.calls[0]!.headers['Authorization' as any], 'Bearer token');
    assert.match(m.calls[0]!.body.query, /projectCreate/);
    assert.equal(m.calls[0]!.body.variables.input.name, 'test');
    assert.equal(m.calls[0]!.body.variables.input.teamId, 'ws-1');
  } finally {
    m.restore();
  }
});

test('createRailwayService posts serviceCreate mutation with image source', async () => {
  const m = mockFetch(() =>
    new Response(
      JSON.stringify({ data: { serviceCreate: { id: 'svc-1', name: 'alex-pm' } } }),
      { status: 200 },
    ),
  );
  try {
    const result = await createRailwayService('token', {
      projectId: 'proj-1',
      environmentId: 'env-1',
      name: 'alex-pm',
      imageSource: 'ghcr.io/openclaw/openclaw:latest',
      variables: { ANTHROPIC_API_KEY: 'sk-test', DEFT_MCP_TOKEN: 'mcp-tok' },
    });
    assert.equal(result.id, 'svc-1');
    assert.match(m.calls[0]!.body.query, /serviceCreate/);
    assert.equal(m.calls[0]!.body.variables.input.source.image, 'ghcr.io/openclaw/openclaw:latest');
    assert.equal(m.calls[0]!.body.variables.input.variables.ANTHROPIC_API_KEY, 'sk-test');
    assert.equal(m.calls[0]!.body.variables.input.name, 'alex-pm');
  } finally {
    m.restore();
  }
});

test('deployRailwayService returns deploy id + status on success', async () => {
  const m = mockFetch(() =>
    new Response(
      JSON.stringify({
        data: { serviceInstanceDeployV2: { id: 'dep-1', status: 'BUILDING' } },
      }),
      { status: 200 },
    ),
  );
  try {
    const result = await deployRailwayService('token', 'svc-1', 'env-1');
    assert.equal(result.id, 'dep-1');
    assert.equal(result.status, 'BUILDING');
  } finally {
    m.restore();
  }
});

test('deployRailwayService swallows graphql_error (serviceCreate may auto-deploy)', async () => {
  const m = mockFetch(() =>
    new Response(
      JSON.stringify({ errors: [{ message: 'already deployed' }] }),
      { status: 200 },
    ),
  );
  try {
    const result = await deployRailwayService('token', 'svc-1', 'env-1');
    assert.equal(result.status, 'BUILDING');
  } finally {
    m.restore();
  }
});

test('getRailwayServiceStatus maps latestDeployment.status -> InstanceStatus', async () => {
  const m = mockFetch(() =>
    new Response(
      JSON.stringify({
        data: {
          serviceInstance: {
            latestDeployment: { id: 'dep-1', status: 'SUCCESS', createdAt: '2026-04-13T00:00:00Z' },
          },
        },
      }),
      { status: 200 },
    ),
  );
  try {
    const result = await getRailwayServiceStatus('token', 'svc-1', 'env-1');
    assert.equal(result, 'running');
  } finally {
    m.restore();
  }
});

test('getRailwayServiceStatus returns unknown when serviceInstance is null', async () => {
  const m = mockFetch(() =>
    new Response(JSON.stringify({ data: { serviceInstance: null } }), { status: 200 }),
  );
  try {
    const result = await getRailwayServiceStatus('token', 'svc-1', 'env-1');
    assert.equal(result, 'unknown');
  } finally {
    m.restore();
  }
});

test('getRailwayServiceDomain returns https:// URL from serviceDomains edge', async () => {
  const m = mockFetch(() =>
    new Response(
      JSON.stringify({
        data: {
          serviceInstance: {
            domains: {
              serviceDomains: [{ domain: 'alex-pm-production.up.railway.app' }],
              customDomains: [],
            },
          },
        },
      }),
      { status: 200 },
    ),
  );
  try {
    const domain = await getRailwayServiceDomain('token', 'svc-1', 'env-1');
    assert.equal(domain, 'https://alex-pm-production.up.railway.app');
  } finally {
    m.restore();
  }
});

test('destroyRailwayService posts serviceDelete mutation', async () => {
  const m = mockFetch(() => new Response(JSON.stringify({ data: { serviceDelete: true } }), { status: 200 }));
  try {
    await destroyRailwayService('token', 'svc-1');
    assert.match(m.calls[0]!.body.query, /serviceDelete/);
    assert.equal(m.calls[0]!.body.variables.id, 'svc-1');
  } finally {
    m.restore();
  }
});
