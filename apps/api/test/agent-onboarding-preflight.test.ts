import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateAgentOnboardingPreflight } from '../src/lib/agent-onboarding-preflight.js';

const base = {
  employee: {
    active: true,
    unhealthy: false,
    has_mcp_token: true,
    has_channel_token: true,
    trust_level: 'standard',
    max_daily_actions: 50,
  },
  connection: {
    status: 'connected',
    attestation: {
      ready: true,
      responses_api: true,
      skills_api: true,
      enabled_toolsets: ['web'],
    },
  },
  requirements: {
    modules: [{ module_id: 'contacts', access: 'write' as const }],
    hermes_toolsets: ['web'],
  },
  modules: [{ module_id: 'contacts', access: 'write' as const, enabled: true }],
  now: new Date('2026-08-24T12:00:00.000Z'),
};

test('preflight passes Deft surfaces and remote Hermes toolsets without importing a tool catalog', () => {
  const result = evaluateAgentOnboardingPreflight(base);
  assert.equal(result.ready, true);
  assert.ok(result.checks.some((check) => check.key === 'module:contacts:write' && check.status === 'pass'));
  assert.ok(result.checks.some((check) => check.key === 'hermes_toolset:web' && check.status === 'pass'));
});

test('preflight names every missing dependency before certification', () => {
  const result = evaluateAgentOnboardingPreflight({
    ...base,
    connection: { status: 'incompatible', attestation: null },
    modules: [{ module_id: 'contacts', access: 'read', enabled: true }],
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.checks.filter((check) => check.status === 'fail').map((check) => check.key), [
    'channel_compatibility',
    'hermes_runtime',
    'module:contacts:write',
    'hermes_toolset:web',
  ]);
});
