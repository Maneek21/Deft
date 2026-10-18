import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {createAppIntegrationDestination} from '../src/lib/app-integration-destination.js';
const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(){
 let now=1000,inTx=false,writes=0,after=0,version=1,changed=false,expireOnCreate=false;
 let receipts=new Map<string,any>();
 const caller={org_id:uuid(1),user_id:uuid(2),kind:'human' as const,principal_id:uuid(3)};
 const source={installation_id:uuid(4),account_ref:'account_one',store_key:'inbox',ref:{resource_key:'message',record_id:uuid(5),content_digest:'sha256:'+'a'.repeat(64)}};
 const snapshot=()=>({caller,purpose:'transfer',publication:{target:{...source,resource_binding_id:uuid(6),projection_id:uuid(7)},checkpoint_id:uuid(8),generation:1,cursor_sequence:1,projection_revision:'r1',applied_sequence:1,payload_digest:'sha256:'+'b'.repeat(64),observed_at:'2026-10-11T00:00:00Z',partial:true},authority:{identity:'grant1',expires_at:2000},resource:{record_id:source.ref.record_id,content_digest:changed?'sha256:'+'c'.repeat(64):source.ref.content_digest},presentation:{plain_text:'Observed source body'}});
 const service=createAppIntegrationDestination<any>({clock:()=>now,transaction:async fn=>{assert.equal(inTx,false);inTx=true;const old=new Map(receipts),oldWrites=writes;try{return await fn({});}catch(e){receipts=old;writes=oldWrites;throw e;}finally{inTx=false;}},source:{resolve:async()=>{assert.equal(inTx,false);return snapshot().publication.target;},read:async()=>{assert.equal(inTx,false);return snapshot() as any;},guard:async()=>{}},audience:async()=>({identity:{version},visibility:'private',label:'Only you',member_count:1}),receipt:async(_tx,c,id)=>receipts.get(c.user_id+id)??null,reserve:async(_tx,c,input)=>{const key=c.user_id+input.request_id;if(receipts.has(key))return false;receipts.set(key,{...input});return true;},create:async()=>{writes++;if(expireOnCreate)now=2001;return {destination_kind:'note',destination_id:uuid(9),destination_url:'/notes/'+uuid(9),replayed:false};},visibleResult:async()=>{},complete:async(_tx,c,id,result)=>{receipts.set(c.user_id+id,{...receipts.get(c.user_id+id),result});},afterCommit:async()=>{assert.equal(inTx,false);after++;}});
 const input={source,destination:{kind:'note',visibility:'private',space_id:null},title:'Reviewed note',mode:'excerpt',excerpt:'Observed source'};
 return {service,caller,input,get writes(){return writes},get after(){return after},changeSource:()=>{changed=true},changeAudience:()=>{version++},expire:()=>{expireOnCreate=true}};
}
test('exact review, original UUID replay and lost ACK status create once',async()=>{const f=fixture(),r=await f.service.review(f.caller,f.input);const input={...f.input,request_id:uuid(10),review_digest:r.review_digest};await f.service.commit(f.caller,input);assert.equal((await f.service.commit(f.caller,input)).replayed,true);assert.equal((await f.service.status(f.caller,uuid(10))).replayed,true);assert.equal(f.writes,1);assert.equal(f.after,1);await assert.rejects(f.service.commit(f.caller,{...input,title:'Changed'}),/CONFLICT/);});
test('source digest or audience changed after review denies native creation',async()=>{for(const kind of ['source','audience']){const f=fixture(),r=await f.service.review(f.caller,f.input);kind==='source'?f.changeSource():f.changeAudience();await assert.rejects(f.service.commit(f.caller,{...f.input,request_id:uuid(10),review_digest:r.review_digest}),/CHANGED_OR_DENIED/);assert.equal(f.writes,0);assert.equal(f.after,0);}});
test('expiry at final guard rolls native write and reserved UUID back',async()=>{const f=fixture(),r=await f.service.review(f.caller,f.input);f.expire();await assert.rejects(f.service.commit(f.caller,{...f.input,request_id:uuid(10),review_digest:r.review_digest}),/CHANGED_OR_DENIED/);assert.equal(f.writes,0);assert.equal(f.after,0);});
test('unobserved excerpt, capture policy and foreign receipt owner denied',async()=>{const f=fixture();await assert.rejects(f.service.review(f.caller,{...f.input,excerpt:'Invented'}));await assert.rejects(f.service.review({...f.caller,kind:'capture_policy'},f.input));const r=await f.service.review(f.caller,f.input);await f.service.commit(f.caller,{...f.input,request_id:uuid(10),review_digest:r.review_digest});await assert.rejects(f.service.status({...f.caller,user_id:uuid(20)},uuid(10)));});



test('checked status retains public result, current transfer source and foreign-owner denial',async()=>{
 const f=fixture(),r=await f.service.review(f.caller,f.input);await f.service.commit(f.caller,{...f.input,request_id:uuid(10),review_digest:r.review_digest});const checked=await f.service.statusWithSource(f.caller,uuid(10));assert.equal(checked.snapshot.purpose,'transfer');assert.deepEqual(checked.snapshot.caller,f.caller);assert.deepEqual(checked.result,await f.service.status(f.caller,uuid(10)));await assert.rejects(f.service.statusWithSource({...f.caller,user_id:uuid(20)},uuid(10)));assert.equal(f.writes,1);
});

test('Task details are bounded, task-only and included in review and original-request identity',async()=>{
 const f=fixture(),input={...f.input,destination:{kind:'task',project_id:uuid(40)},title:'Follow up',task_details:{description:'Discuss the proposal',status:'todo',priority:'p1',assignee_id:uuid(2),due_date:'2026-10-20'}};
 const reviewed=await f.service.review(f.caller,input);
 await assert.rejects(f.service.commit(f.caller,{...input,task_details:{...input.task_details,assignee_id:uuid(41)},request_id:uuid(42),review_digest:reviewed.review_digest}),/CHANGED_OR_DENIED/);
 assert.equal(f.writes,0);await f.service.commit(f.caller,{...input,request_id:uuid(42),review_digest:reviewed.review_digest});assert.equal(f.writes,1);
 for(const bad of [{...input,task_details:{due_date:'2026-02-30'}},{...input,task_details:{priority:'p9'}},{...input,task_details:{description:'x'.repeat(20001)}},{...input,task_details:{assignee_id:'foreign'}},{...f.input,task_details:input.task_details}])await assert.rejects(f.service.review(f.caller,bad));
});

test('actual Task adapter checks current assignee membership and forwards reviewed details to native constructor',async()=>{
 const source=readFileSync(new URL('../src/lib/app-integration-task.ts',import.meta.url),'utf8'),start=source.indexOf('export const appIntegrationTaskAdapter'),end=source.indexOf('export async function afterAppIntegrationTaskCommit');
 const nativeSource=readFileSync(new URL('../src/lib/native-task-create.ts',import.meta.url),'utf8'),nativeBody=stripTypeScriptTypes(nativeSource.slice(nativeSource.indexOf('export async function createNativeTask')).replace('export async function','async function'),{mode:'transform'});
 const createNative=new Function('reserveNextTaskNumber','tasks','taskActivity',nativeBody+';return createNativeTask;')(async()=>7,'tasks','activity');
 const adapter=new Function('and','eq','orgMembers','projects','createNativeTask',stripTypeScriptTypes(source.slice(start,end).replace('export const','const'),{mode:'transform'})+';return appIntegrationTaskAdapter;')((...v:unknown[])=>v,(...v:unknown[])=>v,{}, {},createNative);
 const pgSource=readFileSync(new URL('../src/lib/app-integration-destination-postgres.ts',import.meta.url),'utf8'),pgBody=stripTypeScriptTypes(pgSource.slice(pgSource.indexOf('export function appIntegrationDestinationPostgres')).replace('export function','function'),{mode:'transform'});
 const postgres=new Function('deny',pgBody+';return appIntegrationDestinationPostgres;')(()=>Error('denied'))({task:adapter});
 const caller={org_id:uuid(1),user_id:uuid(2)},details={description:'Review proposal',status:'todo',priority:'p1',assignee_id:uuid(50),due_date:'2026-10-20'},destination={kind:'task',project_id:uuid(40)};let member=true,created:any;
 const tx={select:()=>({from:(table:unknown)=>({where:()=>({for:async()=>table===undefined?[]:[]})})}),insert:(table:string)=>({values:(value:any)=>{if(table==='tasks')created=value;return {returning:async()=>[{id:uuid(70),...value}]};}})};
 const audienceTx=()=>{let calls=0;return {select:()=>({from:()=>({where:()=>({for:async()=>++calls===1?[{id:uuid(40),name:'Project'}]:[{id:uuid(51),user_id:caller.user_id},...(member?[{id:uuid(52),user_id:details.assignee_id}]:[])]})})})};};
 await postgres.audience(audienceTx(),caller,destination,details);member=false;await assert.rejects(postgres.audience(audienceTx(),caller,destination,details),/CHANGED_OR_DENIED/);member=true;
 await postgres.create(tx,caller,{destination,title:'Follow up',mode:'source_link',task_details:details},{publication:{observed_at:'2026-10-16T00:00:00Z',partial:true}},uuid(60));
 assert.equal(created.assignee_id,details.assignee_id);assert.equal(created.status,'todo');assert.equal(created.priority,'p1');assert.equal(created.due_date.toISOString(),'2026-10-20T00:00:00.000Z');assert.match(created.description,/Review proposal/);assert.ok(created.description.includes('/apps/source/transfer/'+uuid(60)));assert.equal(created.source_message_id,undefined);assert.equal(created.org_id,caller.org_id);
});
