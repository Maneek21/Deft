import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// A dedicated functional database only. This test is not a bootstrap or release
// attestation and never targets the deployed workspace.
const safe=(()=>{try{const value=process.env.DEFT_TEST_DATABASE_URL;if(!value||value!==process.env.DATABASE_URL)return false;const url=new URL(value);return ['postgres:','postgresql:'].includes(url.protocol)&&url.hostname==='127.0.0.1'&&['55435','55436'].includes(url.port)&&url.pathname==='/gate_g_20261018_email_task_test'&&!url.search&&!url.hash;}catch{return false;}})();
test('published source core creates one real Postgres task with date, receipt and current source guards',{skip:!safe},async()=>{
 const [{db,closeDb},schema,{eq,and,sql},{createAppIntegrationSource,appIntegrationSourceDigest},{createAppIntegrationDestination},{appIntegrationDestinationPostgres},{appIntegrationTaskAdapter},{appIntegrationPublishedProjection,appIntegrationExactLocatorCandidate,AppIntegrationSourcePendingError}]=await Promise.all([
  import('../src/lib/db.js'),import('@deft/db/schema'),import('drizzle-orm'),import('../src/lib/app-integration-source.js'),import('../src/lib/app-integration-destination.js'),import('../src/lib/app-integration-destination-postgres.js'),import('../src/lib/app-integration-task.js'),import('../src/lib/app-integration-source-projection.js')]);
 const org=randomUUID(),owner=randomUUID(),project=randomUUID(),installation=randomUUID(),binding=randomUUID(),projection=randomUUID(),checkpoint=randomUUID(),request=randomUUID();
 const caller={org_id:org,user_id:owner,kind:'human' as const,principal_id:randomUUID()};
 const ref={resource_key:'inbox',record_id:randomUUID(),content_digest:'sha256:'+'a'.repeat(64)};
 const identity={installation_id:installation,account_ref:'controlled_recipient',store_key:'drafts',ref},target={...identity,resource_binding_id:binding,projection_id:projection};
 const mapping={sync_descriptor_key:'inbox',record_id_field:'source_record_id',content_digest_field:'source_content_digest',observed_at_field:'source_observed_at',projection_identity_field:'logical_message_id',navigation_entry_key:'main'};
 const record={revision:'received-revision',data:{logical_message_id:'mail_'+'b'.repeat(64),source_record_id:ref.record_id,source_content_digest:ref.content_digest,source_observed_at:'2026-10-18T12:27:00Z'}};
 let authorized=true,published=false,changed=false;
 try{
  await db.insert(schema.orgs).values({id:org,name:'Email task functional fixture',slug:'email-task-'+org});
  await db.insert(schema.users).values({id:owner,name:'Controlled Email owner',email:'email-task-'+owner+'@example.test'});
  await db.insert(schema.orgMembers).values({org_id:org,user_id:owner,role:'owner',is_active:true});
  await db.insert(schema.projects).values({id:project,org_id:org,name:'Northstar functional fixture',prefix:'ETEST'});
  // Persist the exact normalized publication vector; production account/runtime
  // adapters are covered separately by source-resolution and runtime tests.
  await db.execute(sql`CREATE TABLE IF NOT EXISTS email_task_functional_publications(id text PRIMARY KEY,org_id text NOT NULL,owner_user_id text NOT NULL,record jsonb NOT NULL)`);
  const source=createAppIntegrationSource({
   async authority(actor){const members=await db.select().from(schema.orgMembers).where(and(eq(schema.orgMembers.org_id,actor.org_id),eq(schema.orgMembers.user_id,actor.user_id),eq(schema.orgMembers.is_active,true)));if(!authorized||actor.org_id!==org||actor.user_id!==owner||!members.length)throw Error('SOURCE_DENIED');return {identity:appIntegrationSourceDigest([org,owner,binding]),expires_at:Date.now()+60000};},
   async publication(actor){const rows=published?(await db.execute(sql`SELECT record FROM email_task_functional_publications WHERE id=${projection} AND org_id=${actor.org_id} AND owner_user_id=${actor.user_id}`)).rows:[];
    appIntegrationExactLocatorCandidate(rows.map(()=>({resource_id_hmac_key_version:'fixture',resource_id_hmac:'exact'})),[{key_version:'fixture',fingerprint:'exact'}]);
    return appIntegrationPublishedProjection({target,mapping,descriptor_key:'inbox',checkpoint:{id:checkpoint,generation:1,cursor_sequence:1,state:'active'},row:{id:projection,resource_binding_id:binding,checkpoint_id:checkpoint,generation:1,state:'live',applied_sequence:1},record:rows[0]!.record as typeof record});},
   async runtime(){return {resource:{record_id:ref.record_id,content_digest:changed?'sha256:'+'c'.repeat(64):ref.content_digest,revision:'received-revision',label:'Controlled received Email',data:{},tombstone:false,membership_generation:1,checkpoint_generation:1},presentation:{plain_text:'Controlled Northstar approval'}};},
  });
  const service=createAppIntegrationDestination({transaction:fn=>db.transaction(fn),source:{resolve:async()=>target,read:source.read,guard:source.guard},...appIntegrationDestinationPostgres({task:appIntegrationTaskAdapter})});
  const input={source:identity,destination:{kind:'task',project_id:project},mode:'source_link',title:'Received Email handoff',task_details:{description:'Review Northstar approval',status:'todo',priority:'p1',assignee_id:owner,due_date:'2026-10-21'}};
  await assert.rejects(service.review(caller,input),AppIntegrationSourcePendingError);
  await db.execute(sql`INSERT INTO email_task_functional_publications(id,org_id,owner_user_id,record) VALUES(${projection},${org},${owner},${JSON.stringify(record)}::jsonb)`);published=true;
  const review=await service.review(caller,input);assert.equal(review.audience.member_count,1);assert.equal(review.partial,true);
  const commit={...input,request_id:request,review_digest:review.review_digest},result=await service.commit(caller,commit);
  assert.equal((await service.commit(caller,commit)).destination_id,result.destination_id);
  assert.equal((await service.status(caller,request)).destination_id,result.destination_id);
  const [task]=await db.select().from(schema.tasks).where(eq(schema.tasks.id,result.destination_id));
  assert.equal(task!.due_date!.toISOString(),'2026-10-21T00:00:00.000Z');assert.equal(task!.assignee_id,owner);assert.match(task!.description!,/Review Northstar approval/);assert.ok(task!.description!.includes('/apps/source/transfer/'+request));
  assert.equal((await db.select().from(schema.tasks).where(eq(schema.tasks.org_id,org))).length,1);
  await assert.rejects(service.commit(caller,{...commit,task_details:{...input.task_details,due_date:'2026-10-22'}}),/CONFLICT/);
  changed=true;await assert.rejects(service.review(caller,input));changed=false;
  await assert.rejects(service.review({...caller,org_id:randomUUID()},input));
  authorized=false;await assert.rejects(service.statusWithSource(caller,request),/SOURCE_DENIED/);
  assert.equal((await db.select().from(schema.tasks).where(eq(schema.tasks.org_id,org))).length,1);
 }finally{await closeDb();}
});
