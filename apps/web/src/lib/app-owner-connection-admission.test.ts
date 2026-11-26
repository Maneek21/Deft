import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { accountOperatorChoices, admissionRequest, admissionReview, canAdmitAccountOperators, DEFAULT_ADMISSION_LIMITS } from './app-owner-connection-admission';
import type { AppInstallation, AppOwnerConnectionPolicy } from './apps';

// Real answers recorded from a local hosted-mode cell walking the Email App.
const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/email-app-connect-journey.json', import.meta.url), 'utf8'));
const app = fixture.answers.apps_active.body.apps[0] as AppInstallation;
const grants = fixture.answers.grants.body;
const recorded = fixture.answers.admission_review.body.review.snapshot;
const policies = (app.manifest as { owner_connections: AppOwnerConnectionPolicy[] }).owner_connections;
const policy = policies.find(row => row.key === recorded.policy.key)!;
const operator = fixture.answers.auth_me.body.user.id as string;

test('the admission screen is shown to exactly the roles the server lets admit: owner and admin', () => {
  // The owner of Deft has not chosen between owner-and-admin and owner-only. Narrowing is
  // ACCOUNT_OPERATOR_ADMISSION_ROLES; change this expectation with it.
  assert.deepEqual(['owner', 'admin', 'member', 'guest', undefined].map(canAdmitAccountOperators), [true, true, false, false, false]);
});

test('only people the server accepts are offered as account operator', () => {
  const people = [{ id: 'o', name: 'O', kind: 'human', role: 'owner' }, { id: 'a', name: 'A', kind: 'human', role: 'admin' },
    { id: 'm', name: 'M', kind: 'human', role: 'member' }, { id: 'g', name: 'G', kind: 'human', role: 'guest' },
    { id: 'd', name: 'Defty', kind: 'agent', role: 'member' }];
  assert.deepEqual(accountOperatorChoices(people).map(row => row.id), ['o', 'a', 'm']);
});

test('the admission request carries the current pins and is what the server reviewed', () => {
  const request = admissionRequest(app, grants, policy, operator, DEFAULT_ADMISSION_LIMITS);
  const snapshot = fixture.answers.admission_review.body.review.snapshot;
  assert.equal(request.expected_grant_snapshot_digest, snapshot.grant_snapshot_digest);
  assert.equal(request.expected_package_digest, snapshot.package_digest);
  assert.equal(request.policy_key, recorded.policy.key);
  assert.equal(request.operator_user_id, snapshot.operator_user_id);
  assert.deepEqual(request.limits, snapshot.limits);
  assert.throws(() => admissionRequest({ ...app, id: '00000000-0000-4000-8000-000000000000' }, grants, policy, operator, DEFAULT_ADMISSION_LIMITS), /changed/);
  assert.throws(() => admissionRequest(app, grants, policy, operator, { ...DEFAULT_ADMISSION_LIMITS, min_interval_seconds: 30 }), /between 60/);
});

test("the server's real review is accepted, and one for another operator, policy or limit is refused", () => {
  const request = admissionRequest(app, grants, policy, operator, DEFAULT_ADMISSION_LIMITS);
  const real = fixture.answers.admission_review.body;
  const checked = admissionReview(real, request);
  assert.deepEqual(checked.action_keys, ['organize_messages', 'send_message']);
  assert.equal(checked.profile?.key, policy.provider_profile_key);
  assert.equal(checked.resource_key, policy.resource_key);
  const changed = (edit: (snapshot: any) => void) => { const copy = structuredClone(real); edit(copy.review.snapshot); return copy; };
  for (const edit of [(s: any) => { s.operator_user_id = '00000000-0000-4000-8000-000000000001'; },
    (s: any) => { s.policy.key = policies.find(row => row.key !== policy.key)!.key; }, (s: any) => { s.limits.max_retained_records += 1; },
    (s: any) => { s.lifecycle_epoch += 1; }, (s: any) => { s.grant_epoch += 1; },
    (s: any) => { s.connection_profile.operator_user_id = '00000000-0000-4000-8000-000000000001'; }])
    assert.throws(() => admissionReview(changed(edit), request), /changed/);
});
