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
    daily_action_count: 5,
  },
  connection: {
    status: 'connected',
    adapter_mode: 'supervised_runtime',
    runtime_capabilities: [],
    attestation: {
      ready: true,
      responses_api: true,
      skills_api: true,
      configured_model: 'rita',
      available_models: ['rita'],
      enabled_toolsets: ['web'],
    },
  },
  nativeRequiredCapabilities: [
    'autonomous_platform_adapter_v1',
    'accepted_event_rehydration_v1',
  ],
  requirements: {
    modules: [{ module_id: 'contacts', access: 'write' as const }],
    hermes_toolsets: ['web'],
    min_action_headroom: 10,
    require_skills_api: true,
  },
  modules: [{ module_id: 'contacts', access: 'write' as const, enabled: true }],
  now: new Date('2026-08-24T12:00:00.000Z'),
};

test('preflight passes Deft surfaces and remote Hermes toolsets without importing a tool catalog', () => {
  const result = evaluateAgentOnboardingPreflight(base);
  assert.equal(result.ready, true);
  assert.ok(result.checks.some((check) => check.key === 'module:contacts:write' && check.status === 'pass'));
  assert.ok(result.checks.some((check) => check.key === 'hermes_toolset:web' && check.status === 'pass'));
  assert.ok(result.checks.some((check) => check.key === 'action_headroom' && check.status === 'pass'));
  assert.ok(result.checks.some((check) => check.key === 'hermes_model' && check.status === 'pass'));
});

test('native autonomous preflight passes without legacy runtime attestation', () => {
  const result = evaluateAgentOnboardingPreflight({
    ...base,
    connection: {
      status: 'connected',
      adapter_mode: 'autonomous_platform',
      runtime_capabilities: [...base.nativeRequiredCapabilities],
      attestation: null,
    },
    requirements: { ...base.requirements, hermes_toolsets: [] },
  });

  assert.equal(result.ready, true);
  assert.equal(result.checks.find((check) => check.key === 'channel_compatibility')?.status, 'pass');
  assert.deepEqual(
    result.checks
      .filter((check) => ['hermes_runtime', 'hermes_skills', 'hermes_model'].includes(check.key))
      .map((check) => [check.key, check.status]),
    [
      ['hermes_runtime', 'warning'],
      ['hermes_skills', 'warning'],
      ['hermes_model', 'warning'],
    ],
  );
  assert.match(
    result.checks.find((check) => check.key === 'hermes_runtime')?.detail ?? '',
    /certification challenge must prove the model loop/i,
  );
});

test('native autonomous preflight rejects a missing required channel capability', () => {
  const result = evaluateAgentOnboardingPreflight({
    ...base,
    connection: {
      status: 'connected',
      adapter_mode: 'autonomous_platform',
      runtime_capabilities: ['autonomous_platform_adapter_v1'],
      attestation: null,
    },
  });

  assert.equal(result.ready, false);
  assert.deepEqual(result.checks.find((check) => check.key === 'channel_compatibility'), {
    key: 'channel_compatibility',
    status: 'fail',
    detail: 'The native adapter is missing required Agent Channel capabilities: accepted_event_rehydration_v1.',
    repair: 'Install the Hermes integration bundle matched to this Deft release.',
  });
});

test('native autonomous preflight does not waive an explicitly required model', () => {
  const result = evaluateAgentOnboardingPreflight({
    ...base,
    connection: {
      status: 'connected',
      adapter_mode: 'autonomous_platform',
      runtime_capabilities: [...base.nativeRequiredCapabilities],
      attestation: null,
    },
    requirements: { ...base.requirements, required_model: 'pinned-model' },
  });

  assert.equal(result.ready, false);
  assert.deepEqual(result.checks.find((check) => check.key === 'hermes_model'), {
    key: 'hermes_model',
    status: 'fail',
    detail: 'Native delivery did not verify required model pinned-model.',
    repair: 'Attest pinned-model as the configured available model before certification.',
  });
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
    'hermes_skills',
    'hermes_model',
    'module:contacts:write',
    'hermes_toolset:web',
  ]);
  assert.ok(result.checks.filter((check) => check.status === 'fail').every((check) => check.repair));
});

test('preflight blocks certification before the action budget is exhausted', () => {
  const result = evaluateAgentOnboardingPreflight({
    ...base,
    employee: { ...base.employee, daily_action_count: 45 },
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.checks.find((check) => check.key === 'action_headroom'), {
    key: 'action_headroom',
    status: 'fail',
    detail: '5 of 50 daily actions remain; onboarding requires at least 10.',
    repair: 'Reset the employee action counter or raise its daily action limit.',
  });
});

test('installed modules without an agent grant are visible without blocking unrelated onboarding', () => {
  const result = evaluateAgentOnboardingPreflight({
    ...base,
    requirements: { ...base.requirements, modules: [] },
    modules: [{ module_id: 'contacts', access: 'none' as const, enabled: true }],
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.checks.find((check) => check.key === 'module_grant:contacts'), {
    key: 'module_grant:contacts',
    status: 'warning',
    detail: 'contacts is installed but this organization has not granted agent access.',
    repair: 'Choose read or write agent access for contacts in Module settings.',
  });
});
