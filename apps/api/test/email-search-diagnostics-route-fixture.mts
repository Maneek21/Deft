import assert from 'node:assert/strict';
const reports:unknown[]=[];console.info=(value:unknown)=>{reports.push(JSON.parse(String(value)));};
const {createEmailMailboxRoutes}=await import('../src/routes/email-mailbox.js');
const {EmailMailboxSearchError}=await import('../src/lib/email-mailbox-search.js');
const enabled=process.argv[2]==='on';
let calls=0,denial=false;
const result={account_id:'fixture-a',query:'private exact query',source:'provider' as const,coverage:'complete' as const,complete:true,exact_total:null,observed_at:'2026-10-04T12:00:00.000Z',next_cursor:null,provider_result_cap:null,limitations:[],failure_count:0,query_complete:true,unsupported:[],items:[]};
const app=createEmailMailboxRoutes({verify:async token=>{if(token!=='valid')throw Error('private credential');return {id:'private-owner',org_id:'private-org',sid:'private-sid',exp:2000000000};},service:async()=>{throw Error('unused');},now:()=>1000,search:async()=>({search:async(actor,scope,input)=>{calls++;assert.equal(actor.user_id,'private-owner');assert.equal(scope.owner_user_id,'private-owner');assert.equal(input.query,'private exact query');assert.equal(input.cursor,null);if(denial)throw new EmailMailboxSearchError('EMAIL_ACCESS_DENIED');return {...result,account_id:scope.account_id};}})});
const request=(account='fixture-a',body:unknown={query:'private exact query',limit:50,cursor:null},token='valid')=>app.request('/accounts/'+account+'/search',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
assert.equal((await request('fixture-a',undefined,'bad')).status,401);
assert.equal((await request('fixture-a',{query:'private exact query',diagnostics:true})).status,400);assert.equal(reports.length,0);assert.equal(calls,0);
assert.equal((await request('foreign')).status,200);assert.equal(reports.length,0);
for(let i=0;i<3;i++){const response=await request(i===1?'fixture-b':'fixture-a');assert.equal(response.status,200);assert.deepEqual(await response.json(),{...result,account_id:i===1?'fixture-b':'fixture-a'});}
denial=true;const response=await request();assert.equal(response.status,403);assert.deepEqual(await response.json(),{code:'EMAIL_ACCESS_DENIED'});
denial=false;assert.equal((await request()).status,200);assert.equal(calls,6);assert.equal(reports.length,enabled?4:0);
if(enabled){const rows=reports as any[];assert.deepEqual(rows.map(r=>r.outcome),['success','success','success','error']);assert.deepEqual(rows[0].intervals.map((r:any)=>r.phase),['setup','search','json_response']);assert.equal(rows[0].items,0);assert.equal(rows[0].partial,false);const serialized=JSON.stringify(rows);for(const secret of ['fixture-a','fixture-b','foreign','private','EMAIL_ACCESS_DENIED','query','cursor'])assert.equal(serialized.includes(secret),false);}
process.stdout.write(JSON.stringify({mode:enabled?'on':'off',records:reports.length,calls,unauthorized:401,malformed:400,denied:403})+'\n');
