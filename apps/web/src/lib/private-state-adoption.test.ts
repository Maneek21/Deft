import assert from 'node:assert/strict';
import test from 'node:test';
import { PrivateStateAdoptionContext, reviewOutput, parseAdoptionActivation } from './private-state-adoption';

const id = '11111111-1111-4111-8111-111111111111', digest = `sha256:${'a'.repeat(64)}`;
const record = { record_id:id,revision:1,byte_length:20,created_at:'2026-01-01T00:00:00.000Z',expires_at:'2027-01-01T00:00:00.000Z' };
const group = { source_artifact_digest:digest,source_app_version_id:id,source_version:'1.0.0',count:1,records:[record] };
test('adoption context rejects widened, duplicate, inconsistent and malformed metadata', () => {
  const context = { schema_version:'deft.private_state.adoption_context.v1',groups:[group] };
  assert.equal(PrivateStateAdoptionContext.parse(context).groups[0].count,1);
  for (const invalid of [{...context,html:'bad'},{...context,groups:[{...group,count:2}]},
    {...context,groups:[{...group,count:2,records:[record,record]}]}, {...context,groups:[{...group,source_artifact_digest:'bad'}]},
    {...context,groups:[{...group,records:[{...record,expires_at:'2026-02-30T00:00:00.000Z'}]}]}]) {
    assert.throws(() => PrivateStateAdoptionContext.parse(invalid));
  }
});
test('adoption review is bounded, strict and rejects expired authority', () => {
  const output = { schema_version:'deft.private_state.adoption_review.v1',...group,
    organization_id:id,owner_user_id:id,web_session_id:id,experience_session_id:id,installation_id:id,app_version_id:id,grant_snapshot_id:id,exposure_id:id,
    state_key:'drafts',exposure_epoch:1,lifecycle_epoch:1,grant_epoch:1,exposure_review_digest:digest,target_artifact_digest:digest,declaration_digest:digest,
    expires_at:new Date(Date.now()+60000).toISOString(),review_token:'abc' };
  assert.equal(reviewOutput({output}).count,1);
  assert.throws(() => reviewOutput({output:{...output,plaintext:'private'}}));
  assert.throws(() => reviewOutput({output:{...output,review_token:'a'.repeat(24001)}}));
  assert.throws(() => reviewOutput({output:{...output,expires_at:'2020-01-01T00:00:00.000Z'}}));
  assert.deepEqual(parseAdoptionActivation({output:{schema_version:'deft.private_state.adoption_activated.v1',adopted_count:1}}),{adopted_count:1});
  assert.throws(() => parseAdoptionActivation({output:{schema_version:'deft.private_state.adoption_activated.v1',adopted_count:1,value:'private'}}));
});
