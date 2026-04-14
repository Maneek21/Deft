/**
 * Phase 8 — BYOProvider unit tests.
 *
 * BYOProvider is a pure passthrough: provision() returns the connection_url
 * the user pasted, getStatus() pings /health, destroy() no-ops.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BYOProvider } from '../src/lib/deployment/byo-provider.js';
import type {
  DeployContext,
  ProviderInstanceRecord,
} from '../src/lib/deployment/types.js';

function makeCtx(overrides?: Partial<DeployContext>): DeployContext {
  return {
    employee: {
      id: 'emp-byo-001',
      org_id: 'org-test',
      slug: 'byo-test',
      name: 'BYO Test Employee',
      template_slug: 'alex-pm',
      template_version: '1.0.0',
    },
    org: { id: 'org-test', name: 'Test Org', timezone: 'UTC' },
    soulMd: 'SOUL',
    agentsMd: 'AGENTS',
    userMd: 'USER',
    toolsMd: 'TOOLS',
    gatewayToken: 'raw-gw-token',
    deftMcpToken: 'raw-mcp-token',
    anthropicApiKey: 'sk-test',
    capabilityPackSlugs: ['deft-workspace'],
    capabilityPackSecrets: {},
    deftApiUrl: 'http://localhost:3001',
    byoConnectionUrl: 'http://host.docker.internal:18789',
    ...overrides,
  };
}

test('BYOProvider: is available, not managed, not coming soon', () => {
  const p = new BYOProvider();
  assert.equal(p.id, 'byo');
  assert.equal(p.isAvailable, true);
  assert.equal(p.isManaged, false);
  assert.equal(p.comingSoon, false);
});

test('BYOProvider.provision returns the byoConnectionUrl verbatim', async () => {
  const p = new BYOProvider();
  const result = await p.provision(makeCtx());
  assert.equal(result.connection_url, 'http://host.docker.internal:18789');
  assert.ok(result.external_instance_id.startsWith('byo-'));
  assert.equal(result.estimated_cost_usd_cents_monthly, null);
  assert.equal(result.provider_metadata.byo, true);
});

test('BYOProvider.provision throws when byoConnectionUrl missing', async () => {
  const p = new BYOProvider();
  const ctx = makeCtx({ byoConnectionUrl: undefined });
  await assert.rejects(() => p.provision(ctx), /byoConnectionUrl/);
});

test('BYOProvider.getStatus returns running on /health 200', async () => {
  const p = new BYOProvider();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: any) =>
    new Response(JSON.stringify({ status: 'ok' }), { status: 200 })) as any;
  try {
    const status = await p.getStatus({
      id: 'pi-test',
      org_id: 'org-test',
      provider: 'byo',
      integration_id: null,
      external_instance_id: 'byo-test',
      external_project_id: null,
      external_environment_id: null,
      provider_metadata: { connection_url: 'http://localhost:18789' },
    } as ProviderInstanceRecord);
    assert.equal(status, 'running');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('BYOProvider.getStatus returns crashed on /health non-2xx', async () => {
  const p = new BYOProvider();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('boom', { status: 500 })) as any;
  try {
    const status = await p.getStatus({
      id: 'pi-test',
      org_id: 'org-test',
      provider: 'byo',
      integration_id: null,
      external_instance_id: 'byo-test',
      external_project_id: null,
      external_environment_id: null,
      provider_metadata: { connection_url: 'http://localhost:18789' },
    } as ProviderInstanceRecord);
    assert.equal(status, 'crashed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('BYOProvider.getStatus returns crashed on network error', async () => {
  const p = new BYOProvider();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as any;
  try {
    const status = await p.getStatus({
      id: 'pi-test',
      org_id: 'org-test',
      provider: 'byo',
      integration_id: null,
      external_instance_id: 'byo-test',
      external_project_id: null,
      external_environment_id: null,
      provider_metadata: { connection_url: 'http://localhost:18789' },
    } as ProviderInstanceRecord);
    assert.equal(status, 'crashed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('BYOProvider.destroy is a no-op', async () => {
  const p = new BYOProvider();
  // Should not throw.
  await p.destroy({
    id: 'pi-test',
    org_id: 'org-test',
    provider: 'byo',
    integration_id: null,
    external_instance_id: 'byo-test',
    external_project_id: null,
    external_environment_id: null,
    provider_metadata: {},
  } as ProviderInstanceRecord);
});

test('BYOProvider.estimateCostUsdCents returns null (unknown)', () => {
  assert.equal(new BYOProvider().estimateCostUsdCents(), null);
});
