import test from 'node:test';
import assert from 'node:assert/strict';
import { agentConnectionStatus, agentEmployeeLifecycle } from './agent-employee-status';

const NOW = Date.parse('2026-07-12T12:00:00Z');
const base = {
  is_active: true,
  unhealthy: false,
  required_workspace_skill_installed: true,
};

test('verified without runtime contact is not working', () => {
  assert.deepEqual(
    agentEmployeeLifecycle({ ...base, certification_status: 'verified' }, NOW),
    { label: 'Ready to connect', detail: 'certified, but no runtime contact yet', tone: 'purple' },
  );
});

test('working requires recent work, not merely configuration', () => {
  const status = agentEmployeeLifecycle({
    ...base,
    certification_status: 'verified',
    last_mcp_call_at: '2026-07-12T11:59:00Z',
    last_turn_at: '2026-07-12T11:50:00Z',
  }, NOW);
  assert.equal(status.label, 'Working');
});

test('connected runtime without recent work is online', () => {
  const status = agentEmployeeLifecycle({
    ...base,
    certification_status: 'verified',
    channel_last_seen_at: '2026-07-12T11:58:00Z',
  }, NOW);
  assert.equal(status.label, 'Online');
});

test('transport contact cannot make an uncertified employee look ready', () => {
  const status = agentEmployeeLifecycle({
    ...base,
    certification_status: 'challenge_issued',
    channel_status: 'connected',
    channel_last_seen_at: '2026-07-12T11:59:00Z',
    last_mcp_call_at: '2026-07-12T11:59:00Z',
  }, NOW);
  assert.equal(status.label, 'Certifying');
  assert.match(status.detail, /end-to-end/i);
});

test('missing required workspace skill blocks readiness', () => {
  const status = agentEmployeeLifecycle({
    ...base,
    required_workspace_skill_installed: false,
    certification_status: 'verified',
    last_mcp_call_at: '2026-07-12T11:59:00Z',
  }, NOW);
  assert.equal(status.label, 'Setup incomplete');
});

test('latest channel contact drives connection status', () => {
  const status = agentConnectionStatus({
    ...base,
    last_mcp_call_at: '2026-07-10T12:00:00Z',
    channel_last_seen_at: '2026-07-12T11:59:00Z',
  }, NOW);
  assert.equal(status.label, 'Connected');
});

test('partial sidebar records are not mistaken for paused employees', () => {
  const status = agentEmployeeLifecycle({
    certification_status: 'verified',
    required_workspace_skill_installed: true,
  }, NOW);
  assert.equal(status.label, 'Ready to connect');
});

test('explicit disconnect overrides a recent contact timestamp', () => {
  const employee = {
    ...base,
    certification_status: 'verified',
    channel_status: 'disconnected',
    channel_last_seen_at: '2026-07-12T11:59:00Z',
  };

  assert.equal(agentEmployeeLifecycle(employee, NOW).label, 'Offline');
  assert.equal(agentConnectionStatus(employee, NOW).label, 'Disconnected - last seen 1m ago');
});
