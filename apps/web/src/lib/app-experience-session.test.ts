import assert from 'node:assert/strict';
import test from 'node:test';
import { experienceLifetimeIsCurrent, normalizeExperienceExposureReview, normalizeInstalledExperienceSession } from './app-experience-session';
test('new signed record stores need no dummy private state and retain exact large budgets',()=>{
 const id='11111111-1111-4111-8111-111111111111',digest='sha256:'+'a'.repeat(64);
 const store={schema_version:'deft.app_record_store.v1',key:'drafts',resource_key:'inbox',runtime_requirement_key:'sync_provider',max_record_bytes:491520,max_files:32,max_file_bytes:26214400,max_total_file_bytes:26214400,
  resource_content:{max_presentation_bytes:262144,max_source_bytes:36700160,max_file_bytes:26214400,max_image_bytes:2097152},declaration_digest:digest};
 const profile={renderer_version:'deft.trusted_renderer.v2',capabilities:['record_document.v1','record_form.v1']};
 const session={pin:{org_id:id,user_id:id,app_installation_id:id,app_version_id:id,grant_snapshot_id:id,lifecycle_epoch:1,grant_epoch:1,session_id:id,session_epoch:1},
  experience:{key:'main',label:'Inbox',artifact_digest:digest,bridge_version:'deft.experience_bridge.v1',...profile},
  bundle:{schema_version:'deft.experience_bundle.v3',worker_source:'self.onmessage=()=>{}',entry_view:'main',resource_keys:['inbox'],action_keys:['send_message'],state_keys:[],record_store_keys:['drafts']},expires_at:'2026-10-09T01:00:00Z'};
 assert.deepEqual(normalizeInstalledExperienceSession(session).bundle.state_keys,[]);assert.deepEqual(normalizeInstalledExperienceSession(session).bundle.record_store_keys,['drafts']);
 const review={review_token:'fixture',review_digest:digest,snapshot:{schema_version:'deft.experience_resource_exposure.v3',destination:'verified_installed_experience_worker',app_name:'Email',app_version:'1.7.0-e2.1',owner_label:'Owner',experience_label:'Inbox',artifact_digest:digest,bridge_version:'deft.experience_bridge.v1',...profile,expires_at:session.expires_at,review_expires_at:session.expires_at,resources:[],record_stores:[store]}};
 const normalized=normalizeExperienceExposureReview(review);assert.equal(Object.hasOwn(normalized.snapshot,'private_state'),false);assert.deepEqual(normalized.snapshot.record_stores,[store]);
 assert.throws(()=>normalizeInstalledExperienceSession({...session,bundle:{...session.bundle,record_store_keys:[]}}));
 assert.throws(()=>normalizeExperienceExposureReview({...review,snapshot:{...review.snapshot,record_stores:[{...store,max_record_bytes:491521}]}}));
 assert.throws(()=>normalizeExperienceExposureReview({...review,snapshot:{...review.snapshot,record_stores:[{...store,native_api:'/private'}]}}));
});

test('session and exposure preserve negotiated document profiles and reject unsupported version/capability pairs', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const experience = { key: 'workspace', label: 'Workspace', artifact_digest: 'sha256:' + 'a'.repeat(64),
    bridge_version: 'deft.experience_bridge.v1', renderer_version: 'deft.trusted_renderer.v1' };
  const session = { pin: { org_id: id, user_id: id, app_installation_id: id, app_version_id: id, grant_snapshot_id: id,
    lifecycle_epoch: 1, grant_epoch: 1, session_id: id, session_epoch: 1 }, experience,
    bundle: { schema_version: 'deft.experience_bundle.v1', worker_source: 'self.onmessage=()=>{}', entry_view: 'workspace', resource_keys: ['messages'], action_keys: [] },
    expires_at: '2026-10-09T01:00:00Z' };
  assert.deepEqual(normalizeInstalledExperienceSession(session), session);
  assert.equal(Object.hasOwn(normalizeInstalledExperienceSession(session).experience, 'capabilities'), false);
  const v2 = { renderer_version: 'deft.trusted_renderer.v2', capabilities: ['resource_document.v1'] };
  assert.deepEqual(normalizeInstalledExperienceSession({ ...session, experience: { ...experience, ...v2 } }).experience, { ...experience, ...v2 });
  const snapshot = { schema_version: 'deft.experience_resource_exposure.v1', destination: 'verified_installed_experience_worker',
    app_name: 'Example', app_version: '1.0.0', owner_label: 'Owner', experience_label: 'Workspace', artifact_digest: experience.artifact_digest,
    bridge_version: experience.bridge_version, ...v2, expires_at: session.expires_at, review_expires_at: session.expires_at,
    resources: [{ resource_key: 'messages', label: 'Messages', resource_type: 'messages', allowed_operations: ['list_summary', 'read_one'], allowed_fields: ['subject'] }] };
  const review = { review_token: 'fixture', review_digest: 'sha256:' + 'b'.repeat(64), snapshot };
  assert.deepEqual(normalizeExperienceExposureReview(review).snapshot.capabilities, ['resource_document.v1']);
  assert.equal(normalizeExperienceExposureReview(review).snapshot.renderer_version, v2.renderer_version);
  for (const profile of [{ renderer_version: 'deft.trusted_renderer.v99' },
    { renderer_version: 'deft.trusted_renderer.v1', capabilities: ['resource_document.v1'] },
    { renderer_version: 'deft.trusted_renderer.v2' },
    ...[[], ['resource_refresh.v1'], ['resource_document.v1', 'resource_document.v1']]
      .map(capabilities => ({ renderer_version: 'deft.trusted_renderer.v2', capabilities }))]) {
    assert.throws(() => normalizeInstalledExperienceSession({ ...session, experience: { ...experience, ...profile } }));
    const { capabilities: _caps, ...withoutCaps } = snapshot;
    assert.throws(() => normalizeExperienceExposureReview({ ...review, snapshot: { ...withoutCaps, ...profile } }));
  }
});

test('delayed responses cannot outlive known session or exposure deadlines', async () => {
  let now = 1000;
  const sessionExpiry = new Date(3000).toISOString();
  const exposureExpiry = new Date(2000).toISOString();
  let finish!: () => void;
  const response = new Promise<void>(resolve => { finish = resolve; });
  const live = async () => {
    if (!experienceLifetimeIsCurrent(sessionExpiry, exposureExpiry, now)) return false;
    await response;
    return experienceLifetimeIsCurrent(sessionExpiry, exposureExpiry, now);
  };
  const pending = live(); now = 2000; finish();
  assert.equal(await pending, false);
  assert.equal(experienceLifetimeIsCurrent(sessionExpiry, undefined, 3000), false);
  assert.equal(experienceLifetimeIsCurrent('invalid', exposureExpiry, 1000), false);
  assert.equal(experienceLifetimeIsCurrent(sessionExpiry, 'invalid', 1000), false);
});

test('session exposure retains reviewed document metadata exactly and rejects hidden policy/schema keys',()=>{
 const metadata_schema={type:'object',additionalProperties:false,properties:{account_id:{type:'string',maxLength:200}},required:['account_id']};
 const content_policy={document:{max_characters:16384,metadata_schema,formats:['plain','html']},source:{media_type:'message/rfc822',filename:'message.eml',max_bytes:8388608},triage_options:{max_options:100},search_filters:['from','has_attachments']};
 const resource={resource_key:'inbox',label:'Inbox',resource_type:'messages',allowed_operations:['list_summary','read_one','search'],allowed_fields:['subject'],content_policy};
 const snapshot={schema_version:'deft.experience_resource_exposure.v2',destination:'verified_installed_experience_worker',app_name:'Example',app_version:'1.0.0',owner_label:'Owner',experience_label:'Inbox',artifact_digest:'sha256:'+'c'.repeat(64),expires_at:'2026-10-01T10:00:00Z',review_expires_at:'2026-10-01T09:00:00Z',resources:[resource]};
 const review={review_token:'fixture',review_digest:'sha256:'+'b'.repeat(64),snapshot};
 assert.deepEqual(normalizeExperienceExposureReview(review).snapshot.resources[0]?.content_policy,content_policy);
 const legacy={...resource};delete (legacy as {content_policy?:unknown}).content_policy;assert.equal(Object.hasOwn(normalizeExperienceExposureReview({...review,snapshot:{...snapshot,resources:[legacy]}}).snapshot.resources[0]!,'content_policy'),false);
 for(const policy of [{...content_policy,provider_locator:'secret'},{...content_policy,resource_key:'inbox'},{document:{...content_policy.document,html:true}},
  {document:{...content_policy.document,metadata_schema:{...metadata_schema,properties:{account_id:{type:'string',maxLength:200,secret:true}}}}}])assert.throws(()=>normalizeExperienceExposureReview({...review,snapshot:{...snapshot,resources:[{...resource,content_policy:policy}]}}));
});

test('private exposure review retains optional file and payload limits exactly without widening legacy state', () => {
  const state = { key: 'drafts', label: 'Drafts', declaration_digest: 'sha256:' + 'a'.repeat(64), allowed_operations: ['list', 'read', 'put', 'delete'],
    max_record_bytes: 16384, max_records: 32, max_total_bytes: 131072, retention_days: 30 };
  const files = { max_file_bytes: 2_097_152, max_files_per_record: 1, max_total_bytes_per_record: 2_097_152, allowed_media_types: ['application/pdf'] };
  const payloads = [{ action_key: 'send_message', max_payload_bytes: 4_194_304 }];
  const review = { review_token: 'fixture', review_digest: 'sha256:' + 'b'.repeat(64), snapshot: {
    schema_version: 'deft.experience_resource_exposure.v3', destination: 'verified_installed_experience_worker', app_name: 'Example', app_version: '1.0.0',
    owner_label: 'Owner', experience_label: 'Main', artifact_digest: 'sha256:' + 'c'.repeat(64), expires_at: '2026-09-30T01:00:00.000Z',
    review_expires_at: '2026-09-30T00:01:00.000Z', resources: [], private_state: [state] } };
  assert.equal(Object.hasOwn(normalizeExperienceExposureReview(review).snapshot.private_state![0], 'files'), false);
  const proposed = { ...state, files, action_payloads: payloads };
  assert.deepEqual(normalizeExperienceExposureReview({ ...review, snapshot: { ...review.snapshot, private_state: [proposed] } }).snapshot.private_state, [proposed]);
  for (const changed of [{ ...proposed, files: { ...files, max_total_bytes_per_record: 1 } },
    { ...proposed, files: { ...files, allowed_media_types: ['text/html'] } },
    { ...proposed, action_payloads: [payloads[0], payloads[0]] }, { ...proposed, action_payloads: [{ ...payloads[0], max_payload_bytes: 0 }] }]) {
    assert.throws(() => normalizeExperienceExposureReview({ ...review, snapshot: { ...review.snapshot, private_state: [changed] } }));
  }
  assert.throws(() => normalizeExperienceExposureReview({ ...review, snapshot: { ...review.snapshot,
    private_state: [proposed, { ...proposed, key: 'other' }] } }));
});
