import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {AttachmentAppUpgradeReviewPanel} from '../components/apps/attachment-app-upgrade-review';
import {attachmentUpgradeReviewDigest} from './app-attachment-upgrade';
async function fixture(blocked=false){const id='11111111-1111-4111-8111-111111111111',hash='sha256:'+'a'.repeat(64);const value={schema_version:'deft.app_attachment_upgrade_review.v1',organization_id:id,installation_id:id,pending_work_policy:'drain_before_activation',request:{schema_version:'deft.app_attachment_upgrade_review_request.v1',pending_work_policy:'drain_before_activation',prior_app_version_id:id,expected_prior_package_digest:hash,expected_prior_grant_snapshot_digest:hash,app_version_id:id,expected_package_digest:hash,expected_requested_snapshot_digest:hash,expected_lifecycle_epoch:4,expected_grant_epoch:5},prior_authority:{old_access:'Read'},target_authority:{new_access:'Read'},modules:[],blockers:{old_work:blocked?{unknown_outcome:1}:{},active_dependents:0,pending_public_followups:0},fresh_runtime_binding_review_required:true,fresh_resource_binding_consent_required:true,private_state_adoption_required:true,authority_carry_forward:false};return {...value,review_digest:await attachmentUpgradeReviewDigest(value)} as any;}
test('actual review renders complete before/after access and requires explicit acceptance',async()=>{
 let actions=0;const html=renderToStaticMarkup(<AttachmentAppUpgradeReviewPanel review={await fixture()} busy={false} accepted={false} onAccept={()=>{}} onActivate={()=>actions++} onClose={()=>{}}/>);
 assert.match(html,/Current access/);assert.match(html,/Requested access/);assert.match(html,/old_access/);assert.match(html,/new_access/);assert.match(html,/<button[^>]*disabled[^>]*>Accept review and upgrade/);assert.equal(actions,0);
});
test('actual blocked review denies activation even when the checkbox was previously accepted',async()=>{
 const html=renderToStaticMarkup(<AttachmentAppUpgradeReviewPanel review={await fixture(true)} busy={false} accepted onAccept={()=>{}} onActivate={()=>{}} onClose={()=>{}}/>);
 assert.match(html,/unknown outcome: 1/);assert.match(html,/Do not repeat uncertain actions/);assert.match(html,/<button[^>]*disabled[^>]*>Accept review and upgrade/);
});
