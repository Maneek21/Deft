import assert from 'node:assert/strict';
import test from 'node:test';
import {createNativeEmailRulesApi,NativeEmailRuleError,parseNativeEmailRuleContent,type NativeEmailRuleContent} from './email-native-rules';
const id='11111111-1111-4111-8111-111111111111';
const content:NativeEmailRuleContent={name:'Invoices',match:'all',conditions:[{field:'subject',operator:'contains',value:'invoice'}],exceptions:[],actions:['mark_read','star'],stop_processing:true,execution_location:'deft_service'};
const row={rule_id:id,account_id:'account',revision:1,state:'active',order_index:0,content,created_at:'2026-10-04T00:00:00.000Z',updated_at:'2026-10-04T00:00:00.000Z'};
const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});

test('new rule transmits paused state atomically and preview carries readable bounded labels',async()=>{
 let posted:unknown;const create=createNativeEmailRulesApi({current:()=>true,fetch:async(_path,init)=>{posted=JSON.parse(String(init.body));return response({...row,state:'paused'});}});
 assert.equal((await create.create('account',id,content,'paused')).state,'paused');assert.equal((posted as {state:string}).state,'paused');create.dispose();
 const item={logical_message_id:`mail_${'a'.repeat(64)}`,subject:'Invoice <safe text>',sender:'billing@example.test',matches:[]};
 const page={folder:'inbox',items:[item],next_cursor:null,has_more:false,mailbox_coverage:'partial',sync_state:'idle',scope:'current_cached_page',execution_location:'deft_service'};
 const preview=createNativeEmailRulesApi({current:()=>true,fetch:async()=>response(page)});
 assert.equal((await preview.preview('account',{folder:'inbox',cursor:null,limit:25})).items[0]?.subject,item.subject);preview.dispose();
 for(const bad of [{...item,sender:'x\u0000'},{...item,subject:'x'.repeat(513)},{...item,body:'not allowed'}]){const api=createNativeEmailRulesApi({current:()=>true,fetch:async()=>response({...page,items:[bad]})});await assert.rejects(api.preview('account',{folder:'inbox',cursor:null,limit:25}),NativeEmailRuleError);api.dispose();}
});
test('rule content and page DTOs are closed, bounded, and account scoped',async()=>{
 assert.deepEqual(parseNativeEmailRuleContent(content),content);
 for(const value of [{...content,provider:'gmail'},{...content,actions:['unknown']},{...content,conditions:[]},{...content,name:'\u0000'}])assert.throws(()=>parseNativeEmailRuleContent(value));
 const api=createNativeEmailRulesApi({current:()=>true,fetch:async()=>response({items:[row],next_cursor:null,has_more:false})});
 assert.equal((await api.list('account')).items[0]?.content.name,'Invoices');api.dispose();
 for(const value of [{items:[{...row,account_id:'other'}],next_cursor:null,has_more:false},{items:[{...row,extra:'secret'}],next_cursor:null,has_more:false},{items:[row,row],next_cursor:null,has_more:false}]){
  const invalid=createNativeEmailRulesApi({current:()=>true,fetch:async()=>response(value)});await assert.rejects(invalid.list('account'),NativeEmailRuleError);invalid.dispose();
 }
});
test('reviews and results are closed and only explicit reviewed selection can execute',async()=>{
 const token='opaque-encrypted-review-token',targets=[{logical_message_id:`mail_${'a'.repeat(64)}`,actions:['mark_read','star']}];let calls:{path:string;init:RequestInit}[]=[];
 const api=createNativeEmailRulesApi({current:()=>true,fetch:async(path,init)=>{calls.push({path,init});return init.method==='POST'&&path.endsWith('/review')?response({rule_id:id,rule_revision:1,targets,review_token:token,expires_at:'2026-10-04T00:05:00.000Z',scope:'selected_current_cached_page'}):response({rule_id:id,rule_revision:1,items:targets[0]!.actions.map(action=>({logical_message_id:targets[0]!.logical_message_id,action,state:'applied'}))});}});
 const review=await api.review('account',id,{expected_revision:1,folder:'INBOX',cursor:null,limit:25,logical_message_ids:[targets[0]!.logical_message_id]});
 assert.deepEqual(review.targets,targets);const result=await api.execute('account',review);assert.deepEqual(result.items.map(item=>item.state),['applied','applied']);
 assert.equal(JSON.parse(calls[1]!.init.body as string).review_token,token);assert.equal(calls[1]!.path,'/api/email/accounts/account/rules/execute');api.dispose();
 const invalid=createNativeEmailRulesApi({current:()=>true,fetch:async()=>response({rule_id:id,rule_revision:1,targets,review_token:token,expires_at:'2026-10-04T00:05:00.000Z',scope:'selected_current_cached_page',source_digest:'private'})});
 await assert.rejects(invalid.review('account',id,{expected_revision:1,folder:'INBOX',cursor:null,limit:25,logical_message_ids:[targets[0]!.logical_message_id]}),NativeEmailRuleError);invalid.dispose();
});
test('lost session clears pending rule data and 409 remains a CAS conflict',async()=>{
 let active=true,resolve!:(response:Response)=>void;const held=createNativeEmailRulesApi({current:()=>active,fetch:async()=>new Promise(done=>{resolve=done;})});const pending=held.list('account');active=false;resolve(response({items:[row],next_cursor:null,has_more:false}));await assert.rejects(pending,(error:unknown)=>error instanceof NativeEmailRuleError&&error.kind==='denied');held.dispose();
 const conflict=createNativeEmailRulesApi({current:()=>true,fetch:async()=>response({code:'EMAIL_RULE_CONFLICT'},409)});await assert.rejects(conflict.update('account',row as never,content,'active'),(error:unknown)=>error instanceof NativeEmailRuleError&&error.kind==='conflict');conflict.dispose();
});
