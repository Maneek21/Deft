/**
 * Trust × tier approval matrix unit tests.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/agent-approval-matrix.test.ts
 *
 * Covers:
 *   1. 3×3 trust × tier matrix (9 cases)
 *   2. Destructive guard under Autonomous (6 cases)
 *   3. Conservative ignores destructive guard (auto still executes, rest queue)
 *   4. Standard ignores destructive guard (full-tier already queues)
 *
 * Pure unit tests — no DB required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoExecute, isDestructiveAction, getApprovalTier } from '../src/lib/agent-approval.js';

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

// ─── 3. Conservative ignores destructive guard ───────────────────────────────
// Under conservative, auto-tier always executes. Destructive guard is irrelevant
// because quick and full already queue regardless.

test('Conservative: manage_agent_employee → false (full-tier queues regardless)', () => {
  assert.equal(shouldAutoExecute('manage_agent_employee', 'conservative'), false);
});

test('Conservative: delete_task → false (full-tier queues regardless)', () => {
  assert.equal(shouldAutoExecute('delete_task', 'conservative'), false);
});

test('Conservative: update_task_status with mode=delete → true (auto-tier, destructive guard irrelevant)', () => {
  // Conservative allows auto-tier regardless of params. The destructive guard
  // only fires under Autonomous. This verifies conservative is not over-restricted.
  assert.equal(shouldAutoExecute('update_task_status', 'conservative', { mode: 'delete' }), true);
});

// ─── 4. Standard ignores destructive guard ───────────────────────────────────
// Under standard, full-tier always queues. Destructive guard is irrelevant.

test('Standard: manage_agent_employee → false (full-tier queues regardless)', () => {
  assert.equal(shouldAutoExecute('manage_agent_employee', 'standard'), false);
});

test('Standard: delete_task → false (full-tier queues regardless)', () => {
  assert.equal(shouldAutoExecute('delete_task', 'standard'), false);
});

test('Standard: create_task with mode=delete → true (quick-tier, destructive guard irrelevant)', () => {
  // Standard allows quick-tier regardless of params. Only Autonomous applies the guard.
  assert.equal(shouldAutoExecute('create_task', 'standard', { mode: 'delete' }), true);
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
