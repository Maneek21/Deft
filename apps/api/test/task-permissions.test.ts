/**
 * Task 0.2 — Delete permission guard + skill-aware status transition validator.
 *
 * Run: node --test --import tsx test/task-permissions.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canDeleteTask } from '../src/lib/task-permissions.js';
import {
  isValidTransition,
  type ProjectResolvedConfig,
} from '../src/lib/task-status-machine.js';

const ENGINEERING_CONFIG: ProjectResolvedConfig = {
  statuses: [
    { id: 'backlog', label: 'Backlog', color: '#6b7280', order: 0 },
    { id: 'todo', label: 'To Do', color: '#3b82f6', order: 1 },
    { id: 'in_progress', label: 'In Progress', color: '#f59e0b', order: 2 },
    { id: 'in_review', label: 'In Review', color: '#8b5cf6', order: 3 },
    { id: 'done', label: 'Done', color: '#10b981', order: 4 },
    { id: 'cancelled', label: 'Cancelled', color: '#ef4444', order: 5 },
  ],
  allowed_transitions: {
    backlog: ['todo', 'in_progress', 'cancelled'],
    todo: ['in_progress', 'backlog', 'cancelled'],
    in_progress: ['in_review', 'done', 'backlog', 'cancelled'],
    in_review: ['in_progress', 'done', 'cancelled'],
    done: ['in_progress', 'backlog'],
    cancelled: ['backlog'],
  },
};

const MARKETING_CONFIG: ProjectResolvedConfig = {
  statuses: [
    { id: 'idea', label: 'Idea', color: '#6b7280', order: 0 },
    { id: 'drafting', label: 'Drafting', color: '#3b82f6', order: 1 },
    { id: 'review', label: 'Review', color: '#f59e0b', order: 2 },
    { id: 'published', label: 'Published', color: '#10b981', order: 3 },
  ],
  allowed_transitions: null,
};

// ─── canDeleteTask ─────────────────────────────────────────────────────────

test('canDeleteTask: creator can delete', () => {
  const user = { id: 'u1' };
  const task = { created_by: 'u1', assignee_id: null };
  assert.equal(canDeleteTask(user, task, 'member'), true);
});

test('canDeleteTask: assignee can delete', () => {
  const user = { id: 'u2' };
  const task = { created_by: 'u1', assignee_id: 'u2' };
  assert.equal(canDeleteTask(user, task, 'member'), true);
});

test('canDeleteTask: org owner can delete any task', () => {
  const user = { id: 'u3' };
  const task = { created_by: 'u1', assignee_id: 'u2' };
  assert.equal(canDeleteTask(user, task, 'owner'), true);
});

test('canDeleteTask: org admin can delete any task', () => {
  const user = { id: 'u3' };
  const task = { created_by: 'u1', assignee_id: 'u2' };
  assert.equal(canDeleteTask(user, task, 'admin'), true);
});

test('canDeleteTask: unrelated member cannot delete', () => {
  const user = { id: 'u3' };
  const task = { created_by: 'u1', assignee_id: 'u2' };
  assert.equal(canDeleteTask(user, task, 'member'), false);
});

test('canDeleteTask: guest (not creator/assignee) cannot delete', () => {
  const user = { id: 'u3' };
  const task = { created_by: 'u1', assignee_id: 'u2' };
  assert.equal(canDeleteTask(user, task, 'guest'), false);
});

test('canDeleteTask: no org role and not creator/assignee returns false', () => {
  const user = { id: 'u3' };
  const task = { created_by: 'u1', assignee_id: 'u2' };
  assert.equal(canDeleteTask(user, task, null), false);
  assert.equal(canDeleteTask(user, task, undefined), false);
});

test('canDeleteTask: assignee_id null does not match user id null-ish', () => {
  const user = { id: 'u3' };
  const task = { created_by: 'u1', assignee_id: null };
  assert.equal(canDeleteTask(user, task, 'member'), false);
});

// ─── isValidTransition — Engineering (strict) ──────────────────────────────

test('isValidTransition Engineering: backlog -> todo allowed', () => {
  assert.equal(isValidTransition('backlog', 'todo', ENGINEERING_CONFIG), true);
});

test('isValidTransition Engineering: backlog -> in_progress allowed', () => {
  assert.equal(isValidTransition('backlog', 'in_progress', ENGINEERING_CONFIG), true);
});

test('isValidTransition Engineering: backlog -> cancelled allowed', () => {
  assert.equal(isValidTransition('backlog', 'cancelled', ENGINEERING_CONFIG), true);
});

test('isValidTransition Engineering: todo -> in_review disallowed', () => {
  assert.equal(isValidTransition('todo', 'in_review', ENGINEERING_CONFIG), false);
});

test('isValidTransition Engineering: backlog -> done disallowed', () => {
  assert.equal(isValidTransition('backlog', 'done', ENGINEERING_CONFIG), false);
});

test('isValidTransition Engineering: in_progress -> in_review allowed', () => {
  assert.equal(isValidTransition('in_progress', 'in_review', ENGINEERING_CONFIG), true);
});

test('isValidTransition Engineering: in_review -> done allowed', () => {
  assert.equal(isValidTransition('in_review', 'done', ENGINEERING_CONFIG), true);
});

test('isValidTransition Engineering: done -> in_progress allowed (reopen)', () => {
  assert.equal(isValidTransition('done', 'in_progress', ENGINEERING_CONFIG), true);
});

test('isValidTransition Engineering: done -> cancelled disallowed', () => {
  assert.equal(isValidTransition('done', 'cancelled', ENGINEERING_CONFIG), false);
});

test('isValidTransition Engineering: cancelled -> backlog allowed', () => {
  assert.equal(isValidTransition('cancelled', 'backlog', ENGINEERING_CONFIG), true);
});

test('isValidTransition Engineering: cancelled -> todo disallowed', () => {
  assert.equal(isValidTransition('cancelled', 'todo', ENGINEERING_CONFIG), false);
});

test('isValidTransition Engineering: unknown target status is invalid', () => {
  assert.equal(isValidTransition('backlog', 'shipped', ENGINEERING_CONFIG), false);
});

test('isValidTransition Engineering: same-status no-op is allowed', () => {
  assert.equal(isValidTransition('in_progress', 'in_progress', ENGINEERING_CONFIG), true);
});

test('isValidTransition Engineering: unknown from-status disallows (no transition list)', () => {
  assert.equal(isValidTransition('shipped', 'done', ENGINEERING_CONFIG), false);
});

// ─── isValidTransition — Marketing (fluid) ─────────────────────────────────

test('isValidTransition Marketing: idea -> published allowed (any-to-any)', () => {
  assert.equal(isValidTransition('idea', 'published', MARKETING_CONFIG), true);
});

test('isValidTransition Marketing: published -> idea allowed (any-to-any)', () => {
  assert.equal(isValidTransition('published', 'idea', MARKETING_CONFIG), true);
});

test('isValidTransition Marketing: drafting -> review allowed', () => {
  assert.equal(isValidTransition('drafting', 'review', MARKETING_CONFIG), true);
});

test('isValidTransition Marketing: unknown target status is invalid', () => {
  assert.equal(isValidTransition('idea', 'archived', MARKETING_CONFIG), false);
});

test('isValidTransition Marketing: same-status no-op is allowed', () => {
  assert.equal(isValidTransition('drafting', 'drafting', MARKETING_CONFIG), true);
});
