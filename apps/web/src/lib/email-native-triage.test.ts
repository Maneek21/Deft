import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeEmailTriage,groupNativeTriageTargets,parseNativeTriageResult,type NativeTriageState,type NativeTriageResult,type NativeTriageTarget,type NativeTriageSelection,type NativeTriageFolderAcknowledgement} from './email-native-triage';
const logical=(index=1)=>'mail_'+index.toString(16).padStart(64,'0');
const op=(index=1)=>'00000000-0000-4000-8000-'+index.toString().padStart(12,'0');
const result=(account:string,operationId:string,ids=[logical()],operation='archive',states:NativeTriageResult['items'][number]['state'][]=['succeeded'])=>({schema_version:'deft.email_native_triage_result.v1',account_id:account,operation_id:operationId,operation,items:ids.map((id,index)=>({logical_message_id:id,state:states[index]??'succeeded',undo_supported:(states[index]??'succeeded')==='succeeded'})),undo_available:states.includes('succeeded'),automatic_retry:false});
function fixture(fetch:(path:string,options:RequestInit)=>Promise<Response>){const calls:Array<{path:string;options:RequestInit}>=[],states:NativeTriageState[]=[],denied:string[]=[],success:string[][]=[],targets:NativeTriageTarget[][]=[],acknowledgements:NativeTriageFolderAcknowledgement[][]=[];let current=true,index=0;
 const controller=createNativeEmailTriage({fetch:async(path,options)=>{calls.push({path,options});return fetch(path,options);},current:()=>current,change:state=>states.push(state),denied:id=>denied.push(id),succeeded:(ids,exact,folders)=>{success.push(ids);targets.push(exact);acknowledgements.push(folders);},uuid:()=>op(++index)});return {controller,calls,states,denied,success,targets,acknowledgements,end:()=>{current=false;}};}

test('M38 fresh apply and Undo publish exact operation-owned full folders once; status cannot publish retained proof',async()=>{
 const f=fixture(async(path,init)=>{const undo=path.endsWith('/undo'),body=JSON.parse(String(init.body)),operationId=undo?body.undo_operation_id:body.operation_id;
  return Response.json({...result('a',operationId,[logical()],'trash'),items:[{logical_message_id:logical(),state:'succeeded',undo_supported:!undo,confirmed_folders:undo?['inbox','label:'+'a'.repeat(64)]:['trash']}],undo_available:!undo});});
 await f.controller.apply('trash',[{account_id:'a',logical_message_id:logical()}]);assert.deepEqual(f.acknowledgements,[[{account_id:'a',logical_message_id:logical(),operation_id:op(),folders:['trash']}]]);
 await f.controller.check();assert.equal(f.calls.length,1);await f.controller.undo();assert.deepEqual(f.acknowledgements[1],[{account_id:'a',logical_message_id:logical(),operation_id:op(2),folders:['inbox','label:'+'a'.repeat(64)]}]);f.controller.dispose();
 const retained=fixture(async(_path,init)=>{if(init.method==='POST')throw Error('lost');return Response.json({...result('a',op(),[logical()],'trash'),items:[{logical_message_id:logical(),state:'succeeded',undo_supported:true,confirmed_folders:['trash']}]});});
 await retained.controller.apply('trash',[{account_id:'a',logical_message_id:logical()}]);await retained.controller.check();assert.deepEqual(retained.acknowledgements,[[]]);assert.equal(retained.controller.snapshot().groups[0].result!.items[0].confirmed_folders,undefined);assert.equal(retained.calls[1].options.method,'GET');retained.controller.dispose();
});

test('M38 folders require a complete bounded canonical unique set on succeeded items only',()=>{
 const expected={accountId:'a',operationId:op(),kind:'trash' as const,ids:[logical()]};
 for(const invalid of [[],['trash','trash'],['TRASH'],['private-provider-label'],['label:'+'a'.repeat(63)],Array.from({length:101},(_,i)=>'label:'+i.toString(16).padStart(64,'0'))])assert.throws(()=>parseNativeTriageResult({...result('a',op(),[logical()],'trash'),items:[{logical_message_id:logical(),state:'succeeded',undo_supported:true,confirmed_folders:invalid}]},expected));
 for(const state of ['unknown','prepared','failed'])assert.throws(()=>parseNativeTriageResult({...result('a',op(),[logical()],'trash'),undo_available:false,items:[{logical_message_id:logical(),state,undo_supported:false,confirmed_folders:['trash']}]},expected));
 const raw={...result('a',op(),[logical()],'trash'),items:[{logical_message_id:logical(),state:'succeeded',undo_supported:true,confirmed_folders:['trash','label:'+'f'.repeat(64)]}]};const parsed=parseNativeTriageResult(raw,expected);raw.items[0].confirmed_folders.reverse();assert.deepEqual(parsed.items[0].confirmed_folders,['trash','label:'+'f'.repeat(64)]);
});

test('M38 maximum accepted 25-item folder receipt fits 256KiB; counted over-limit response cancels without success',async()=>{
 const ids=Array.from({length:25},(_,i)=>logical(i+1)),full=Array.from({length:100},(_,i)=>'label:'+i.toString(16).padStart(64,'0'));
 const account='"'.repeat(256),raw={...result(account,op(),ids,'mark_unread'),items:ids.map(id=>({logical_message_id:id,state:'succeeded',code:'X'.repeat(100),undo_supported:false,confirmed_folders:full})),undo_available:false};
 const size=new TextEncoder().encode(JSON.stringify(raw)).byteLength;assert.ok(size>16384&&size<256*1024,`maximum accepted shape is ${size} bytes`);
 const f=fixture(async()=>Response.json(raw));await f.controller.apply('mark_unread',ids.map(id=>({account_id:account,logical_message_id:id})));assert.equal(f.controller.snapshot().summary,'25 updated');assert.equal(f.acknowledgements[0].length,25);assert.deepEqual(f.acknowledgements[0][24].folders,full);f.controller.dispose();
 let cancelled=false;const huge=fixture(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(256*1024+1));},cancel(){cancelled=true;}})));await huge.controller.apply('trash',[{account_id:'a',logical_message_id:logical()}]);assert.equal(cancelled,true);assert.equal(huge.controller.snapshot().summary,'1 unconfirmed');assert.deepEqual(huge.acknowledgements,[]);huge.controller.dispose();
});

test('M38 denial, malformed partial, and late cancelled folders never create a scope projection',async()=>{
 const proof={...result('a',op(),[logical()],'trash'),items:[{logical_message_id:logical(),state:'succeeded',undo_supported:true,confirmed_folders:['trash']}]};
 let release!:(response:Response)=>void;const held=fixture(async()=>new Promise(resolve=>{release=resolve;})),pending=held.controller.apply('trash',[{account_id:'a',logical_message_id:logical()}]);held.end();held.controller.dispose();release(Response.json(proof));await pending;assert.deepEqual(held.acknowledgements,[]);
 const denial=fixture(async()=>Response.json(proof,{status:403}));await denial.controller.apply('trash',[{account_id:'a',logical_message_id:logical()}]);assert.deepEqual(denial.acknowledgements,[]);assert.deepEqual(denial.denied,['a']);denial.controller.dispose();
 const partial=fixture(async()=>Response.json({...result('a',op(),[logical(),logical(2)],'trash',['succeeded','unknown']),items:[proof.items[0],{logical_message_id:logical(2),state:'unknown',undo_supported:false}]}));await partial.controller.apply('trash',[{account_id:'a',logical_message_id:logical()},{account_id:'a',logical_message_id:logical(2)}]);assert.equal(partial.acknowledgements[0].length,1);assert.deepEqual(partial.acknowledgements[0][0].folders,['trash']);assert.equal(partial.controller.snapshot().summary,'1 updated · 1 unconfirmed');partial.controller.dispose();
});

test('M23 recovery kinds use existing per-account bulk groups without a destination nomination',async()=>{
 for(const kind of ['spam','not_spam','restore'] as const){const f=fixture(async(path,options)=>{const body=JSON.parse(String(options.body));return Response.json(result(path.split('/').at(-2)!,body.operation_id,body.logical_message_ids,body.kind));}),targets=[...Array.from({length:26},(_,i)=>({account_id:'a',logical_message_id:logical(i+1)})),{account_id:'b',logical_message_id:logical(27)}];
  await f.controller.apply(kind,targets);assert.equal(f.calls.length,3);for(const call of f.calls){const body=JSON.parse(String(call.options.body));assert.equal(body.kind,kind);assert.deepEqual(Object.keys(body).sort(),['kind','logical_message_ids','operation_id']);assert.ok(body.logical_message_ids.length<=25);}assert.equal(f.controller.snapshot().summary,'27 updated');assert.deepEqual(f.success,[['a','b']]);f.controller.dispose();
 }
});
test('M23 recovery unknown response is status-only; conditional Undo keeps exact recovery kind',async()=>{
 for(const kind of ['spam','not_spam','restore'] as const){let applied=false;
  const f=fixture(async(path,options)=>{if(options.method==='POST'&&!path.endsWith('/undo')){applied=true;throw Error('lost');}const operationId=path.endsWith('/undo')?JSON.parse(String(options.body)).undo_operation_id:path.split('/').at(-1)!;return Response.json(result('a',operationId,[logical()],kind));});
  await f.controller.apply(kind,[{account_id:'a',logical_message_id:logical()}]);assert.ok(applied);assert.equal(f.controller.snapshot().summary,'1 unconfirmed');await assert.rejects(f.controller.apply(kind,[{account_id:'a',logical_message_id:logical()}]));await f.controller.undo();assert.equal(f.calls.length,1);
  await f.controller.check();assert.equal(f.calls[1].options.method,'GET');assert.equal(f.calls[1].options.body,undefined);assert.equal(f.controller.snapshot().groups[0].kind,kind);await f.controller.undo();assert.equal(f.calls[2].path,`/api/email/accounts/a/operations/${op()}/undo`);assert.equal(f.controller.snapshot().groups[0].kind,kind);assert.deepEqual(JSON.parse(String(f.calls[2].options.body)),{undo_operation_id:op(2)});f.controller.dispose();
 }
});
test('M23 unsupported operation fails without access purge; held scope and denial never replay recovery',async()=>{
 const unsupported=fixture(async()=>Response.json({code:'EMAIL_TRIAGE_OPERATION_UNSUPPORTED'},{status:400}));await unsupported.controller.apply('spam',[{account_id:'a',logical_message_id:logical()}]);assert.equal(unsupported.controller.snapshot().summary,'1 not updated');assert.deepEqual(unsupported.denied,[]);await unsupported.controller.check();await unsupported.controller.undo();assert.equal(unsupported.calls.length,1);unsupported.controller.dispose();
 for(const kind of ['spam','not_spam','restore'] as const){
  assert.throws(()=>groupNativeTriageTargets([{account_id:'a',logical_message_id:logical()}],kind,{accountId:'a',token:'sealed'}));
  let release!:(response:Response)=>void;const held=fixture(async()=>new Promise(resolve=>{release=resolve;})),pending=held.controller.apply(kind,[{account_id:'a',logical_message_id:logical()}]);held.end();release(Response.json(result('a',op(),[logical()],kind)));await pending;assert.deepEqual(held.success,[]);assert.equal(held.states.length,1);held.controller.dispose();
  const denied=fixture(async(path,options)=>path.includes('/a/')?new Response(null,{status:403}):Response.json(result('b',JSON.parse(String(options.body)).operation_id,[logical(27)],kind)));
  await denied.controller.apply(kind,[...Array.from({length:26},(_,i)=>({account_id:'a',logical_message_id:logical(i+1)})),{account_id:'b',logical_message_id:logical(27)}]);assert.equal(denied.calls.length,2);assert.deepEqual(denied.denied,['a']);assert.deepEqual(denied.success,[['b']]);denied.controller.dispose();
 }
});
test('bulk targets split per account and at 25 messages; Move rejects mixed accounts and caller destination nominations',()=>{
 const targets=[...Array.from({length:53},(_,index)=>({account_id:'a',logical_message_id:logical(index+1)})),{account_id:'b',logical_message_id:logical()}];
 assert.deepEqual(groupNativeTriageTargets(targets,'archive').map(group=>[group.accountId,group.ids.length]),[['a',25],['a',25],['a',3],['b',1]]);
 assert.throws(()=>groupNativeTriageTargets(targets,'move',{accountId:'a',token:'sealed_token'}));assert.throws(()=>groupNativeTriageTargets(targets.slice(0,1),'move',{accountId:'b',token:'sealed_token'}));assert.throws(()=>groupNativeTriageTargets(targets.slice(0,1),'archive',{accountId:'a',token:'sealed_token'}));
 assert.throws(()=>groupNativeTriageTargets([targets[0],targets[0]],'star'));assert.throws(()=>groupNativeTriageTargets(Array.from({length:101},(_,index)=>({account_id:'a',logical_message_id:logical(index)})),'trash'));
});
test('verified bulk success has exact scoped request groups and requests one retained-reader refresh',async()=>{
 const f=fixture(async(path,options)=>{const body=JSON.parse(options.body as string);return Response.json(result(decodeURIComponent(path.split('/').at(-2)!),body.operation_id,body.logical_message_ids,body.kind));});
 await f.controller.apply('mark_read',[{account_id:'account/one',logical_message_id:logical()},{account_id:'b',logical_message_id:logical()}]);assert.equal(f.calls.length,2);
 assert.deepEqual(JSON.parse(f.calls[0].options.body as string),{operation_id:op(),kind:'mark_read',logical_message_ids:[logical()]});assert.equal(f.calls[0].path,'/api/email/accounts/account%2Fone/operations');assert.deepEqual(f.success,[['account/one','b']]);
 assert.equal(f.states.at(-1)?.summary,'2 updated');await f.controller.check();assert.equal(f.calls.length,2);assert.equal(f.success.length,1);f.controller.dispose();
 assert.deepEqual(f.targets,[[{account_id:'account/one',logical_message_id:logical()},{account_id:'b',logical_message_id:logical()}]]);
});
test('lost mutation response queries the same operation status only and blocks mutation replay',async()=>{
 const f=fixture(async(path,options)=>{if(options.method==='POST')throw Error('response lost');return Response.json(result('a',path.split('/').at(-1)!));});
 await f.controller.apply('archive',[{account_id:'a',logical_message_id:logical()}]);assert.equal(f.calls.length,1);assert.equal(f.states.at(-1)?.summary,'1 unconfirmed');
 await assert.rejects(f.controller.apply('archive',[{account_id:'a',logical_message_id:logical()}]));await f.controller.undo();assert.equal(f.calls.length,1);
 await f.controller.check();assert.equal(f.calls.length,2);assert.equal(f.calls[1].options.method,'GET');assert.equal(f.calls[1].path,`/api/email/accounts/a/operations/${op()}`);assert.equal(f.calls[1].options.body,undefined);assert.equal(f.states.at(-1)?.summary,'1 updated');f.controller.dispose();
});
test('partial results retain failed/unknown outcomes and new verified status success refreshes only once',async()=>{
 const ids=[logical(1),logical(2),logical(3)];let checks=0;const f=fixture(async(_path,options)=>{if(options.method==='GET')checks++;return Response.json(result('a',op(),ids,'archive',checks?['succeeded','succeeded','failed']:['succeeded','unknown','failed']));});
 await f.controller.apply('archive',ids.map(id=>({account_id:'a',logical_message_id:id})));assert.equal(f.states.at(-1)?.summary,'1 updated · 1 not updated · 1 unconfirmed');assert.equal(f.success.length,1);
 await f.controller.check();assert.equal(f.states.at(-1)?.summary,'2 updated · 1 not updated');assert.equal(f.success.length,2);await f.controller.check();assert.equal(f.calls.length,2);assert.equal(f.success.length,2);f.controller.dispose();
 assert.deepEqual(f.targets,[[{account_id:'a',logical_message_id:ids[0]}],[{account_id:'a',logical_message_id:ids[1]}]]);
});
test('Undo uses a new UUID for only known reversible successes, then lost undo response is status-only',async()=>{
 let undo=false;const f=fixture(async(path,_options)=>{if(path.endsWith('/undo')){undo=true;throw Error('undo response lost');}return Response.json({...result('a',undo?op(2):op(),[logical()]),undo_available:!undo,items:[{logical_message_id:logical(),state:'succeeded',undo_supported:!undo}]});});
 await f.controller.apply('archive',[{account_id:'a',logical_message_id:logical()}]);await f.controller.undo();assert.equal(f.calls[1].path,`/api/email/accounts/a/operations/${op()}/undo`);assert.deepEqual(JSON.parse(f.calls[1].options.body as string),{undo_operation_id:op(2)});
 await f.controller.check();assert.equal(f.calls[2].path,`/api/email/accounts/a/operations/${op(2)}`);assert.equal(f.calls[2].options.method,'GET');assert.equal(f.controller.snapshot().groups[0].result?.undo_available,false);f.controller.dispose();
 assert.deepEqual(f.targets,[[{account_id:'a',logical_message_id:logical()}],[{account_id:'a',logical_message_id:logical()}]]);
});
test('foreign account/operation/messages and private result fields fail closed without fresh/success claims',async()=>{
 const expected={accountId:'a',operationId:op(),kind:'archive' as const,ids:[logical()]};for(const raw of [{...result('foreign',op())},{...result('a',op(2))},{...result('a',op()),provider_locator:'private'},{...result('a',op(),[logical(2)])},{...result('a',op()),automatic_retry:true}])assert.throws(()=>parseNativeTriageResult(raw,expected));
 const f=fixture(async()=>Response.json({...result('a',op()),provider_locator:'private'}));await f.controller.apply('archive',[{account_id:'a',logical_message_id:logical()}]);assert.equal(f.success.length,0);assert.equal(f.controller.snapshot().groups[0].state,'uncertain');f.controller.dispose();
});
test('denial clears the account surface, while held results after scope change publish nothing',async()=>{
 const denied=fixture(async()=>new Response(null,{status:403}));await denied.controller.apply('star',[{account_id:'a',logical_message_id:logical()}]);assert.deepEqual(denied.denied,['a']);assert.equal(denied.success.length,0);assert.equal(denied.controller.snapshot().summary,'1 unconfirmed');denied.controller.dispose();
 let release!:(response:Response)=>void;const held=fixture(async()=>new Promise(resolve=>{release=resolve;}));const task=held.controller.apply('archive',[{account_id:'a',logical_message_id:logical()}]),count=held.states.length;held.end();held.controller.dispose();release(Response.json(result('a',op())));await task;assert.equal(held.states.length,count);assert.deepEqual(held.success,[]);assert.deepEqual(held.denied,[]);assert.equal(held.calls[0].options.signal?.aborted,true);
});
test('busy/conflict HTTP and oversized result remain unconfirmed, with no second POST',async()=>{
 for(const response of [()=>new Response(null,{status:409}),()=>new Response(' '.repeat(16385))]){const f=fixture(async()=>response());await f.controller.apply('archive',[{account_id:'a',logical_message_id:logical()}]);assert.equal(f.controller.snapshot().summary,'1 unconfirmed');assert.equal(f.calls.length,1);assert.equal(f.success.length,0);f.controller.dispose();}
});
test('native labels preserve the exact multi-label intent across 25-message groups',async()=>{
 const f=fixture(async(_path,options)=>{const body=JSON.parse(options.body as string);return Response.json(result('a',body.operation_id,body.logical_message_ids,'labels'));});
 const targets=Array.from({length:26},(_,i)=>({account_id:'a',logical_message_id:logical(i+1)})),tokens=Array.from({length:16},(_,i)=>'sealed_label_'+i);
 await f.controller.apply('labels',targets,{accountId:'a',action:'add',tokens});
 assert.equal(f.calls.length,2);for(const [i,call] of f.calls.entries())assert.deepEqual(JSON.parse(call.options.body as string),{operation_id:op(i+1),kind:'labels',logical_message_ids:targets.slice(i*25,i*25+25).map(row=>row.logical_message_id),label_action:'add',destination_ids:tokens});
 assert.equal(f.controller.snapshot().summary,'26 updated');assert.equal(f.success.length,1);assert.equal(f.targets[0].length,26);f.controller.dispose();
});
test('labels bound nominations and serialized bytes, reject foreign/duplicate scopes and snapshot caller intent',async()=>{
 const targets=Array.from({length:25},(_,i)=>({account_id:'a',logical_message_id:logical(i+1)}));
 assert.deepEqual(groupNativeTriageTargets(Array.from({length:100},(_,i)=>({account_id:'a',logical_message_id:logical(i+1)})),'labels',{accountId:'a',action:'add',tokens:['label']}).map(group=>group.ids.length),[25,25,25,25]);
 for(const nomination of [{accountId:'b',action:'add',tokens:['label']},{accountId:'a',action:'replace',tokens:['label']},{accountId:'a',action:'remove',tokens:[]},{accountId:'a',action:'add',tokens:['label','label']},{accountId:'a',action:'add',tokens:Array.from({length:17},(_,i)=>'label_'+i)},{accountId:'a',action:'add',tokens:['a'.repeat(8193)]},{accountId:'a',action:'add',tokens:['provider/label']}])assert.throws(()=>groupNativeTriageTargets(targets,'labels',nomination as NativeTriageSelection));
 assert.throws(()=>groupNativeTriageTargets([...targets,{account_id:'b',logical_message_id:logical(26)}],'labels',{accountId:'a',action:'add',tokens:['label']}));
 const tokens=Array.from({length:16},(_,i)=>i.toString(16).padStart(8192,'a')),f=fixture(async(_path,options)=>{const body=JSON.parse(options.body as string);if(body.logical_message_ids.length===25)assert.equal(new TextEncoder().encode(options.body as string).length,133059);return Response.json(result('a',body.operation_id,body.logical_message_ids,'labels'));});
 const task=f.controller.apply('labels',[...targets,{account_id:'a',logical_message_id:logical(26)}],{accountId:'a',action:'remove',tokens});tokens.splice(0,16,'changed');await task;assert.equal(f.calls.length,2);assert.equal(JSON.parse(f.calls[1].options.body as string).destination_ids.length,16);assert.notEqual(JSON.parse(f.calls[1].options.body as string).destination_ids[0],'changed');f.controller.dispose();
});
test('lost or denied label results retain status-only recovery and conditional Undo without nomination replay',async()=>{
 let recover=false;const f=fixture(async(path,options)=>{if(options.method==='POST'&&!path.endsWith('/undo'))throw Error('lost labels response');if(path.endsWith('/undo'))return Response.json({...result('a',op(2),[logical()],'labels'),undo_available:false,items:[{logical_message_id:logical(),state:'succeeded',undo_supported:false}]});recover=true;return Response.json(result('a',op(),[logical()],'labels'));});
 await f.controller.apply('labels',[{account_id:'a',logical_message_id:logical()}],{accountId:'a',action:'remove',tokens:['sealed_label']});assert.equal(f.controller.snapshot().groups[0].state,'uncertain');assert.equal(recover,false);
 await assert.rejects(f.controller.apply('labels',[{account_id:'a',logical_message_id:logical()}],{accountId:'a',action:'remove',tokens:['sealed_label']}));await f.controller.check();assert.equal(f.calls[1].options.method,'GET');assert.equal(f.calls[1].path,`/api/email/accounts/a/operations/${op()}`);assert.equal(f.calls[1].options.body,undefined);
 await f.controller.undo();assert.deepEqual(JSON.parse(f.calls[2].options.body as string),{undo_operation_id:op(2)});assert.equal(f.calls.filter(call=>call.path.endsWith('/operations')&&call.options.method==='POST').length,1);f.controller.dispose();
 const denied=fixture(async()=>new Response(null,{status:403}));await denied.controller.apply('labels',[{account_id:'a',logical_message_id:logical()}],{accountId:'a',action:'add',tokens:['sealed_label']});assert.deepEqual(denied.denied,['a']);assert.equal(denied.success.length,0);await denied.controller.undo();assert.equal(denied.calls.length,1);denied.controller.dispose();
 const split=fixture(async()=>new Response(null,{status:403}));await split.controller.apply('labels',Array.from({length:26},(_,i)=>({account_id:'a',logical_message_id:logical(i+1)})),{accountId:'a',action:'add',tokens:['sealed_label']});assert.equal(split.calls.length,1);assert.equal(split.controller.snapshot().groups[1].state,'failed');assert.equal(split.controller.snapshot().groups[1].notice,'Not submitted because account access changed.');split.controller.dispose();
 let release!:(value:Response)=>void;const held=fixture(async()=>new Promise(resolve=>{release=resolve;})),task=held.controller.apply('labels',[{account_id:'a',logical_message_id:logical()}],{accountId:'a',action:'add',tokens:['sealed_label']}),before=held.states.length;held.end();held.controller.dispose();release(Response.json(result('a',op(),[logical()],'labels')));await task;assert.equal(held.states.length,before);assert.equal(held.success.length,0);
});
