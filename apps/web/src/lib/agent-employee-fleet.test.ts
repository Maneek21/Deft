import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentEmployeeFleetBucket,
  countAgentEmployeeFleet,
  filterAndSortAgentEmployeeFleet,
  type AgentEmployeeFleetRecord,
} from './agent-employee-fleet';

const NOW = Date.parse('2026-07-12T12:00:00Z');
const base = {
  role: 'general',
  runtime_kind: 'openclaw',
  wake_mode: 'channel',
  is_active: true,
  unhealthy: false,
  required_workspace_skill_installed: true,
  certification_status: 'verified',
};

function employee(name: string, overrides: Partial<AgentEmployeeFleetRecord> = {}): AgentEmployeeFleetRecord {
  return { ...base, name, ...overrides };
}

test('groups operational states into mutually exclusive fleet buckets', () => {
  assert.equal(agentEmployeeFleetBucket(employee('Working', {
    last_mcp_call_at: '2026-07-12T11:59:00Z',
    last_turn_at: '2026-07-12T11:58:00Z',
  }), NOW), 'active');
  assert.equal(agentEmployeeFleetBucket(employee('Approval', {
    last_mcp_call_at: '2026-07-12T11:58:00Z',
    pending_action_count: 2,
  }), NOW), 'attention');
  assert.equal(agentEmployeeFleetBucket(employee('Broken', {
    unhealthy: true,
    unhealthy_reason: 'circuit breaker open',
  }), NOW), 'attention');
  assert.equal(agentEmployeeFleetBucket(employee('Offline', { last_mcp_call_at: '2026-07-11T11:00:00Z' }), NOW), 'offline');
  assert.equal(agentEmployeeFleetBucket(employee('Setup', { required_workspace_skill_installed: false }), NOW), 'setup');
  assert.equal(agentEmployeeFleetBucket(employee('Paused', { is_active: false }), NOW), 'paused');
});

test('counts every employee exactly once', () => {
  const employees = [
    employee('Working', {
      last_mcp_call_at: '2026-07-12T11:59:00Z',
      last_turn_at: '2026-07-12T11:58:00Z',
    }),
    employee('Approval', { last_mcp_call_at: '2026-07-12T11:58:00Z', pending_action_count: 1 }),
    employee('Setup', { certification_status: 'token_issued' }),
    employee('Paused', { is_active: false }),
  ];

  assert.deepEqual(countAgentEmployeeFleet(employees, NOW), {
    attention: 1,
    active: 1,
    offline: 0,
    setup: 1,
    paused: 1,
  });
});

test('orders the fleet by intervention priority before name', () => {
  const employees = [
    employee('Zulu active', {
      last_mcp_call_at: '2026-07-12T11:59:00Z',
      last_turn_at: '2026-07-12T11:58:00Z',
    }),
    employee('Bravo approval', { last_mcp_call_at: '2026-07-12T11:58:00Z', pending_action_count: 1 }),
    employee('Alpha unhealthy', { unhealthy: true, unhealthy_reason: 'runtime failed' }),
    employee('Charlie setup', { required_workspace_skill_installed: false }),
  ];

  assert.deepEqual(
    filterAndSortAgentEmployeeFleet(employees, 'all', '', NOW).map((item) => item.name),
    ['Alpha unhealthy', 'Bravo approval', 'Charlie setup', 'Zulu active'],
  );
});

test('filters by bucket and searches lifecycle, runtime, role, and health text', () => {
  const employees = [
    employee('Quartz', {
      last_mcp_call_at: '2026-07-12T11:59:00Z',
      last_turn_at: '2026-07-12T11:58:00Z',
      role: 'researcher',
    }),
    employee('Amber', { unhealthy: true, unhealthy_reason: 'Gateway token expired' }),
    employee('Violet', { required_workspace_skill_installed: false, runtime_kind: 'hermes' }),
  ];

  assert.deepEqual(filterAndSortAgentEmployeeFleet(employees, 'active', 'researcher', NOW).map((item) => item.name), ['Quartz']);
  assert.deepEqual(filterAndSortAgentEmployeeFleet(employees, 'attention', 'token expired', NOW).map((item) => item.name), ['Amber']);
  assert.deepEqual(filterAndSortAgentEmployeeFleet(employees, 'setup', 'hermes', NOW).map((item) => item.name), ['Violet']);
  assert.deepEqual(filterAndSortAgentEmployeeFleet(employees, 'all', 'needs attention', NOW).map((item) => item.name), ['Amber']);
});
