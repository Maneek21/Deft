import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { AppResourceSyncClosureReviewSchema } from './app-resource-sync-closure-contract.js';

const id = '10000000-0000-4000-8000-000000000001';
const digest = `sha256:${'a'.repeat(64)}`;
const review = { schema_version: 'deft.app_private_sync_closure_review.v1',
  org_id: id, run_id: id, reviewer_user_id: id, resource_binding_id: id,
  runtime_registration_id: id, owner_user_id: id, operator_user_id: id,
  installation_id: id, app_version_id: id, grant_snapshot_id: id,
  package_digest: digest, grant_snapshot_digest: digest, descriptor_digest: digest,
  lifecycle_epoch: 1, grant_epoch: 1, runtime_epoch: 1, target_key: 'personal',
  consent_expires_at: '2026-10-15T18:00:00Z', state: 'unknown_outcome',
  unknown_outcome_at: '2026-10-15T17:00:00Z', attempt_id: id, attempt_digest: digest,
  intent_digest: digest, checkpoint_id: id, checkpoint_digest: digest,
  basis: 'operator_closes_unknown_sync', provider_outcome: 'unknown', no_retry: true, review_digest: digest };

test('closure review retains finite wire bytes and accepts only explicit persistent null', () => {
  assert.deepEqual(AppResourceSyncClosureReviewSchema.parse(review), review);
  const persistent = { ...review, consent_expires_at: null, consent_lifetime: 'until_revoked' };
  assert.deepEqual(AppResourceSyncClosureReviewSchema.parse(persistent), persistent);
  for (const delta of [{ consent_expires_at: null }, { consent_lifetime: 'until_revoked' },
    { consent_expires_at: null, consent_lifetime: 'forever' }, { consent_expires_at: 'Infinity' },
    { unexpected: true }]) assert.equal(AppResourceSyncClosureReviewSchema.safeParse({ ...review, ...delta }).success, false);
});

test('actual setup existing-binding serializer emits persistent mode and unchanged finite wire', () => {
  // Execute the actual selected return expression: a serialization seam, not a DB/authority proof.
  const path = new URL('./app-resource-sync-management.ts', import.meta.url);
  const source = readFileSync(path, 'utf8');
  const tree = ts.createSourceFile('management.ts', source, ts.ScriptTarget.Latest, true);
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(tree) === 'existing_binding') {
      assert.equal(expression, undefined); expression = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.ok(expression);
  const js = ts.transpile(`const result = (${expression.getText(tree)});`, { target: ts.ScriptTarget.ES2022 });
  const emit = new Function('binding', 'operator_user_id', 'actor', 'appConsentDeadline', 'now', `${js}; return result;`);
  const deadline = (date: Date | null, mode?: string | null) => mode === 'until_revoked' && date === null ? Infinity : date?.getTime() ?? -Infinity;
  const now = new Date('2026-10-15T17:00:00Z');
  const binding = { binding_id: id, operator_user_id: id, registration_state: 'active', state: 'active',
    consent_expires_at: new Date('2026-10-15T18:00:00Z'), consent_lifetime: null as string | null };
  assert.deepEqual(emit(binding, id, { actor_id: id }, deadline, now), {
    binding_id: id, operator_user_id: id, state: 'active', consent_expires_at: '2026-10-15T18:00:00.000Z',
    can_issue_session: true, requires_revoke: false });
  const persistent = emit({ ...binding, consent_expires_at: null, consent_lifetime: 'until_revoked' }, id, { actor_id: id }, deadline, now);
  assert.equal(persistent.consent_expires_at, null); assert.equal(persistent.consent_lifetime, 'until_revoked');
  assert.equal(persistent.can_issue_session, true); assert.equal(persistent.requires_revoke, false);
});
