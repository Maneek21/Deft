import test,{mock} from 'node:test';import assert from 'node:assert/strict';
import {collectCompilerReadFacts,validateCompilerGrounding} from '../src/lib/agent-compiler-read-facts.js';
const id='00000000-0000-4000-8000-000000000001',digest='sha256:'+'a'.repeat(64);
const record={id,resource_id:'module_record:'+id,installation_id:id,module_id:'com.deft.contacts',collection_key:'contacts',manifest_digest:digest,data:{name:'Elena',role:'Reviewer'},relations:[],members:[],revision:2,created_at:'2026-10-19T00:00:00Z',updated_at:'2026-10-19T00:00:00Z',archived_at:null};
const reads=[{action:'module_record_get',readOnly:true,success:true,result:{record}},{action:'wiki_read',readOnly:true,success:true,result:{slug:'LIVE261019-reviewed-publication-note',title:'Reviewed publication',content:'Original body.',version:2}}];
test('successful current actor reads retain canonical complete compiler facts within bounded context',()=>{
 const facts=collectCompilerReadFacts(reads);assert.equal(facts.facts.length,2);assert.equal(facts.limitations.length,0);assert.ok(JSON.stringify(facts).includes(digest));assert.ok(JSON.stringify(facts).includes('Original body.'));
 const omitted=collectCompilerReadFacts([{...reads[1],result:{...reads[1].result,content:'x'.repeat(65_537)}}]);assert.equal(omitted.facts.length,0);assert.match(omitted.limitations[0],/whole fact omitted/);
});
test('actual malformed module and invented wiki graph are rejected with explicit grounding feedback',()=>{
 const actual=[{action:'module_record_update',params:{record_id:'Elena reviewed contact',changed_fields:['role'],expected_revision:1,expected_manifest_digest:'sha256:dummy'}},{action:'wiki_write',params:{slug:'LIVE261019_Reviewed_publication_note',content:'[Keep the wiki exact current body, appending this sentence:] Reviewed.'}}];
 const out=validateCompilerGrounding(actual,collectCompilerReadFacts(reads),'Append the sentence Reviewed.');assert.equal(out.actions.length,0);assert.equal(out.warnings.length,2);
});
test('valid two proposals bind actual revision/digest/slug; literal requested text is retained',()=>{
 const literal='[Keep the wiki exact current body, appending this sentence:]';
 const actions=[{action:'module_record_update',params:{record_id:id,expected_revision:2,expected_manifest_digest:digest,patch:{role:'Reviewed lead'}}},{action:'wiki_write',params:{slug:'LIVE261019-reviewed-publication-note',content:'Original body.\n\n'+literal}}];
 const out=validateCompilerGrounding(actions,collectCompilerReadFacts(reads),'Append the literal text '+literal);assert.deepEqual(out.actions,actions);assert.equal(out.warnings.length,0);
 const artifact=validateCompilerGrounding([{...actions[1],params:{...actions[1].params,content:literal+' Reviewed.'}}],collectCompilerReadFacts(reads),'Append Reviewed.');assert.equal(artifact.actions.length,0);assert.match(artifact.warnings[0],/current full page body/);
});

// The compiler input is untrusted workspace data wrapped in <workspace_context>.
function compilerContext(content:string){const match=/^<workspace_context>\n([\s\S]*)\n<\/workspace_context>$/.exec(content);assert.ok(match,'compiler input must be wrapped as untrusted workspace context');return JSON.parse(match[1]!);}

test('fallback compiler receives same-turn structured facts in its actual model input',async()=>{
 let captured:any;
 mock.module('../src/lib/llm.js',{namedExports:{llm:async(value:any)=>{captured=value;return {text:'',toolCalls:[{name:'module_record_update',input:{idempotency_key:'ordinary-compiler-record-update',record_id:id,expected_revision:2,expected_manifest_digest:digest,patch:{role:'Reviewed lead'}}},{name:'wiki_write',input:{slug:'LIVE261019-reviewed-publication-note',content:'Original body.\n\nReviewed.'}}],model:'deterministic-test',usage:{input:1,output:1}};}}});
 const {compileDeftyActionDraft}=await import('../src/lib/agent-action-proposals.js');
 const draft=await compileDeftyActionDraft({orgId:'00000000-0000-4000-8000-000000000003',promptContent:'Update Elena role to Reviewed lead and append Reviewed. to the wiki.',sourceMessageId:id,successfulReadActions:reads});
 const context=compilerContext(captured.messages[0].content);assert.equal(context.grounded_read_facts.facts.length,2);assert.equal(context.grounded_read_facts.facts[0].record.revision,2);assert.equal(context.grounded_read_facts.facts[1].page.content,'Original body.');assert.equal(draft.actions.length,2,JSON.stringify({warnings:draft.warnings,actions:draft.actions.map(a=>a.action)}));
});

test('latest same-record read wins and new-page creation does not require an existing-page fact',()=>{
 const facts=collectCompilerReadFacts([...reads,{...reads[0],result:{record:{...record,revision:3}}}]);assert.equal(facts.facts.filter(f=>f.tool==='module_record_get').length,1);
 assert.equal(validateCompilerGrounding([{action:'module_record_update',params:{record_id:id,expected_revision:3,expected_manifest_digest:digest,patch:{role:'Lead'}}}],facts,'Update role.').actions.length,1);
 const create={action:'wiki_write',params:{requested_wiki_write_mode:'create',slug:'new-page',title:'New page',content:'New body.'}};assert.deepEqual(validateCompilerGrounding([create],{facts:[],limitations:[]},'Create a new page.').actions,[create]);
});
test('compiled full-body append normalizes to one old body and one exact addition',async()=>{
 const {mergeWikiUpdateContent}=await import('../src/workers/handlers/agent-reply.js');
 const full='Original body.\n\nReviewed.';assert.equal(mergeWikiUpdateContent('Original body.',full,'append'),full);
 assert.equal(mergeWikiUpdateContent('Original body.','Reviewed.','append'),full);
});

test('actual authorized wiki_read shape feeds compiler normalization and actual target resolver once',async()=>{
 const {randomUUID}=await import('node:crypto');const {db}=await import('../src/lib/db.js');const schema=await import('@deft/db/schema');
 const org=randomUUID(),user=randomUUID(),page=randomUUID(),slug='read-facts-'+randomUUID();
 await db.insert(schema.orgs).values({id:org,name:'Synthetic compiler facts',slug});await db.insert(schema.users).values({id:user,name:'Synthetic owner',email:slug+'@example.test'});await db.insert(schema.orgMembers).values({org_id:org,user_id:user,role:'owner',is_active:true});
 await db.insert(schema.wikiPages).values({id:page,org_id:org,user_id:user,type:'fact',title:'Reviewed note',slug,content:'Original body.',version:2});
 const {executeToolCall}=await import('../src/lib/agent-context.js');const read=await executeToolCall('wiki_read',{slug},org,user);
 assert.equal(read.result.slug,slug);const facts=collectCompilerReadFacts([{action:'wiki_read',readOnly:true,success:true,result:read.result}]);assert.equal(facts.facts.length,1);
 const {normalizeCompiledToolCalls}=await import('../src/lib/agent-action-proposals.js');
 const full='Original body.\n\nReviewed.';const normalized=normalizeCompiledToolCalls([{name:'wiki_write',input:{slug,title:'Reviewed note',content:full}}],{orgId:org,promptContent:'Append Reviewed. to this existing wiki page.',sourceMessageId:page});
 const grounded=validateCompilerGrounding(normalized.actions,facts,'Append Reviewed.');assert.equal(grounded.actions.length,1);
 const {resolvePendingActionTargets}=await import('../src/workers/handlers/agent-reply.js');const resolved=await resolvePendingActionTargets(org,user,'',grounded.actions,'Append Reviewed.');assert.equal(resolved.actions.length,1);assert.equal(resolved.actions[0].params.content,full);assert.equal(resolved.actions[0].params.slug,slug);
});
