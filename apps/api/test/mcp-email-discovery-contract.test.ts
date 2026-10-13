import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverPersonalEmailToolSchemas, HUMAN_INDEPENDENT_TOOL_AUTHORITIES,
  isIndependentlyGovernedEmailTool } from '../src/lib/mcp-tools/email-discovery-contract.js';

const principal = { principal_kind: 'human', org_id: 'fixture-org', user_id: 'fixture-owner', token_id: 'fixture-token' };
const read = { name: 'email_read', description: 'Read granted mail', inputSchema: {} };

test('Email classification is independent of broad workspace OAuth scopes', () => {
  assert.equal(Object.keys(HUMAN_INDEPENDENT_TOOL_AUTHORITIES).length, 11);
  assert.ok(Object.values(HUMAN_INDEPENDENT_TOOL_AUTHORITIES).every(value => value === 'personal_mcp_app_grant'));
  assert.equal(isIndependentlyGovernedEmailTool('email_read'), true);
  assert.equal(isIndependentlyGovernedEmailTool('email_unreviewed_new_tool'), false);
  assert.equal(isIndependentlyGovernedEmailTool('workspace_capabilities'), false);
});

test('OAuth, missing-token and nonhuman discovery deny before grant loading', async () => {
  let calls = 0;
  const discover = async () => { calls++; return [read]; };
  for (const denied of [{ ...principal, principal_kind: 'oauth' },
    { ...principal, principal_kind: 'agent' }, { ...principal, token_id: undefined },
    { ...principal, principal_kind: undefined }]) {
    assert.deepEqual(await discoverPersonalEmailToolSchemas(denied, discover), []);
  }
  assert.equal(calls, 0);
});

test('discovery binds exact authenticated identity and rechecks changed grants on each call', async () => {
  let granted = true;
  const calls: unknown[] = [];
  const discover = async (caller: { kind: string; org_id: string; user_id: string; token_id: string }) => {
    calls.push(caller);
    return granted && caller.org_id === principal.org_id && caller.user_id === principal.user_id
      && caller.token_id === principal.token_id ? [read] : [];
  };
  assert.deepEqual(await discoverPersonalEmailToolSchemas(principal, discover), [read]);
  granted = false; // Same current discovery boundary reports revoked/ungranted access.
  assert.deepEqual(await discoverPersonalEmailToolSchemas(principal, discover), []);
  granted = true;
  for (const foreign of [{ ...principal, token_id: 'foreign-token' },
    { ...principal, user_id: 'foreign-owner' }, { ...principal, org_id: 'foreign-org' }]) {
    assert.deepEqual(await discoverPersonalEmailToolSchemas(foreign, discover), []);
  }
  assert.deepEqual(calls[0], { kind: 'personal_mcp', org_id: principal.org_id,
    user_id: principal.user_id, token_id: principal.token_id });
  assert.equal(calls.length, 5);
});

test('discovery failure never manufactures broad-scope Email availability', async () => {
  await assert.rejects(discoverPersonalEmailToolSchemas(principal, async () => {
    throw new Error('fixture grant discovery unavailable');
  }), /fixture grant discovery unavailable/);
});
