import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeDraftSummaryApi,mergeNativeDraftSummaries,type NativeDraftSummary} from './email-native-draft-summaries';
import {NativeDraftError} from './email-native-drafts';

const accountA='account-a',accountB='account-b',draftA='00000000-0000-4000-8000-000000000001',draftB='00000000-0000-4000-8000-000000000002';
const summary=(account_id:string,draft_id:string,updated_at='2026-10-04T12:00:00.000Z',revision=1):NativeDraftSummary=>({draft_id,account_id,revision,content_revision:revision,status:'draft',subject:'Subject',updated_at});
const page=(items:NativeDraftSummary[],next_cursor:string|null=null)=>({items,next_cursor,has_more:next_cursor!==null});

test('summary API scopes paths, follows opaque continuation, and bounds each response',async()=>{
 const calls:Array<{path:string;body:unknown}> = [],api=createNativeDraftSummaryApi(async(path,options)=>{
  calls.push({path,body:JSON.parse(String(options.body))});return Response.json(calls.length===1?page([summary(accountA,draftA)],'opaque-cursor'):page([summary(accountA,draftB)]));
 },()=>true);
 const first=await api.query(accountA),second=await api.query(accountA,first.next_cursor,50);
 assert.deepEqual(calls.map(call=>call.path),[`/api/email/accounts/${accountA}/draft-summaries/query`,`/api/email/accounts/${accountA}/draft-summaries/query`]);
 assert.deepEqual(calls.map(call=>call.body),[{cursor:null,limit:50},{cursor:'opaque-cursor',limit:50}]);assert.equal(first.has_more,true);assert.equal(second.items[0]?.draft_id,draftB);
 assert.deepEqual(Object.keys(second.items[0]!).sort(),['account_id','content_revision','draft_id','revision','status','subject','updated_at']);api.dispose();
});

test('lost session discards held response and foreign-account rows are rejected',async()=>{
 let current=true,release:(response:Response)=>void=()=>{};
 const held=createNativeDraftSummaryApi(async()=>new Promise<Response>(resolve=>{release=resolve;}),()=>current),request=held.query(accountA);current=false;release(Response.json(page([summary(accountA,draftA)])));
 await assert.rejects(request,error=>error instanceof NativeDraftError&&error.kind==='denied');held.dispose();
 const foreign=createNativeDraftSummaryApi(async()=>Response.json(page([summary(accountB,draftA)])),()=>true);
 await assert.rejects(foreign.query(accountA),error=>error instanceof NativeDraftError&&error.kind==='unavailable');foreign.dispose();
});

test('merged pages suppress duplicate IDs and order ties deterministically across accounts',()=>{
 const old=summary(accountA,draftA,'2026-10-04T11:00:00.000Z'),newer=summary(accountA,draftA,'2026-10-04T12:00:00.000Z',2),other=summary(accountB,draftB);
 assert.deepEqual(mergeNativeDraftSummaries([old,other],[newer]),[newer,other]);
});

test('malformed or oversized summaries are rejected instead of partially displayed',async()=>{
 const malformed=createNativeDraftSummaryApi(async()=>Response.json({items:[{...summary(accountA,draftA),body:'private'}],next_cursor:null,has_more:false}),()=>true);
 await assert.rejects(malformed.query(accountA),error=>error instanceof NativeDraftError&&error.kind==='unavailable');malformed.dispose();
 const oversized=createNativeDraftSummaryApi(async()=>new Response(' '.repeat(128*1024+1)),()=>true);
 await assert.rejects(oversized.query(accountA),error=>error instanceof NativeDraftError&&error.kind==='unavailable');oversized.dispose();
});
