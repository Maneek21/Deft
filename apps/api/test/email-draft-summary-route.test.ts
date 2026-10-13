import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmailDraftRoutes } from '../src/routes/email-drafts.js';

const session={id:'summary-owner',org_id:'summary-org',sid:'summary-session',exp:2_000_000_000};
const summary={draft_id:'00000000-0000-4000-8000-000000000001',account_id:'summary-account',revision:4,content_revision:4,
 status:'draft',subject:'Saved subject',updated_at:'2026-10-04T12:00:00.000Z'};
function fixture(){
 const calls:any[]=[];
 const service={async listSummaries(actor:any,scope:any,cursor:any,limit:any){calls.push({actor,scope,cursor,limit});return {items:[summary],next_cursor:null,has_more:false};}};
 const routes=createEmailDraftRoutes({verify:async token=>token==='valid'?session:Promise.reject(Error('invalid')),
  drafts:async()=>service as any,now:()=>10_000});return {routes,calls};
}
const headers={authorization:'Bearer valid','content-type':'application/json'};

test('metadata-only draft query passes account scope and bounded cursor request to service',async()=>{
 const f=fixture(),response=await f.routes.request('/accounts/summary-account/draft-summaries/query',{method:'POST',headers,body:JSON.stringify({cursor:null,limit:50})});
 assert.equal(response.status,200);const payload=await response.json();assert.deepEqual(payload,{items:[summary],next_cursor:null,has_more:false});
 assert.equal(JSON.stringify(payload).includes('body'),false);
 assert.equal(f.calls[0]?.cursor,null);assert.equal(f.calls[0]?.limit,50);
 assert.deepEqual(f.calls[0]?.scope,{org_id:session.org_id,owner_user_id:session.id,account_id:'summary-account'});
});

test('summary query rejects extra fields, overlarge page limits, unauthenticated requests, and query strings',async()=>{
 const f=fixture();
 for(const body of [{cursor:null,limit:50,owner_user_id:'other'},{cursor:null,limit:51},{limit:20}]){
  const response=await f.routes.request('/accounts/summary-account/draft-summaries/query',{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal(response.status,400);
 }
 assert.equal((await f.routes.request('/accounts/summary-account/draft-summaries/query',{method:'POST',headers,body:'{}'})).status,400);
 assert.equal((await f.routes.request('/accounts/summary-account/draft-summaries/query?account=other',{method:'POST',headers,body:'{"cursor":null,"limit":20}'})).status,400);
 assert.equal((await f.routes.request('/accounts/summary-account/draft-summaries/query',{method:'POST',headers:{...headers,authorization:'Bearer invalid'},body:'{"cursor":null,"limit":20}'})).status,401);
 assert.equal(f.calls.length,0);
});
