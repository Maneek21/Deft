import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {collectCompilerReadFacts,validateCompilerGrounding} from '../src/lib/agent-compiler-read-facts.js';

// The compiler input is untrusted workspace data wrapped in <workspace_context>.
function compilerContext(content:string){const match=/^<workspace_context>\n([\s\S]*)\n<\/workspace_context>$/.exec(content);assert.ok(match,'compiler input must be wrapped as untrusted workspace context');return JSON.parse(match[1]!);}

const id='00000000-0000-4000-8000-000000000011',digest='sha256:'+'b'.repeat(64);
const record={id,resource_id:'module_record:'+id,installation_id:id,module_id:'com.deft.contacts',collection_key:'contacts',manifest_digest:digest,data:{name:'Owen',role:'Technical handoff lead',company:'Northstar Labs',email:'owen@example.test'},relations:[],members:[],revision:2,created_at:'2026-10-19T00:00:00Z',updated_at:'2026-10-19T00:00:00Z',archived_at:null};
const query={action:'module_record_query',readOnly:true,success:true,result:{items:[record],next_cursor:null}};
const wiki={action:'wiki_read',readOnly:true,success:true,result:{slug:'reviewed-publication-note',title:'Reviewed publication note',content:'Original body.',version:1}};

test('ordinary query-only full record facts support two exact governed proposals without inventing a get',async()=>{
 let captured:any;
 mock.module('../src/lib/llm.js',{namedExports:{llm:async(value:any)=>{captured=value;return{text:'',toolCalls:[{name:'module_record_update',input:{idempotency_key:'ordinary-query-record-update',record_id:id,expected_revision:2,expected_manifest_digest:digest,patch:{role:'Technical review owner'}}},{name:'wiki_write',input:{slug:wiki.result.slug,content:'Original body.\n\nReviewed.'}}],model:'deterministic-test',usage:{input:1,output:1}};}}});
 const {compileDeftyActionDraft}=await import('../src/lib/agent-action-proposals.js');
 const draft=await compileDeftyActionDraft({orgId:'00000000-0000-4000-8000-000000000003',promptContent:'Prepare the contact role Technical review owner and append Reviewed. to the existing wiki page for my approval.',sourceMessageId:id,successfulReadActions:[query,wiki]});
 assert.equal(draft.actions.length,2,JSON.stringify({warnings:draft.warnings,actions:draft.actions.map(a=>a.action)}));
 const context=compilerContext(captured.messages[0].content),fact=context.grounded_read_facts.facts.find((f:any)=>f.tool==='module_record_query');
 assert.ok(fact);assert.equal(fact.read_index,0);assert.equal(fact.item_index,0);assert.deepEqual(fact.record,record);
 assert.equal(context.grounded_read_facts.facts.some((f:any)=>f.tool==='module_record_get'),false,'A real query must never be relabeled as a get');
 assert.equal(draft.actions.find(a=>a.action==='module_record_update')?.params.expected_revision,2);
 assert.deepEqual(draft.actions.find(a=>a.action==='module_record_update')?.params.patch,{role:'Technical review owner'});
 const get={action:'module_record_get',readOnly:true,success:true,result:{record}};
 const getFacts=collectCompilerReadFacts([get]);assert.equal(getFacts.facts.length,1);
 assert.equal(validateCompilerGrounding([{action:'module_record_update',params:{record_id:id,expected_revision:2,expected_manifest_digest:digest,patch:{role:'Technical review owner'}}}],getFacts,'Update role.').actions.length,1,'Existing get evidence remains accepted');
 const latest=collectCompilerReadFacts([get,{...query,result:{items:[{...record,revision:3}],next_cursor:null}}]);
 assert.equal(latest.facts.length,1);assert.equal(latest.facts[0].tool,'module_record_query');assert.equal((latest.facts[0]as any).record.revision,3);
 assert.equal(validateCompilerGrounding([{action:'module_record_update',params:{record_id:id,expected_revision:3,expected_manifest_digest:digest,patch:{role:'Technical review owner'}}}],latest,'Update role.').actions.length,1);
 const oversized={...record,data:{name:'x'.repeat(65_537)}};
 const small={...record,id:'00000000-0000-4000-8000-000000000012',resource_id:'module_record:00000000-0000-4000-8000-000000000012'};
 const bounded=collectCompilerReadFacts([{...query,result:{items:[oversized,small],next_cursor:null}}]);
 assert.equal(bounded.facts.length,1);assert.equal((bounded.facts[0]as any).record.id,small.id);assert.equal((bounded.facts[0]as any).item_index,1);assert.match(bounded.limitations[0],/whole fact omitted/);
 const noStaleFallback=collectCompilerReadFacts([get,{...query,result:{items:[oversized],next_cursor:null}}]);assert.equal(noStaleFallback.facts.length,0,'An omitted latest record must not fall back to an older revision');
 const many=Array.from({length:9},(_,i)=>({...record,id:'00000000-0000-4000-8000-'+String(i+20).padStart(12,'0'),resource_id:'module_record:00000000-0000-4000-8000-'+String(i+20).padStart(12,'0')}));
 const capped=collectCompilerReadFacts([{...query,result:{items:many,next_cursor:null}}]);assert.equal(capped.facts.length,8);assert.equal(capped.limitations.length,1);
});
