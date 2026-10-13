import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createEmailConnectedClient,parseEmailKnowledgeSettings,parseEmailRelatedKnowledge,parseEmailAgentAccess,toggleEmailAgentOperation,EmailConnectedError} from './email-native-connected';

const setting={account_id:'account-a',enabled:true,destination:{scope:'user',space_id:null},history_days:30,include_bulk:false,excluded_senders:[],excluded_folders:[],revision:1,progress:{processed:4,captured:2,skipped:2,last_error_code:null}};
test('grant choices preserve read and saved-draft dependencies for send and triage',()=>{
  assert.deepEqual(toggleEmailAgentOperation([],'send',true),['read','draft','send']);
  assert.deepEqual(toggleEmailAgentOperation([],'triage',true),['read','triage']);
  assert.deepEqual(toggleEmailAgentOperation(['read','draft','triage','send'],'draft',false),['read','triage']);
  assert.deepEqual(toggleEmailAgentOperation(['read','draft','triage','send'],'read',false),[]);
});
test('knowledge settings preserve explicit personal visibility and reject inconsistent space destinations',()=>{
  assert.deepEqual(parseEmailKnowledgeSettings(setting).destination,{scope:'user',space_id:null});
  assert.throws(()=>parseEmailKnowledgeSettings({...setting,destination:{scope:'space',space_id:null}}));
  assert.throws(()=>parseEmailKnowledgeSettings({...setting,history_days:0}));
});
test('related Knowledge validates canonical local links and strips opaque source content',()=>{
  const item={id:'capture',page_id:'page',title:'Decision',url:'/knowledge?slug=decision',status:'captured',source_ref:{body:'mail content'}};
  assert.equal(parseEmailRelatedKnowledge({items:[item],suppressed:false}).items[0].url,item.url);
  assert.ok(!('source_ref' in parseEmailRelatedKnowledge({items:[item],suppressed:false}).items[0]));
  assert.equal(parseEmailRelatedKnowledge({items:[item,{...item,id:'second-source'}],suppressed:false}).items.length,1);
  for(const url of ['https://external.invalid/knowledge?slug=decision','//external.invalid/knowledge?slug=decision','/knowledge?slug=decision&other=1','/knowledge/decision','javascript:alert(1)'])assert.throws(()=>parseEmailRelatedKnowledge({items:[{...item,url}],suppressed:false}));
});
test('account access requires an explicit owned principal and supported operation vocabulary',()=>{
  const grants={defty_principal_id:'owner',grants:[{id:'grant',principal_kind:'defty',principal_id:'owner',operations:['read'],revision:1,revoked_at:null}],personal_tokens:[]};
  assert.equal(parseEmailAgentAccess(grants).grants[0].operations[0],'read');
  assert.throws(()=>parseEmailAgentAccess({...grants,defty_principal_id:null}));
  assert.throws(()=>parseEmailAgentAccess({...grants,grants:[{...grants.grants[0],operations:['delete_account']}]}));
});
test('settings write uses current revision once and requires reload after an unknown response at UI boundary',async()=>{
  const requests:{path:string;init:RequestInit}[]=[];
  const client=createEmailConnectedClient({accountId:'account-a',current:()=>true,fetch:async(path,init)=>{requests.push({path,init});return Response.json(setting);}});
  await client.request('/knowledge-settings',parseEmailKnowledgeSettings,{enabled:true,expected_revision:1});
  assert.equal(requests.length,1);assert.equal(requests[0].path,'/api/email/accounts/account-a/knowledge-settings');assert.equal(requests[0].init.method,'PUT');assert.equal(JSON.parse(String(requests[0].init.body)).expected_revision,1);
  client.dispose();await assert.rejects(()=>client.request('/knowledge-settings',parseEmailKnowledgeSettings),{kind:'denied'});assert.equal(requests.length,1);
});
test('late account/session responses cannot return private data or trigger follow-up writes',async()=>{
  let current=true,release!:(response:Response)=>void,calls=0;
  const client=createEmailConnectedClient({accountId:'account-a',current:()=>current,fetch:async()=>{calls++;return new Promise<Response>(resolve=>{release=resolve;});}});
  const pending=client.request('/knowledge-settings',parseEmailKnowledgeSettings);current=false;release(Response.json(setting));
  await assert.rejects(()=>pending,(error:unknown)=>error instanceof EmailConnectedError&&error.kind==='denied');
  await assert.rejects(()=>client.request('/knowledge-settings',parseEmailKnowledgeSettings,{enabled:true}));assert.equal(calls,1);
});
test('wrong-account, oversized and denied responses cannot become saved UI settings',async()=>{
  for(const response of [Response.json({...setting,account_id:'account-b'}),new Response('x'.repeat(128*1024+1)),new Response('',{status:403})]){
    const client=createEmailConnectedClient({accountId:'account-a',current:()=>true,fetch:async()=>response});
    await assert.rejects(()=>client.request('/knowledge-settings',parseEmailKnowledgeSettings));client.dispose();
  }
});
