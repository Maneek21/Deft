import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {securityTestDatabaseIsSafe} from './fixtures/security-test-database.js';

/** The public external Email1.9 declaration, not provider credentials or mail.
 * CI builds a content-free artifact; the local regression can use the EXACT
 * independently built signed package through DEFT_TEST_EXTERNAL_EMAIL_PACKAGE. */
const declared=JSON.parse(readFileSync(new URL('./fixtures/supplemental-effects-manifest.json',import.meta.url),'utf8'));
const safe=securityTestDatabaseIsSafe();

test('public v7 activation preserves signed supplemental declarations and SQL rejects corrupt effect policies',
 {skip:!safe,timeout:90000},async t=>{
 Object.assign(process.env,{DEFT_APPS_ENABLED:'true',DEFT_APP_RUNS_ENABLED:'true',DEFT_APP_RUN_APP_ORIGIN_ENABLED:'true',
  DEFT_APP_ATTACHMENT_BROKER_ENABLED:'true',DEFT_APP_RUNTIME_CHANNEL_ENABLED:'true',DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED:'true',
  DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED:'true',DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED:'true',DEFT_APP_PRIVATE_STATE_ENABLED:'true'});
 const ring=(id:string)=>({current:id,keys:{[id]:createHash('sha256').update('supplemental-db-test:'+id).digest('base64')}});
 process.env.DEFT_APP_RUN_KEYRINGS=JSON.stringify({schema_version:'deft.app_run_keyring.v1',run_encryption:ring('enc'),receipt_signing:ring('sign'),fingerprint:ring('fp')});
 const [{app},{db,closeDb},s,orm,kit,web]=await Promise.all([import('../src/index.js'),import('../src/lib/db.js'),import('@deft/db/schema'),import('drizzle-orm'),import('@deft/app-kit'),import('../src/lib/web-sessions.js')]);
 t.after(async()=>{await(await import('../src/lib/app-attachment-runtime.js')).shutdownAppAttachmentRuntime();await(await import('../src/lib/app-run-runtime.js')).shutdownAppRunRuntime();await closeDb();});
 const org=randomUUID(),owner=randomUUID(),suffix=randomUUID().replaceAll('-','');
 await db.insert(s.orgs).values({id:org,name:'Supplemental SQL regression',slug:'supplemental-'+suffix});
 await db.insert(s.users).values({id:owner,name:'Synthetic owner',email:'supplemental-'+suffix+'@example.test'});
 await db.insert(s.orgMembers).values({org_id:org,user_id:owner,role:'owner',is_active:true});
 const session=await web.createWebSession({id:owner,org_id:org,email:'supplemental-'+suffix+'@example.test'});
 const request=async(path:string,method='GET',body?:unknown)=>{
  const response=await app.request('http://localhost'+path,{method,headers:{authorization:'Bearer '+session.accessToken,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
  return{status:response.status,body:await response.json()as any};
 };
 const call=async(path:string,method='GET',body?:unknown)=>{const r=await request(path,method,body);assert.ok(r.status<300,path+': '+JSON.stringify(r));return r.body;};
 const artifact=await kit.prepareDeftExperienceArtifact('experiences/main.json',{schema_version:'deft.experience_bundle.v3',worker_source:'self.onmessage=()=>{};',entry_view:'main',resource_keys:['inbox'],action_keys:['mirror_drafts','organize_messages','send_message'],state_keys:[],record_store_keys:declared.record_stores.map((r:any)=>r.key).sort(),search_resource_keys:['inbox']});
 const manifest={...declared,experiences:declared.experiences.map((e:any)=>({...e,artifact_path:artifact.path,artifact_digest:artifact.digest}))};
 const current=process.env.DEFT_TEST_EXTERNAL_EMAIL_PACKAGE?{json:readFileSync(process.env.DEFT_TEST_EXTERNAL_EMAIL_PACKAGE,'utf8')}:await kit.buildDeftAppPackage({manifest,artifacts:[artifact]});
 const exact=JSON.parse(current.json);assert.equal(exact.manifest.id,'io.deft.email');assert.equal(exact.manifest.version,'1.9.0-preview.1');assert.deepEqual(exact.manifest.record_stores,declared.record_stores);
 const legacyManifest={...manifest,version:'1.8.0',record_stores:manifest.record_stores.map((r:any)=>{const old={...r};delete old.supplemental_effects;return old;})};
 const legacy=await kit.buildDeftAppPackage({manifest:legacyManifest,artifacts:[artifact]});
 const staged=await call('/api/apps/blob/composition/stage','POST',legacy.json);const installation=staged.app.id;
 const initial=await call(`/api/apps/blob/composition/${installation}/context?app_version_id=${staged.app.version_id}`);
 const initialReview=await call(`/api/apps/blob/composition/${installation}/review`,'POST',initial.review_request);
 await call(`/api/apps/blob/composition/${installation}/activate`,'POST',{...initial.review_request,expected_review_digest:initialReview.review.review_digest,accept_host_policy:true});
 const oldGrants=await db.select().from(s.appGrantSnapshots).where(orm.eq(s.appGrantSnapshots.app_installation_id,installation));
 const [before]=await db.select().from(s.appInstallations).where(orm.eq(s.appInstallations.id,installation));
 const prefix=`/api/apps/blob/composition/${installation}/upgrade`;
 const upgrade=await call(prefix+'/stage','POST',{schema_version:'deft.app_attachment_upgrade_stage.v1',package_json:current.json,expected_lifecycle_epoch:before.lifecycle_epoch});
 const context=await call(prefix+`/context?app_version_id=${upgrade.app_version_id}`);const reviewed=await call(prefix+'/review','POST',context.review_request);
 assert.deepEqual(reviewed.review.target_authority.record_stores,exact.manifest.record_stores,'review signs the complete declared effect policy');
 await call(prefix+'/activate','POST',{...context.review_request,expected_review_digest:reviewed.review.review_digest,accept_host_policy:true});
 const [after]=await db.select().from(s.appInstallations).where(orm.eq(s.appInstallations.id,installation));
 assert.equal(after.active_version_id,upgrade.app_version_id);assert.equal(after.lifecycle_epoch,before.lifecycle_epoch+1);
 const oldAfter=await db.select().from(s.appGrantSnapshots).where(orm.inArray(s.appGrantSnapshots.id,oldGrants.map(r=>r.id)));assert.deepEqual(oldAfter,oldGrants,'retained grants are byte-for-byte unchanged');
 const [effective]=await db.select().from(s.appGrantSnapshots).where(orm.eq(s.appGrantSnapshots.id,after.active_grant_snapshot_id!));
 assert.deepEqual((effective.canonical_snapshot as any).record_stores,exact.manifest.record_stores,'persisted grant exactly equals signed manifest');
 // A genuinely new tenant exercises initial activation, not only upgrade.
 const freshOrg=randomUUID();await db.insert(s.orgs).values({id:freshOrg,name:'Fresh supplemental fixture',slug:'fresh-supplemental-'+suffix});
 await db.insert(s.orgMembers).values({org_id:freshOrg,user_id:owner,role:'owner',is_active:true});
 const freshSession=await web.createWebSession({id:owner,org_id:freshOrg,email:'supplemental-'+suffix+'@example.test'});
 const freshCall=async(path:string,method='GET',body?:unknown)=>{
  const response=await app.request('http://localhost'+path,{method,headers:{authorization:'Bearer '+freshSession.accessToken,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
  const value=await response.json()as any;assert.ok(response.status<300,path+': '+JSON.stringify(value));return value;
 };
 const freshStage=await freshCall('/api/apps/blob/composition/stage','POST',current.json),freshId=freshStage.app.id;
 const freshContext=await freshCall(`/api/apps/blob/composition/${freshId}/context?app_version_id=${freshStage.app.version_id}`);
 const freshReview=await freshCall(`/api/apps/blob/composition/${freshId}/review`,'POST',freshContext.review_request);
 await freshCall(`/api/apps/blob/composition/${freshId}/activate`,'POST',{...freshContext.review_request,expected_review_digest:freshReview.review.review_digest,accept_host_policy:true});
 const [freshInstallation]=await db.select().from(s.appInstallations).where(orm.eq(s.appInstallations.id,freshId));
 const [freshGrant]=await db.select().from(s.appGrantSnapshots).where(orm.eq(s.appGrantSnapshots.id,freshInstallation.active_grant_snapshot_id!));
 assert.deepEqual((freshGrant.canonical_snapshot as any).record_stores,exact.manifest.record_stores);
 const c=new pg.Client({connectionString:process.env.DEFT_TEST_DATABASE_URL,statement_timeout:5000,query_timeout:6000});await c.connect();
 try{
  await c.query('BEGIN');await c.query('SET LOCAL search_path=pg_temp,public');
  for(const table of ['app_versions','app_installations','app_grant_snapshots','org_members'])await c.query(`CREATE TEMP TABLE ${table} AS SELECT * FROM public.${table} WHERE org_id=$1`,[org]);
  await c.query('CREATE TRIGGER supplemental_shape BEFORE INSERT ON pg_temp.app_grant_snapshots FOR EACH ROW EXECUTE FUNCTION public.enforce_app_v7_effective_grant_shape()');
  const insert=(row:any)=>c.query('INSERT INTO pg_temp.app_grant_snapshots SELECT * FROM jsonb_populate_record(NULL::pg_temp.app_grant_snapshots,$1::jsonb)',[JSON.stringify({...row,id:randomUUID()})]);
  await c.query('SAVEPOINT accepted');await insert(effective);await c.query('ROLLBACK TO SAVEPOINT accepted');
  await c.query('SAVEPOINT old_accepted');await insert(oldGrants.find(r=>r.snapshot_kind==='effective'));await c.query('ROLLBACK TO SAVEPOINT old_accepted');
  const canonical=effective.canonical_snapshot as any;let rejected=0;
  const deny=async(label:string,mutate:(stores:any[])=>void,matchingManifest=true)=>{
   const stores=structuredClone(canonical.record_stores);mutate(stores);
   await c.query('UPDATE pg_temp.app_versions SET manifest=$1::jsonb WHERE id=$2',[JSON.stringify({...exact.manifest,record_stores:matchingManifest?stores:exact.manifest.record_stores}),upgrade.app_version_id]);
   await c.query('SAVEPOINT denied');await assert.rejects(insert({...effective,canonical_snapshot:{...canonical,record_stores:stores}}),(e:any)=>e.code==='23514'&&e.message.includes(matchingManifest?'APP_V7_SUPPLEMENTAL_EFFECT_INVALID':'APP_V7_RECORD_STORE_INVALID'),label);await c.query('ROLLBACK TO SAVEPOINT denied');rejected++;
  };
  const drafts=(stores:any[])=>stores.find(r=>r.key==='drafts');
  await deny('signed declaration mismatch',r=>drafts(r).supplemental_effects[0].version='tampered.v1',false);
  await deny('unbounded details',r=>delete drafts(r).supplemental_effects[0].details_schema.properties.mode.maxLength);
  await deny('open details',r=>drafts(r).supplemental_effects[0].details_schema.additionalProperties=true);
  await deny('malformed details',r=>drafts(r).supplemental_effects[0].details_schema=null);
  await deny('duplicate action',r=>drafts(r).supplemental_effects.push({...drafts(r).supplemental_effects[0],key:'zz_second'}));
  await deny('too many effects',r=>drafts(r).supplemental_effects=Array.from({length:5},(_,i)=>({...drafts(r).supplemental_effects[0],key:'effect_'+i})));
  await deny('foreign action',r=>drafts(r).supplemental_effects[0].action_key='foreign_action');
  await deny('null effects',r=>drafts(r).supplemental_effects=null);
  await deny('empty effects',r=>drafts(r).supplemental_effects=[]);
  await deny('duplicate effect keys',r=>drafts(r).supplemental_effects.push({...drafts(r).supplemental_effects[0],action_key:'mirror_drafts'}));
  await deny('out-of-order effects',r=>drafts(r).supplemental_effects=[{...drafts(r).supplemental_effects[0],key:'z_copy',action_key:'mirror_drafts'},{...drafts(r).supplemental_effects[0],key:'a_copy'}]);
  const schemaCases:[string,(schema:any)=>void][]=[
   ['unknown schema key',s=>s.unbounded=true],['schema reference',s=>s.$ref='https://invalid.example.test/schema'],
   ['undeclared required field',s=>s.required.push('missing')],['duplicate required field',s=>s.required.push('mode')],
   ['too many properties',s=>{for(let i=0;i<29;i++)s.properties['field_'+i]={type:'boolean'};}],
   ['reversed number bounds',s=>s.properties.count={type:'number',minimum:2,maximum:1}],
   ['unpaired safe HTML',s=>s.properties.html={type:'string',maxLength:128,format:'safe_html',plainTextKey:'missing'}],
   ['editable HTML plain field',s=>{s.properties.html={type:'string',maxLength:128,format:'safe_html',plainTextKey:'plain'};s.properties.plain={type:'string',maxLength:128,readOnly:false};}],
   ['required HTML without plain',s=>{s.properties.html={type:'string',maxLength:128,format:'safe_html',plainTextKey:'plain'};s.properties.plain={type:'string',maxLength:128,readOnly:true};s.required.push('html');}],
   ['reused HTML plain field',s=>{s.properties.html={type:'string',maxLength:128,format:'safe_html',plainTextKey:'plain'};s.properties.other={...s.properties.html};s.properties.plain={type:'string',maxLength:128,readOnly:true};}],
   ['mailbox list bound',s=>s.properties.addresses={type:'string',maxLength:2048,format:'mailbox_list',maxItems:33}],
   ['resource list bound',s=>s.properties.ids={type:'string',maxLength:925,format:'resource_record_list',maxItems:26,resourceKey:'inbox'}],
   ['opaque account bounds',s=>s.properties.account={type:'string',format:'opaque_account_reference',minLength:0,maxLength:512}],
   ['unsafe title',s=>s.properties.mode.title='unsafe<caption>'],['title control character',s=>s.properties.mode.title='unsafe\u0001caption'],['UTF16 title bound',s=>s.properties.mode.title='😀'.repeat(41)],
  ];
  for(const[label,mutate]of schemaCases)await deny(label,r=>mutate(drafts(r).supplemental_effects[0].details_schema));
  const validSchema={type:'object',properties:{html:{type:'string',maxLength:128,format:'safe_html',plainTextKey:'plain'},plain:{type:'string',maxLength:128,readOnly:true},count:{type:'number',minimum:0,maximum:1}},required:['html','plain'],additionalProperties:false};
  assert.equal((await c.query('SELECT public.deft_app_runtime_object_schema_valid($1::jsonb) AS valid',[JSON.stringify(validSchema)])).rows[0].valid,true,'valid plain pairing is accepted');
  assert.equal((await c.query(`SELECT public.deft_app_runtime_object_schema_valid('{"type":"object","properties":{"count":{"type":"number","minimum":0,"maximum":1e400}},"required":[],"additionalProperties":false}'::jsonb) AS valid`)).rows[0].valid,false,'PostgreSQL numeric outside finite JavaScript range is rejected');
  assert.equal((await c.query('SELECT public.deft_app_supplemental_effects_valid($1::jsonb,$2::jsonb,$3::jsonb) AS valid',[JSON.stringify(drafts(canonical.record_stores).supplemental_effects),JSON.stringify(drafts(canonical.record_stores)),JSON.stringify({...canonical,owner_connections:canonical.owner_connections.map((p:any)=>({...p,resource_key:'foreign_resource'}))})])).rows[0].valid,false,'globally declared action cannot authorize an effect on a foreign resource');
  assert.equal(rejected,27);await c.query('ROLLBACK');
 }finally{await c.query('ROLLBACK').catch(()=>{});await c.end();}
});
