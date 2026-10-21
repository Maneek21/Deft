import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppIntegrationCapture} from '../src/lib/app-integration-capture.js';
import {appIntegrationSourceDigest} from '../src/lib/app-integration-source.js';
const paragraph='Preserve original requests, validate the recipient, and retain this reusable release procedure.';
function fixture(body:string,excerpt:string,denyFinal=false,externalStep?:(kind:'source'|'model')=>Promise<void>){
 const id='00000000-0000-4000-8000-000000000001',caller={org_id:id,user_id:id,kind:'capture_policy' as const,principal_id:id},target={installation_id:id,account_ref:'synthetic-account',store_key:'drafts',resource_binding_id:id,projection_id:id,ref:{resource_key:'inbox',record_id:id,content_digest:appIntegrationSourceDigest(body)}};
 const snapshot={publication:{observed_at:'2026-10-16T11:00:00Z'}},policy={id,revision:1,history_since:'2026-10-15T00:00:00Z',enabled:true,destination:{scope:'user',space_id:null},history_days:1,include_bulk:false,excluded_senders:[],excluded_folders:[],expected_revision:0};let reads=0,commits=0,failed=0;let saved:any;
 let transactionDepth=0;
 const service=createAppIntegrationCapture<any>({transaction:async(fn:any)=>{transactionDepth++;try{return await fn({});}finally{transactionDepth--;}}
  ,source:{read:async()=>{assert.equal(transactionDepth,0,'Runtime source reads must not retain authority/destination locks');await externalStep?.('source');reads++;return snapshot as any},guard:async()=>{if(denyFinal&&reads>1)throw Error('revoked')}}
  ,policy:async()=>policy as any,destination:async()=>{},evidence:async()=>({eligible:true,body,received_at:'2026-10-16T10:56:46Z',sender:'synthetic@example.test',thread_key:appIntegrationSourceDigest('thread'),body_digest:appIntegrationSourceDigest(body),partial:true,attachments_processed:false})
  ,thread:async()=>null,claim:async()=>id,skipped:async()=>{},reserveBudget:async()=>({})
  ,extract:async()=>{assert.equal(transactionDepth,0,'Model calls must not retain authority/destination locks');await externalStep?.('model');return {capture:true,title:'Synthetic release procedure',type:'procedure',content:'A reusable release procedure supported by this source.',excerpt};}
  ,commit:async(_tx:any,x:any)=>{commits++;saved=x.extracted;return {state:'captured'}},failed:async()=>{failed++}});
 return {run:()=>service.process(caller,target,1),stats:()=>({reads,commits,failed,saved,transactionDepth})};
}
test('a suspended Runtime read or model request retains no Knowledge transaction',{timeout:10_000},async()=>{
 for(const boundary of ['source','model'] as const){
  let suspended!:()=>void,resume!:()=>void;const reached=new Promise<void>(resolve=>{suspended=resolve;}),released=new Promise<void>(resolve=>{resume=resolve;});
  const f=fixture(paragraph,paragraph,false,async kind=>{if(kind===boundary){suspended();await released;}}),work=f.run();
  try{await Promise.race([reached,work.then(()=>{throw Error('Knowledge completed before the suspended boundary');})]);assert.equal(f.stats().transactionDepth,0);assert.equal(f.stats().commits,0);}
  finally{resume();}
  assert.equal((await work).state,'captured');assert.equal(f.stats().transactionDepth,0);
 }
});
test('model whitespace-only quote is grounded to the exact original source span before commit',async()=>{
 const body='Source start.\n'+paragraph.replace(', ', ',\n  ')+'\nSource end.',f=fixture(body,paragraph);assert.equal((await f.run()).state,'captured');const s=f.stats();assert.equal(s.saved.excerpt,paragraph.replace(', ', ',\n  '));assert.ok(body.includes(s.saved.excerpt));assert.equal(s.reads,2);assert.equal(s.failed,0);
});
test('Unicode and CRLF whitespace recover source bytes without changing letters or punctuation',async()=>{
 const original=paragraph.replace(/ /gu,'\u00a0\t').replace(',\u00a0\t',',\r\n'),body='Prefix. '+original+' Suffix.',f=fixture(body,paragraph);await f.run();assert.equal(f.stats().saved.excerpt,original);assert.ok(body.includes(f.stats().saved.excerpt));
});
test('already exact quotes remain unchanged even when the same quote occurs twice',async()=>{
 const f=fixture(paragraph+'\n'+paragraph,paragraph);await f.run();assert.equal(f.stats().saved.excerpt,paragraph);
});
test('ambiguous whitespace-normalized matches are refused rather than choosing a location',async()=>{
 const f=fixture(paragraph.replace(/ /gu,'\n')+'\n'+paragraph.replace(/ /gu,'\t'),paragraph);await assert.rejects(f.run(),/APP_INTEGRATION_CAPTURE_INVALID_EVIDENCE/u);assert.equal(f.stats().commits,0);
});
test('paraphrase, case changes, punctuation changes and absent text still fail without leaking source',async()=>{
 for(const quote of [paragraph.replace('recipient','destination'),paragraph.toUpperCase(),paragraph.replace(',',';'),'An unrelated and unsupported synthetic quotation.']){const f=fixture(paragraph,quote);await assert.rejects(f.run(),error=>{assert.equal((error as Error).message,'APP_INTEGRATION_CAPTURE_INVALID_EVIDENCE');return true});assert.equal(f.stats().commits,0);assert.equal(f.stats().failed,1);}
});
test('recovered original span must remain within20..1200 characters',async()=>{
 const tooLong='A'.repeat(30)+' '.repeat(1200)+'B'.repeat(30),f=fixture(tooLong,'A'.repeat(30)+' '+'B'.repeat(30));await assert.rejects(f.run(),/APP_INTEGRATION_CAPTURE_INVALID_EVIDENCE/u);assert.equal(f.stats().commits,0);
 const short=fixture(paragraph,'Preserve original');await assert.rejects(short.run(),/APP_INTEGRATION_CAPTURE_INVALID_EVIDENCE/u);assert.equal(short.stats().commits,0);
});
test('grounding preserves the final current-authority guard and denies before commit',async()=>{
 const f=fixture(paragraph.replace(/ /gu,'\n'),paragraph,true);await assert.rejects(f.run(),/revoked/u);assert.equal(f.stats().reads,2);assert.equal(f.stats().commits,0);assert.equal(f.stats().failed,1);
});

test('unique spans at source boundaries preserve exact offsets including Unicode code units',async()=>{
 for(const quote of [paragraph,'😀 '+paragraph]){const original=quote.replace(/ /gu,'\u2003\r\n');for(const body of [original,original+' End.', 'Prefix. '+original]){const f=fixture(body,quote);await f.run();assert.equal(f.stats().saved.excerpt,original);assert.ok(body.includes(f.stats().saved.excerpt));}}
});
test('original1200-character limit and existing16000-character source bound remain exact',async()=>{
 const original='A'.repeat(599)+'\r\n'+'B'.repeat(599),quote='A'.repeat(599)+' '+'B'.repeat(599),f=fixture(original,quote);await f.run();assert.equal(f.stats().saved.excerpt.length,1200);assert.equal(f.stats().saved.excerpt,original);
 const body=paragraph+'X'.repeat(16000-paragraph.length),allowed=fixture(body,paragraph);await allowed.run();assert.equal(allowed.stats().commits,1);
 const denied=fixture(body+'X',paragraph);await assert.rejects(denied.run(),/APP_INTEGRATION_CAPTURE_CHANGED_OR_DENIED/u);assert.equal(denied.stats().commits,0);
});
