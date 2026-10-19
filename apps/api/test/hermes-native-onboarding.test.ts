import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRuntimeSetup } from '../src/routes/agent-employees.js';
import { hermesBundleAvailability } from '../src/lib/hermes-release.js';

test('fresh Hermes setup uses the native platform and direct HTTP MCP only', () => {
  const previousApiBase = process.env.PUBLIC_API_BASE_URL;
  process.env.PUBLIC_API_BASE_URL = 'https://deft.example/';

  try {
    const setup = buildRuntimeSetup({
      name: 'Rita',
      slug: 'rita-hermes',
      runtime_kind: 'hermes',
    }, 'native-onboarding-nonce');

    assert.equal(setup.runtime_kind, 'hermes');
    assert.equal(setup.integration_version, '0.5.1');
    assert.equal(setup.mcp_endpoint_url, 'https://deft.example/api/mcp/hermes/v1');
    assert.equal(setup.channel_endpoint_url, 'https://deft.example/api/agent-channel/v1');
    assert.match(setup.setup_steps.join('\n'), /install.*deft-platform.*deft-employee.*deft-memory/i);
    assert.match(setup.setup_steps.join('\n'), /deft-platform must be the only Agent Channel delivery adapter/i);
    assert.match(setup.setup_steps.join('\n'), /replace the home_channel chat_id placeholders/i);
    assert.match(setup.setup_steps.join('\n'), /direct HTTP Deft MCP/i);
    assert.match(setup.setup_steps.join('\n'), /run the bundled deft-platform readiness\.py probe/i);
    assert.match(setup.setup_steps.join('\n'), /auto-load.*deft-employee:runtime/i);

    assert.ok(setup.config_snippet);
    assert.match(setup.config_snippet, /plugins:\n  enabled:\n    - deft-platform\n    - deft-employee\n    - deft-memory/);
    assert.match(setup.config_snippet, /platforms:\n  deft:\n    enabled: true/);
    assert.match(setup.config_snippet, /channel_url: https:\/\/deft\.example\/api\/agent-channel\/v1/);
    assert.match(setup.config_snippet, /employee_slug: rita-hermes/);
    assert.match(setup.config_snippet, /mcp_servers:[\s\S]*url: https:\/\/deft\.example\/api\/mcp\/hermes\/v1/);
    assert.match(setup.config_snippet, /Authorization: Bearer <employee-mcp-token>/);
    assert.match(setup.config_snippet, /memory:\n  provider: deft-memory/);
    assert.doesNotMatch(setup.config_snippet, /command: node|deft-mcp-stdio/);

    assert.ok(setup.commands.some((command) => command.command === 'hermes gateway run --force'));
    assert.ok(setup.commands.some((command) => command.command === 'python ./plugins/deft-platform/readiness.py'));
    assert.ok(setup.commands.every((command) => !command.command.includes('hermes-agent-channel-bridge')));
    assert.ok(setup.commands.every((command) => !command.command.startsWith('node ')));
  } finally {
    if (previousApiBase === undefined) delete process.env.PUBLIC_API_BASE_URL;
    else process.env.PUBLIC_API_BASE_URL = previousApiBase;
  }
});

test('legacy Node assets are marked rollback-only and mutually exclusive', () => {
  const setup = buildRuntimeSetup({
    name: 'Rita',
    slug: 'rita-hermes',
    runtime_kind: 'hermes',
  }, null);
  const operatorGuidance = [...setup.setup_steps, ...setup.troubleshooting].join('\n');

  assert.match(operatorGuidance, /rollback[- ]only/i);
  assert.match(operatorGuidance, /never run native and legacy adapters together/i);
  assert.match(operatorGuidance, /disable deft-platform before using them/i);
  assert.match(setup.bridge_script ?? '', /LEGACY ROLLBACK ONLY/);
  assert.match(setup.bridge_script ?? '', /never run the native and legacy Deft adapters.*at the same time/);
});

test('core release setup reports the missing certification and omits a download command', () => {
  const previous = process.env.DEFT_HERMES_BUNDLE_URL;
  delete process.env.DEFT_HERMES_BUNDLE_URL;
  try {
    const setup = buildRuntimeSetup(
      { name: 'Rita', slug: 'rita-hermes', runtime_kind: 'hermes' }, null,
      hermesBundleAvailability('0.3.0-preview.122', 'core', ''),
    );
    assert.equal(setup.integration_bundle_url, null);
    assert.equal(setup.integration_bundle_status, 'unavailable');
    assert.match(setup.integration_bundle_detail ?? '', /onboarding is blocked/);
    assert.match(setup.setup_steps[0], /does not include a certified Hermes integration/);
    assert.ok(setup.commands.every(({ command }) => !command.startsWith('curl ')));
  } finally {
    if (previous === undefined) delete process.env.DEFT_HERMES_BUNDLE_URL;
    else process.env.DEFT_HERMES_BUNDLE_URL = previous;
  }
});

test('operator bundle setup preserves the URL without claiming certification', () => {
  const previous = process.env.DEFT_HERMES_BUNDLE_URL;
  process.env.DEFT_HERMES_BUNDLE_URL = 'https://operator.example/hermes.tar.gz';
  try {
    const setup = buildRuntimeSetup({ name: 'Rita', slug: 'rita-hermes', runtime_kind: 'hermes' }, null);
    assert.equal(setup.integration_bundle_status, 'operator_provided');
    assert.equal(setup.integration_bundle_url, process.env.DEFT_HERMES_BUNDLE_URL);
    assert.match(setup.setup_steps[0], /does not establish certification/);
    assert.match(setup.commands[0].description, /does not establish certification/);
  } finally {
    if (previous === undefined) delete process.env.DEFT_HERMES_BUNDLE_URL;
    else process.env.DEFT_HERMES_BUNDLE_URL = previous;
  }
});
