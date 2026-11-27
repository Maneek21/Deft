/**
 * Trust × tier approval matrix unit tests.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/agent-approval-matrix.test.ts
 *
 * Covers:
 *   1. 3×3 trust × tier matrix (9 cases)
 *   2. Destructive guard under Autonomous (6 cases)
 *   3. Destructive guard under Conservative (destructive auto-tier queues)
 *   4. Destructive guard under Standard (destructive auto/quick-tier queues)
 *   5. isDestructiveAction standalone
 *   6. Lane S2: destructive never auto-executes at any level, native + MCP
 *   7. Lane W2-a1: case-insensitive names, destructiveHint, action=delete, remove_dependency
 *
 * Pure unit tests — no DB required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoExecute, isDestructiveAction, getApprovalTier, TOOL_APPROVAL_TIERS } from '../src/lib/agent-approval.js';
import { ACTION_TOOLS, SUPERINTENDENT_TOOLS, SUPERINTENDENT_ACTION_TOOLS } from '../src/lib/agent-tools.js';
import { chatEditLanding, lowerTrustLevel } from '../src/lib/agent-document-write-tools.js';
import type { EditLandingInput } from '../src/lib/document-edit-landing.js';

test('Defty does not offer agent management without an executor', () => {
  assert.equal(SUPERINTENDENT_TOOLS.some((tool) => tool.name === 'manage_agent_employee'), false);
  assert.equal(SUPERINTENDENT_ACTION_TOOLS.has('manage_agent_employee'), false);
});

// ─── 1. Trust × tier matrix ──────────────────────────────────────────────────
// We use real tool names from TOOL_APPROVAL_TIERS:
//   auto  tier → update_task_status
//   quick tier → create_task
//   full  tier → post_message

test('Conservative × auto → true (auto-tier is always safe)', () => {
  assert.equal(shouldAutoExecute('update_task_status', 'conservative'), true);
});

test('Conservative × quick → false (quick-tier queues under conservative)', () => {
  assert.equal(shouldAutoExecute('create_task', 'conservative'), false);
});

test('Conservative × full → false (full-tier queues under conservative)', () => {
  assert.equal(shouldAutoExecute('post_message', 'conservative'), false);
});

test('Standard × auto → true', () => {
  assert.equal(shouldAutoExecute('update_task_status', 'standard'), true);
});

test('Standard × quick → true', () => {
  assert.equal(shouldAutoExecute('create_task', 'standard'), true);
});

test('Standard × full → false', () => {
  assert.equal(shouldAutoExecute('post_message', 'standard'), false);
});

test('Autonomous × auto → true', () => {
  assert.equal(shouldAutoExecute('update_task_status', 'autonomous'), true);
});

test('Autonomous × quick → true', () => {
  assert.equal(shouldAutoExecute('create_task', 'autonomous'), true);
});

test('Autonomous × full → true (new behavior — full-tier executes under autonomous)', () => {
  assert.equal(shouldAutoExecute('post_message', 'autonomous'), true);
});

// ─── 2. Destructive guard under Autonomous ───────────────────────────────────

test('Autonomous: manage_agent_employee → false (admin tool, always queues)', () => {
  assert.equal(shouldAutoExecute('manage_agent_employee', 'autonomous'), false);
});

test('Autonomous: manage_mcp_connection → false (admin tool, always queues)', () => {
  assert.equal(shouldAutoExecute('manage_mcp_connection', 'autonomous'), false);
});

test('Autonomous: remove_member → false (admin tool, always queues)', () => {
  assert.equal(shouldAutoExecute('remove_member', 'autonomous'), false);
});

test('Autonomous: module_record_bulk_create → false (high-volume batch always queues)', () => {
  assert.equal(shouldAutoExecute('module_record_bulk_create', 'autonomous'), false);
  assert.equal(isDestructiveAction('module_record_bulk_create'), true);
});

test('Autonomous: delete_task → false (delete_ prefix match)', () => {
  // delete_task is not in TOOL_APPROVAL_TIERS so it defaults to full tier,
  // and the delete_ prefix guard fires first.
  assert.equal(shouldAutoExecute('delete_task', 'autonomous'), false);
});

test('Autonomous: post_message with params { mode: "delete" } → false (mode match)', () => {
  assert.equal(shouldAutoExecute('post_message', 'autonomous', { mode: 'delete' }), false);
});

test('Autonomous: post_message with params { mode: "send" } → true (not destructive)', () => {
  assert.equal(shouldAutoExecute('post_message', 'autonomous', { mode: 'send' }), true);
});

test('Autonomous: post_message with params { mode: "pause" } → false (mode match)', () => {
  assert.equal(shouldAutoExecute('post_message', 'autonomous', { mode: 'pause' }), false);
});

test('Autonomous: post_message with params { mode: "revoke" } → false (mode match)', () => {
  assert.equal(shouldAutoExecute('post_message', 'autonomous', { mode: 'revoke' }), false);
});

// ─── 3. Destructive guard under Conservative ─────────────────────────────────
// Quick and full already queue; an auto-tier call classed destructive queues too.

test('Conservative: manage_agent_employee → false (full-tier queues regardless)', () => {
  assert.equal(shouldAutoExecute('manage_agent_employee', 'conservative'), false);
});

test('Conservative: delete_task → false (full-tier queues regardless)', () => {
  assert.equal(shouldAutoExecute('delete_task', 'conservative'), false);
});

test('Conservative: update_task_status with mode=delete → false (destructive guard applies at every level)', () => {
  // Lane S2 (2026-11-11): previously true — Conservative auto-executed any
  // auto-tier call, destructive or not. A destructive call now always queues.
  assert.equal(shouldAutoExecute('update_task_status', 'conservative', { mode: 'delete' }), false);
  // Non-destructive auto-tier calls are not over-restricted.
  assert.equal(shouldAutoExecute('update_task_status', 'conservative', { mode: 'send' }), true);
});

// ─── 4. Destructive guard under Standard ─────────────────────────────────────
// Full already queues; an auto/quick-tier call classed destructive queues too.

test('Standard: manage_agent_employee → false (full-tier queues regardless)', () => {
  assert.equal(shouldAutoExecute('manage_agent_employee', 'standard'), false);
});

test('Standard: delete_task → false (full-tier queues regardless)', () => {
  assert.equal(shouldAutoExecute('delete_task', 'standard'), false);
});

test('Standard: create_task with mode=delete → false (destructive guard applies at every level)', () => {
  // Lane S2 (2026-11-11): previously true — Standard auto-executed any
  // quick-tier call, destructive or not. A destructive call now always queues.
  assert.equal(shouldAutoExecute('create_task', 'standard', { mode: 'delete' }), false);
  // Non-destructive quick-tier calls are not over-restricted.
  assert.equal(shouldAutoExecute('create_task', 'standard', { mode: 'send' }), true);
});

// ─── 5. isDestructiveAction standalone tests ─────────────────────────────────

test('isDestructiveAction: manage_agent_employee → true', () => {
  assert.equal(isDestructiveAction('manage_agent_employee'), true);
});

test('isDestructiveAction: manage_mcp_connection → true', () => {
  assert.equal(isDestructiveAction('manage_mcp_connection'), true);
});

test('isDestructiveAction: remove_member → true', () => {
  assert.equal(isDestructiveAction('remove_member'), true);
});

test('isDestructiveAction: delete_project → true (prefix match)', () => {
  assert.equal(isDestructiveAction('delete_project'), true);
});

test('isDestructiveAction: prefixed MCP delete tool → true', () => {
  assert.equal(isDestructiveAction('mcp__crm__delete_contact'), true);
  assert.equal(shouldAutoExecute('mcp__crm__delete_contact', 'autonomous'), false);
});

test('dynamic MCP quick tier is preserved for Standard execution and receipts', () => {
  assert.equal(getApprovalTier('mcp__crm__create_contact', 'quick'), 'quick');
  assert.equal(shouldAutoExecute('mcp__crm__create_contact', 'standard', {}, 'quick'), true);
  assert.equal(shouldAutoExecute('mcp__crm__create_contact', 'conservative', {}, 'quick'), false);
});

test('isDestructiveAction: post_message → false (no guard triggers)', () => {
  assert.equal(isDestructiveAction('post_message'), false);
});

test('isDestructiveAction: post_message with mode=delete → true', () => {
  assert.equal(isDestructiveAction('post_message', { mode: 'delete' }), true);
});

test('isDestructiveAction: post_message with mode=send → false', () => {
  assert.equal(isDestructiveAction('post_message', { mode: 'send' }), false);
});

test('isDestructiveAction: no params → false for safe tool', () => {
  assert.equal(isDestructiveAction('create_task', undefined), false);
});

test('isDestructiveAction: params=null → false (not an object)', () => {
  assert.equal(isDestructiveAction('create_task', null), false);
});

test('isDestructiveAction: params=array → false (array is not a plain object)', () => {
  assert.equal(isDestructiveAction('create_task', []), false);
});

test('isDestructiveAction: mode=DELETE (uppercase) → true (case-insensitive)', () => {
  assert.equal(isDestructiveAction('post_message', { mode: 'DELETE' }), true);
});

test('isDestructiveAction: mode=Revoke (mixed case) → true (case-insensitive)', () => {
  assert.equal(isDestructiveAction('post_message', { mode: 'Revoke' }), true);
});

// ─── 6. Wave 2 lane S2 — destructive actions never auto-execute ──────────────
// One rule: an action classed as destructive is never auto-executed at any
// trust level, for native and connected (MCP) tools, whatever tier it carries.

const TRUST_LEVELS = ['conservative', 'standard', 'autonomous'] as const;

test('S2-a: quick-tier destructive native tool (module_record_task_unlink) waits at every trust level', () => {
  assert.equal(getApprovalTier('module_record_task_unlink'), 'quick');
  assert.equal(isDestructiveAction('module_record_task_unlink'), true);
  for (const trust of TRUST_LEVELS) {
    assert.equal(shouldAutoExecute('module_record_task_unlink', trust), false, trust);
    assert.equal(shouldAutoExecute('module_record_task_unlink', trust, { record_id: 'r', task_id: 't' }), false, trust);
  }
});

test('S2-a: auto-tier call made destructive by params waits at every trust level', () => {
  for (const trust of TRUST_LEVELS) {
    assert.equal(shouldAutoExecute('update_task_status', trust, { mode: 'delete' }), false, trust);
  }
});

test('S2-a: quick-tier call made destructive by params waits at every trust level', () => {
  for (const trust of TRUST_LEVELS) {
    assert.equal(shouldAutoExecute('create_task', trust, { mode: 'revoke' }), false, trust);
  }
});

test('S2-a: destructive tool name with an auto tier override waits at every trust level', () => {
  for (const trust of TRUST_LEVELS) {
    for (const tool of ['manage_agent_employee', 'manage_mcp_connection', 'remove_member', 'delete_task', 'module_record_archive', 'module_record_bulk_create', 'module_record_task_unlink']) {
      assert.equal(shouldAutoExecute(tool, trust, undefined, 'auto'), false, `${trust} ${tool}`);
    }
  }
});

test('S2-b: connected MCP delete_* tool with an auto connection tier waits at every trust level', () => {
  for (const trust of TRUST_LEVELS) {
    assert.equal(shouldAutoExecute('mcp__crm__delete_contact', trust, {}, 'auto'), false, trust);
    assert.equal(shouldAutoExecute('mcp__crm__delete_contact', trust, {}, 'quick'), false, trust);
  }
});

test('S2-b: connected MCP tool called with mode=delete|pause|revoke and an auto tier waits at every trust level', () => {
  for (const trust of TRUST_LEVELS) {
    for (const mode of ['delete', 'pause', 'revoke']) {
      assert.equal(shouldAutoExecute('mcp__crm__update_contact', trust, { mode }, 'auto'), false, `${trust} ${mode}`);
    }
    // Non-destructive connected calls keep their connection tier.
    assert.equal(shouldAutoExecute('mcp__crm__update_contact', trust, { mode: 'merge' }, 'auto'), true, trust);
  }
});

test('S2-c: connected tools named like admin tools are destructive with and without the MCP prefix', () => {
  for (const name of ['manage_agent_employee', 'manage_mcp_connection', 'remove_member']) {
    assert.equal(isDestructiveAction(name), true, name);
    assert.equal(isDestructiveAction(`mcp__x__${name}`), true, `mcp__x__${name}`);
    for (const trust of TRUST_LEVELS) {
      assert.equal(shouldAutoExecute(`mcp__x__${name}`, trust, {}, 'auto'), false, `${trust} ${name}`);
    }
  }
});

test('S2-c: delete_* and module operations are destructive with and without the MCP prefix', () => {
  for (const name of ['delete_contact', 'module_record_task_unlink', 'module_record_archive', 'module_record_bulk_create']) {
    assert.equal(isDestructiveAction(name), true, name);
    assert.equal(isDestructiveAction(`mcp__crm__${name}`), true, `mcp__crm__${name}`);
  }
  // Connection slugs containing "__" still resolve the tool name after the
  // connection segment, matching the existing split.
  assert.equal(isDestructiveAction('mcp__crm__remove_member'), true);
  // Non-destructive names stay non-destructive with and without the prefix.
  for (const name of ['create_task', 'module_record_task_link', 'module_record_update', 'list_agent_employees']) {
    assert.equal(isDestructiveAction(name), false, name);
    assert.equal(isDestructiveAction(`mcp__crm__${name}`), false, `mcp__crm__${name}`);
  }
});

test('S2: every quick/auto-tier native tool classed destructive by name waits under Conservative and Standard', () => {
  const lowTierDestructive = Object.keys(TOOL_APPROVAL_TIERS)
    .filter((tool) => TOOL_APPROVAL_TIERS[tool] !== 'full' && isDestructiveAction(tool));
  // Enumerated today: remove_dependency (quick, lane W2-a1) and
  // module_record_task_unlink (quick).
  assert.deepEqual(lowTierDestructive, ['remove_dependency', 'module_record_task_unlink']);
  for (const tool of lowTierDestructive) {
    for (const trust of TRUST_LEVELS) assert.equal(shouldAutoExecute(tool, trust), false, `${trust} ${tool}`);
  }
});

// ─── 7. Wave 2 lane W2-a1 — approval classification gaps ────────────────────

test('W2a1-a: destructive names match case-insensitively, with and without the MCP prefix', () => {
  for (const name of ['Delete_contact', 'DELETE_CONTACT', 'REMOVE_MEMBER', 'Manage_Agent_Employee', 'Module_Record_Archive']) {
    assert.equal(isDestructiveAction(name), true, name);
    assert.equal(isDestructiveAction(`mcp__crm__${name}`), true, `mcp__crm__${name}`);
    assert.equal(isDestructiveAction(`MCP__crm__${name}`), true, `MCP__crm__${name}`);
    for (const trust of TRUST_LEVELS) {
      assert.equal(shouldAutoExecute(`mcp__crm__${name}`, trust, {}, 'auto'), false, `${trust} ${name}`);
    }
  }
  assert.equal(isDestructiveAction('mcp__crm__Update_Contact'), false);
});

test('W2a1-b: a connected tool that declares destructiveHint is destructive at every trust level', () => {
  const hinted = { destructiveHint: true };
  assert.equal(isDestructiveAction('mcp__crm__purge_contacts', {}, hinted), true);
  for (const trust of TRUST_LEVELS) {
    for (const tier of ['auto', 'quick', 'full'] as const) {
      assert.equal(shouldAutoExecute('mcp__crm__purge_contacts', trust, {}, tier, hinted), false, `${trust} ${tier}`);
    }
  }
  // Absence of a hint, or a false hint, changes nothing.
  for (const annotations of [undefined, null, {}, { destructiveHint: false }, { destructiveHint: 'true' }]) {
    assert.equal(isDestructiveAction('mcp__crm__purge_contacts', {}, annotations as any), false, JSON.stringify(annotations));
    assert.equal(shouldAutoExecute('mcp__crm__purge_contacts', 'autonomous', {}, 'full', annotations as any), true, JSON.stringify(annotations));
  }
});

test('W2a1-c: action: delete|pause|revoke is recognised like mode', () => {
  for (const value of ['delete', 'pause', 'revoke', 'DELETE']) {
    assert.equal(isDestructiveAction('mcp__crm__manage_contact', { action: value }), true, value);
    for (const trust of TRUST_LEVELS) {
      assert.equal(shouldAutoExecute('mcp__crm__manage_contact', trust, { action: value }, 'auto'), false, `${trust} ${value}`);
    }
  }
  for (const value of ['create', 'update', 'list', 'enable', 'disable', 'resume']) {
    assert.equal(isDestructiveAction('mcp__crm__manage_contact', { action: value }), false, value);
  }
  // Shapes no tool in this codebase uses are not recognised.
  assert.equal(isDestructiveAction('post_message', { operation: 'delete' }), false);
  assert.equal(isDestructiveAction('post_message', { options: { mode: 'delete' } }), false);
});

test('W2a1-d: remove_dependency and manage_triggers with action=delete are destructive', () => {
  assert.equal(isDestructiveAction('remove_dependency'), true);
  assert.equal(isDestructiveAction('manage_triggers', { action: 'delete', trigger_id: 't' }), true);
  assert.equal(isDestructiveAction('manage_triggers', { action: 'create' }), false);
  for (const trust of TRUST_LEVELS) {
    assert.equal(shouldAutoExecute('remove_dependency', trust), false, trust);
    assert.equal(shouldAutoExecute('manage_triggers', trust, { action: 'delete' }), false, trust);
  }
  // add_dependency keeps its quick tier.
  assert.equal(shouldAutoExecute('add_dependency', 'standard'), true);
});

// ─── 8. M7 — the chat exception for edit_document ──────────────────────────
// Defty's chat writes wait for approval at every trust level, except an edit
// to an existing document, which goes straight in only when the workspace
// trust is Standard or Autonomous, the asker can edit, the landing is direct
// (their setting, or their own words), the drive takes edits, and the call is
// not destructive (lib/agent-document-write-tools.ts chatEditLanding).

const ROLES = [null, 'view', 'comment', 'edit', 'full'] as const;
const canEdit = (role: typeof ROLES[number]) => role === 'edit' || role === 'full';
const editInput = (overrides: Partial<EditLandingInput>): EditLandingInput => ({
  trustLevel: 'standard', askerId: 'asker', askerRole: 'edit',
  drive: { kind: 'open', ownerUserId: null, agentSuggestOnly: false },
  mode: 'suggest', requestOverride: null, askerMessageText: null, otherHumansOpen: false,
  ...overrides,
});
/** The asker's setting and request, each with whether it lands direct on its own. */
const LANDINGS: Array<{ name: string; input: Partial<EditLandingInput>; direct: boolean }> = [
  { name: 'setting direct', input: { mode: 'direct' }, direct: true },
  { name: 'suggest_when_open, nobody else in', input: { mode: 'suggest_when_open', otherHumansOpen: false }, direct: true },
  { name: 'the asker said "just do it"', input: { mode: 'suggest', askerMessageText: 'Tidy the intro, just do it' }, direct: true },
  { name: 'setting suggest', input: { mode: 'suggest' }, direct: false },
  { name: 'suggest_when_open, someone else in', input: { mode: 'suggest_when_open', otherHumansOpen: true }, direct: false },
  { name: 'the model asked to suggest', input: { mode: 'direct', requestOverride: 'suggest' }, direct: false },
  { name: 'the model asked direct without the phrase', input: { mode: 'direct', requestOverride: 'direct' }, direct: false },
  { name: 'a drive that takes suggestions only', input: { mode: 'direct', drive: { kind: 'open', ownerUserId: null, agentSuggestOnly: true } }, direct: false },
  { name: 'the asker\'s own My drive, setting direct', input: { mode: 'direct', drive: { kind: 'personal', ownerUserId: 'asker', agentSuggestOnly: false } }, direct: true },
];
/** The call's own arguments: destructive ones never land direct (controller ruling 2). */
const CALL_PARAMS: Array<{ params: Record<string, unknown>; destructive: boolean; requestOverride?: string }> = [
  { params: { document_id: 'd', summary: 's', ops: [] }, destructive: false },
  { params: { document_id: 'd', summary: 's', ops: [{ op: 'delete', block_id: 'b' }] }, destructive: false },
  { params: { document_id: 'd', summary: 's', action: 'delete' }, destructive: true },
  { params: { document_id: 'd', summary: 's', action: 'revoke' }, destructive: true },
  { params: { document_id: 'd', summary: 's', mode: 'delete' }, destructive: true, requestOverride: 'delete' },
  { params: { document_id: 'd', summary: 's', mode: 'pause' }, destructive: true, requestOverride: 'pause' },
];

test('matrix: edit_document in chat mode is direct only for standard/autonomous + can edit + direct landing; never for destructive params', () => {
  let directs = 0;
  for (const trust of TRUST_LEVELS) {
    for (const role of ROLES) {
      for (const landing of LANDINGS) {
        for (const call of CALL_PARAMS) {
          const input = editInput({
            ...landing.input, trustLevel: trust, askerRole: role,
            ...(call.requestOverride ? { requestOverride: call.requestOverride as EditLandingInput['requestOverride'] } : {}),
          });
          const got = chatEditLanding(input, call.params);
          const label = `${trust} / ${role} / ${landing.name} / ${JSON.stringify(call.params)}`;
          // A mode the model sends that isn't "suggest" lowers a landing that only the setting made direct (M5 rule 5).
          const lowered = call.requestOverride !== undefined && !landing.input.askerMessageText;
          const expected = trust !== 'conservative' && canEdit(role) && landing.direct && !call.destructive && !lowered;
          assert.equal(got.landing === 'direct', expected, label);
          if (got.landing === 'direct') directs += 1;
          if (!canEdit(role)) assert.deepEqual(got, { landing: 'refuse', reason: 'asker_cannot_edit' }, label);
          if (call.destructive && canEdit(role) && trust !== 'conservative' && landing.direct && !lowered) {
            assert.deepEqual(got, { landing: 'suggest', reason: 'destructive_call' }, label);
          }
        }
      }
    }
  }
  assert.ok(directs > 0, 'some edits do go straight in');
  // The phrase with a destructive mode: M5 alone would land it direct; the guard never does.
  assert.deepEqual(chatEditLanding(editInput({ mode: 'suggest', requestOverride: 'delete' as never, askerMessageText: 'just do it' }), { mode: 'delete' }),
    { landing: 'suggest', reason: 'destructive_call' });
});

test('M7: edit_document and create_document are quick-tier registered actions; neither is destructive by name', () => {
  for (const tool of ['edit_document', 'create_document']) {
    assert.equal(ACTION_TOOLS.has(tool), true, tool);
    assert.equal(getApprovalTier(tool), 'quick', tool);
    assert.equal(isDestructiveAction(tool), false, tool);
    // A call made destructive by its params waits at every trust level.
    for (const trust of TRUST_LEVELS) assert.equal(shouldAutoExecute(tool, trust, { action: 'delete' }), false, `${trust} ${tool}`);
  }
});

test('M7: the exception reads the lower of the workspace trust and an employee\'s own; anything else is Conservative', () => {
  assert.equal(lowerTrustLevel('standard'), 'standard');
  assert.equal(lowerTrustLevel('autonomous', 'standard'), 'standard');
  assert.equal(lowerTrustLevel('standard', 'autonomous'), 'standard');
  assert.equal(lowerTrustLevel('autonomous', 'conservative'), 'conservative');
  assert.equal(lowerTrustLevel('autonomous', 'autonomous'), 'autonomous');
  assert.equal(lowerTrustLevel(undefined), 'conservative');
  assert.equal(lowerTrustLevel('autonomous', 'root'), 'conservative');
});
