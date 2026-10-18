import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import * as schema from '@deft/db/schema';
import {createAppIntegrationCaptureStore} from './app-integration-capture-store.js';
import {createAppIntegrationCapture} from './app-integration-capture.js';
import {createAppIntegrationSource,appIntegrationSourceDigest,type AppIntegrationSourceCaller,type AppIntegrationPublishedSource} from './app-integration-source.js';
import {readAppIntegrationRelatedKnowledge,appIntegrationKnowledgeDestinationCondition,loadAppIntegrationCitationSources,decorateAppIntegrationKnowledgeCitations} from './app-integration-knowledge-citations.js';
import type {AppRunTransaction as Tx} from './app-run-repository.js';
import {assertAppIntegrationCaptureDelivery,APP_INTEGRATION_CAPTURE_JOB} from './app-integration-capture-authority.js';
import {createAppIntegrationCaptureRoutes} from '../routes/app-integration-capture.js';

const targetUrl=process.env.DEFT_E4_SOURCE_TEST_DATABASE_URL;
const safe=targetUrl==='postgresql://e4_source_test:e4-test-only@127.0.0.1:55440/e4_source_knowledge_sol_20261011';
const pool=new pg.Pool({connectionString:safe?targetUrl:undefined,max:8}),database=drizzle(pool,{schema});
const transaction=<T>(fn:(tx:Tx)=>Promise<T>)=>database.transaction(tx=>fn(tx));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const human:AppIntegrationSourceCaller={org_id:id(1),user_id:id(2),kind:'human',principal_id:id(3)};
const ref={resource_key:'mail',record_id:id(4),content_digest:'sha256:'+'a'.repeat(64)};
const target={installation_id:id(5),account_ref:'account_a',store_key:'compose',resource_binding_id:id(6),projection_id:id(7),ref};
const observed='2026-10-11T00:00:00Z',body='We agreed to preserve original requests, validate the recipient, and retain this reusable release procedure.';
const policyInput={enabled:true,destination:{scope:'user' as const,space_id:null},history_days:30,include_bulk:false,excluded_senders:[],excluded_folders:[],expected_revision:0};
const embeddings:Array<{page_id:string;version:number}>=[];
const store=createAppIntegrationCaptureStore({transaction,clock:()=>Date.parse(observed),enqueueEmbedding:async(tx,page_id,version)=>{
 await tx.execute((await import('drizzle-orm')).sql`INSERT INTO test_embedding_outbox(page_id,version) VALUES(${page_id},${version})`);embeddings.push({page_id,version});}});

before(async()=>{if(!safe)return;
 await pool.query('DROP TABLE IF EXISTS app_integration_capture_sources,app_integration_capture_threads,app_integration_capture_claims,app_integration_capture_policies,test_embedding_outbox,wiki_citations,wiki_page_versions,wiki_pages,email_knowledge_budgets,space_members,spaces,org_members,app_installations,users,orgs,job_queue CASCADE');
 await pool.query(`CREATE TABLE orgs(id text PRIMARY KEY,ai_config jsonb DEFAULT '{}'); CREATE TABLE users(id text PRIMARY KEY,kind text,is_agent boolean);
 CREATE TABLE app_installations(id text PRIMARY KEY,org_id text,UNIQUE(org_id,id)); CREATE TABLE org_members(org_id text,user_id text,is_active boolean);
 CREATE TABLE spaces(id text PRIMARY KEY,org_id text,is_archived boolean); CREATE TABLE space_members(space_id text,user_id text);
 CREATE TABLE wiki_pages(id text PRIMARY KEY,org_id text,scope text DEFAULT 'org',space_id text,origin_space_id text,origin_message_id text,origin_user_id text,created_via text,user_id text,agent_employee_id text,type text,title text,slug text,summary text,content text,metadata jsonb,confidence real,version integer DEFAULT 1,previous_content text,is_deleted boolean DEFAULT false,embedding text,tags text[],referenced_user_ids text[],created_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now(),UNIQUE(org_id,slug));
 CREATE TABLE wiki_page_versions(id text PRIMARY KEY,page_id text,version integer,title text,content text,summary text,edited_by text,created_at timestamp DEFAULT now(),UNIQUE(page_id,version));
 CREATE TABLE wiki_citations(id text PRIMARY KEY,org_id text,page_id text,source_type text,source_id text,source_space_id text,source_user_id text,excerpt text,created_at timestamp DEFAULT now());
 CREATE TABLE email_knowledge_budgets(org_id text,day text,budget_key text,reserved_tokens integer DEFAULT 0,created_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now(),PRIMARY KEY(org_id,day,budget_key));
 CREATE TABLE test_embedding_outbox(page_id text,version integer,PRIMARY KEY(page_id,version));`);
 await pool.query(`CREATE TABLE job_queue(id text PRIMARY KEY,org_id text,queue text,name text,data jsonb,status text,lock_token text,lock_expires_at timestamp);`);
 await pool.query(await readFile(new URL('../../../../packages/db/upgrades/app-integration-capture.unallocated.sql',import.meta.url),'utf8'));
 await pool.query('INSERT INTO orgs(id) VALUES($1);',[human.org_id]);await pool.query('INSERT INTO users VALUES($1,\'human\',false)',[human.user_id]);
 await pool.query('INSERT INTO org_members VALUES($1,$2,true)',[human.org_id,human.user_id]);await pool.query('INSERT INTO app_installations VALUES($1,$2)',[target.installation_id,human.org_id]);
});
after(async()=>{await pool.end();});

async function fixture(options:{budget?:number;fail?:boolean;duringModel?:()=>Promise<void>;body?:string;thread?:string}={}){
 await pool.query('TRUNCATE app_integration_capture_sources,app_integration_capture_threads,app_integration_capture_claims,app_integration_capture_policies,wiki_citations,wiki_page_versions,wiki_pages,email_knowledge_budgets,test_embedding_outbox');
 await pool.query('UPDATE orgs SET ai_config=$1',[JSON.stringify({email_knowledge_daily_token_budget:options.budget??500000,email_knowledge_account_daily_token_budget:128000})]);
 const policy=await store.writePolicy(human,target,policyInput,async()=>{}),caller:AppIntegrationSourceCaller={...human,kind:'capture_policy',principal_id:policy.id};
 let allowed=true,models=0,reads=0;const publication:AppIntegrationPublishedSource={target,checkpoint_id:id(8),generation:1,cursor_sequence:2,projection_revision:'provider1',applied_sequence:2,payload_digest:'sha256:'+'b'.repeat(64),observed_at:observed,partial:true};
 const source=createAppIntegrationSource({clock:()=>1000,authority:async()=>{if(!allowed)throw Error('revoked');return {identity:'capture:'+policy.id,expires_at:2000};},publication:async()=>publication,
  runtime:async()=>{reads++;return {resource:{record_id:ref.record_id,content_digest:ref.content_digest,revision:'opaque_rev',label:'Observed',data:{},tombstone:false,membership_generation:1,checkpoint_generation:1},presentation:{plain_text:options.body??body}};}});
 const evidenceBody=options.body??body;
 const service=createAppIntegrationCapture({...store,source,evidence:async()=>({eligible:true,body:evidenceBody,sender:'Person',received_at:observed,thread_key:appIntegrationSourceDigest(options.thread??'thread_a'),body_digest:appIntegrationSourceDigest(evidenceBody),partial:true,attachments_processed:false}),
  extract:async()=>{models++;await options.duringModel?.();if(options.fail)throw Error('model failed');return {capture:true,title:'Release procedure',type:'procedure',content:evidenceBody,excerpt:evidenceBody.slice(0,40)};}});
 return {service,source,caller,policy,models:()=>models,reads:()=>reads,revoke:()=>{allowed=false;},advance:()=>{(publication as {cursor_sequence:number}).cursor_sequence++;}};
}
test('actual PostgreSQL budget denial rolls back org/account reservation and unique claim before model',{skip:!safe},async()=>{
 const f=await fixture({budget:1});await assert.rejects(f.service.process(f.caller,target,1),/BUDGET_EXCEEDED/u);assert.equal(f.models(),0);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM email_knowledge_budgets')).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM app_integration_capture_claims')).rows[0].n,0);
});
test('actual capture admission requires exact opted-in policy and current owned queue delivery, never tool/browser grants',{skip:!safe},async()=>{
 const f=await fixture(),caller={...f.caller,capture_delivery:{job_id:id(40),lock_token:'owned-lock',policy_revision:1}};
 await pool.query('TRUNCATE job_queue');await pool.query('INSERT INTO job_queue VALUES($1,$2,\'scheduled-jobs\',$3,$4,\'running\',\'owned-lock\',$5)',[id(40),human.org_id,APP_INTEGRATION_CAPTURE_JOB,JSON.stringify({policy_id:f.policy.id,policy_revision:1}),new Date(Date.parse(observed)+10000)]);
 const check=(actor=caller,account=target)=>transaction(tx=>assertAppIntegrationCaptureDelivery(tx,actor,account,Date.parse(observed)));
 await check();
 await assert.rejects(check({...caller,kind:'human'}));await assert.rejects(check({...caller,kind:'personal_mcp'}));
 await assert.rejects(check(caller,{...target,account_ref:'foreign_account'}));
 await assert.rejects(check({...caller,capture_delivery:{...caller.capture_delivery,lock_token:'other-lock'}}));
 await assert.rejects(check({...caller,capture_delivery:{...caller.capture_delivery,policy_revision:2}}));
 await pool.query('UPDATE job_queue SET lock_expires_at=$1',[new Date(Date.parse(observed))]);await assert.rejects(check());
 await pool.query('UPDATE job_queue SET lock_expires_at=$1',[new Date(Date.parse(observed)+10000)]);
 await store.writePolicy(human,target,{...policyInput,enabled:false,expected_revision:1},async()=>{});await assert.rejects(check());
});
test('actual settings are default-off and opt-in policy plus scheduling callback roll back together',{skip:!safe},async()=>{
 await fixture();await pool.query('TRUNCATE app_integration_capture_policies CASCADE');
 const settings=await transaction(tx=>store.settings(tx,human,target));assert.equal(settings.enabled,false);assert.equal(settings.revision,0);
 await assert.rejects(store.writePolicy(human,target,policyInput,async()=>{},async()=>{throw Error('queue unavailable');}));
 assert.equal((await pool.query('SELECT count(*)::int n FROM app_integration_capture_policies')).rows[0].n,0);
});
test('actual source revocation/publication change during model denies all destination writes and retains budget',{skip:!safe},async()=>{
 for(const change of ['revoke','advance'] as const){let f:Awaited<ReturnType<typeof fixture>>;f=await fixture({duringModel:async()=>f[change]()});
  await assert.rejects(f.service.process(f.caller,target,1));assert.equal(f.models(),1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM wiki_pages')).rows[0].n,0);
  assert.ok(Number((await pool.query('SELECT sum(reserved_tokens) n FROM email_knowledge_budgets')).rows[0].n)>0);
 }
});
test('actual retained citation audience survives source revocation while original link requires fresh owned source',{skip:!safe},async()=>{
 const f=await fixture();await f.service.process(f.caller,target,1);
 const citation=(await pool.query('SELECT source_type,source_id,excerpt FROM wiki_citations')).rows[0];
 const records=await transaction(tx=>loadAppIntegrationCitationSources(tx,human,[citation.source_id]));
 assert.equal('resource_binding_id' in records[0]!.target,false);assert.equal('projection_id' in records[0]!.target,false);
 const live=await decorateAppIntegrationKnowledgeCitations({caller:human,citations:[citation],records,read:async()=>{await f.source.read(human,target,'read');}});assert.match(live[0]!.source_url!,/^\/apps\/source\//u);
 f.revoke();const revoked=await decorateAppIntegrationKnowledgeCitations({caller:human,citations:[citation],records,read:async()=>{await f.source.read(human,target,'read');}});
 assert.equal(revoked[0]!.source_url,null);assert.equal(revoked[0]!.excerpt,citation.excerpt);
 const foreign=await decorateAppIntegrationKnowledgeCitations({caller:{...human,user_id:id(99)},citations:[citation],records,read:async()=>{throw Error('must never fetch foreign source');}});assert.equal(foreign[0]!.source_url,null);
});
test('actual duplicate delivery charges one model and commits page/citation/lineage/embed atomically',{skip:!safe},async()=>{
 const f=await fixture(),results=await Promise.all([f.service.process(f.caller,target,1),f.service.process(f.caller,target,1)]);
 assert.deepEqual(results.map(r=>r.state).sort(),['captured','duplicate']);assert.equal(f.models(),1);assert.ok(f.reads()>=3);
 const counts=(await pool.query(`SELECT (SELECT count(*) FROM wiki_pages)::int pages,(SELECT count(*) FROM wiki_citations)::int citations,(SELECT count(*) FROM app_integration_capture_sources)::int sources,(SELECT count(*) FROM app_integration_capture_threads)::int threads,(SELECT count(*) FROM test_embedding_outbox)::int embeds`)).rows[0];assert.deepEqual(counts,{pages:1,citations:1,sources:1,threads:1,embeds:1});
 const snapshot=await f.source.read(human,target,'read');const related=await transaction(tx=>readAppIntegrationRelatedKnowledge(tx,human,snapshot,()=>f.source.guard(tx,human,snapshot,'read')));assert.equal(related.length,1);assert.equal(related[0]!.partial,true);
});
test('actual failed extraction retains budget and prevents repeat model delivery',{skip:!safe},async()=>{
 const f=await fixture({fail:true});await assert.rejects(f.service.process(f.caller,target,1));assert.equal((await f.service.process(f.caller,target,1)).state,'duplicate');assert.equal(f.models(),1);
 assert.ok(Number((await pool.query('SELECT sum(reserved_tokens) AS n FROM email_knowledge_budgets')).rows[0].n)>0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM wiki_pages')).rows[0].n,0);
});
test('actual pause during extraction denies destination commit while preserving reservation',{skip:!safe},async()=>{
 let f:Awaited<ReturnType<typeof fixture>>;
 f=await fixture({duringModel:async()=>{await store.writePolicy(human,target,{...policyInput,enabled:false,expected_revision:1},async()=>{});}});
 await assert.rejects(f.service.process(f.caller,target,1));assert.equal(f.models(),1);assert.equal((await pool.query('SELECT count(*)::int AS n FROM wiki_pages')).rows[0].n,0);
 await assert.rejects(f.service.process(f.caller,target,1));assert.equal(f.models(),1);
});
test('actual manual edit during extraction protects page and retains supported lineage',{skip:!safe},async()=>{
 const f=await fixture(),first=await f.service.process(f.caller,target,1);assert.ok(first.page_id);
 // Different body in same authenticated thread, with a manual edit during the model.
 const evidenceBody=body+' Correction: preserve the original digest too.';
 const service=createAppIntegrationCapture({...store,source:f.source,evidence:async()=>({eligible:true,body:evidenceBody,sender:'Person',received_at:observed,thread_key:appIntegrationSourceDigest('thread_a'),body_digest:appIntegrationSourceDigest(evidenceBody),partial:true,attachments_processed:false}),
  extract:async()=>{await pool.query('UPDATE wiki_pages SET content=\'Human text\',version=version+1 WHERE id=$1',[first.page_id]);return {capture:true,title:'Correction',type:'fact',content:'Unsupported replacement',excerpt:evidenceBody.slice(0,40)};}});
 assert.equal((await service.process(f.caller,target,1)).state,'protected');assert.equal((await pool.query('SELECT content FROM wiki_pages WHERE id=$1',[first.page_id])).rows[0].content,'Human text');
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM wiki_citations')).rows[0].n,1);
});
test('actual destination audience condition denies deleted/foreign pages and removed capturing owner from Space',{skip:!safe},async()=>{
 const f=await fixture(),result=await f.service.process(f.caller,target,1);await pool.query('INSERT INTO spaces VALUES($1,$2,false)',[id(9),human.org_id]);
 await pool.query('UPDATE wiki_pages SET scope=\'space\',space_id=$1 WHERE id=$2',[id(9),result.page_id]);
 const {wikiPages}=await import('@deft/db/schema');const visible=()=>database.select({id:wikiPages.id}).from(wikiPages).where(appIntegrationKnowledgeDestinationCondition(human.user_id,human.org_id));
 assert.equal((await visible()).length,0);await pool.query('INSERT INTO space_members VALUES($1,$2)',[id(9),human.user_id]);assert.equal((await visible()).length,1);
 await pool.query('UPDATE wiki_pages SET is_deleted=true');assert.equal((await visible()).length,0);assert.equal((await database.select({id:wikiPages.id}).from(wikiPages).where(appIntegrationKnowledgeDestinationCondition(human.user_id,id(10)))).length,0);
});

function amendedService(f:Awaited<ReturnType<typeof fixture>>,text:string,ports=store,onModel?:()=>void){
 return createAppIntegrationCapture({...ports,source:f.source,evidence:async()=>({eligible:true,body:text,sender:'Person',received_at:observed,thread_key:appIntegrationSourceDigest('thread_a'),body_digest:appIntegrationSourceDigest(text),partial:true,attachments_processed:false}),
  extract:async()=>{onModel?.();return {capture:true,title:'Release procedure revised',type:'procedure',content:text,excerpt:text.slice(0,40)};}});
}
test('actual related message updates one unedited page with prior version, second citation and atomic embedding outbox',{skip:!safe},async()=>{
 const f=await fixture(),first=await f.service.process(f.caller,target,1),text=body+' Correction: keep the exact source digest with the original request.';
 const next=await amendedService(f,text).process(f.caller,target,1);assert.equal(next.state,'updated');assert.equal(next.page_id,first.page_id);
 assert.equal((await pool.query('SELECT count(*)::int n FROM wiki_pages')).rows[0].n,1);
 const page=(await pool.query('SELECT version,content FROM wiki_pages')).rows[0];assert.equal(page.version,2);assert.ok(page.content.endsWith(text));
 assert.ok((await pool.query('SELECT content FROM wiki_page_versions')).rows[0].content.endsWith(body));
 for(const table of ['wiki_citations','app_integration_capture_sources','test_embedding_outbox'])assert.equal((await pool.query('SELECT count(*)::int n FROM '+table)).rows[0].n,2);
});
test('actual deleted related page is protected before model and never resurrected',{skip:!safe},async()=>{
 const f=await fixture(),first=await f.service.process(f.caller,target,1);await pool.query('UPDATE wiki_pages SET is_deleted=true WHERE id=$1',[first.page_id]);
 let models=0;const result=await amendedService(f,body+' An additional substantive update.',store,()=>models++).process(f.caller,target,1);
 assert.equal(result.state,'protected');assert.equal(models,0);assert.equal((await pool.query('SELECT is_deleted FROM wiki_pages')).rows[0].is_deleted,true);
 assert.equal((await pool.query('SELECT count(*)::int n FROM wiki_citations')).rows[0].n,1);
 assert.equal((await pool.query("SELECT count(*)::int n FROM app_integration_capture_claims WHERE state='protected'")).rows[0].n,1);
});
test('actual embedding enqueue failure rolls back page, citation, lineage and thread but retains failed claim and budget',{skip:!safe},async()=>{
 const f=await fixture(),broken=createAppIntegrationCaptureStore({transaction,clock:()=>Date.parse(observed),enqueueEmbedding:async()=>{throw Error('embedding queue unavailable');}});
 await assert.rejects(amendedService(f,body,broken).process(f.caller,target,1),/embedding queue unavailable/u);
 for(const table of ['wiki_pages','wiki_citations','app_integration_capture_sources','app_integration_capture_threads'])assert.equal((await pool.query('SELECT count(*)::int n FROM '+table)).rows[0].n,0);
 assert.equal((await pool.query('SELECT state FROM app_integration_capture_claims')).rows[0].state,'failed');
 assert.ok(Number((await pool.query('SELECT sum(reserved_tokens) n FROM email_knowledge_budgets')).rows[0].n)>0);
});

test('public Knowledge route and real PostgreSQL policy guard preserve default-off, reject actor injection and atomically pause',{skip:!safe},async()=>{
 const f=await fixture();await pool.query('TRUNCATE app_integration_capture_policies CASCADE');
 const snapshot=await f.source.read(human,target,'read'),identity={installation_id:target.installation_id,account_ref:target.account_ref,store_key:target.store_key,ref};
 let queues=0;const route=createAppIntegrationCaptureRoutes({authenticate:async request=>{if(request.headers.get('authorization')!=='Bearer isolated-human')throw Error('denied');return human;},
  settings:(c)=>transaction(tx=>store.settings(tx,c,target)),
  write:(c,_identity,p)=>store.writePolicy(c,target,p,tx=>f.source.guard(tx,c,snapshot,'read'),async(_tx,p)=>{if(p.enabled)queues++;}),
  related:async()=>[],open:async()=>{throw Error('not part of fixture');}});
 const send=(path:string,input:unknown,token='Bearer isolated-human')=>route.request('http://isolated/'+path,{method:'POST',headers:{'content-type':'application/json',authorization:token},body:JSON.stringify(input)});
 const first=await send('settings',{source:identity});assert.equal(first.status,200);assert.equal((await first.json() as {enabled:boolean}).enabled,false);assert.equal(queues,0);
 assert.equal((await pool.query('SELECT count(*)::int n FROM app_integration_capture_policies')).rows[0].n,0);
 assert.equal((await send('write',{source:identity,policy:policyInput,caller:{kind:'capture_policy'}})).status,400);
 assert.equal((await send('write',{source:identity,policy:policyInput},'Bearer foreign')).status,403);
 assert.equal((await send('write',{source:identity,policy:policyInput})).status,200);assert.equal(queues,1);
 assert.equal((await send('write',{source:identity,policy:{...policyInput,enabled:false,expected_revision:1}})).status,200);
 const current=(await pool.query('SELECT enabled,revision FROM app_integration_capture_policies')).rows[0];assert.equal(current.enabled,false);assert.equal(current.revision,2);assert.equal(queues,1);
 assert.equal((await send('write',{source:identity,policy:policyInput})).status,409);
});
