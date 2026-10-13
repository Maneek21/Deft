import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createNativeEmailSearch,reconcileNativeEmailSearchState,parseNativeEmailMessage,nativeSearchUnsupported,type NativeSearchState} from './email-native-search';

const query='  from:sender@example.test subject:"Exact phrase"  ';
const item=(suffix='a')=>({logical_message_id:'mail_'+suffix.repeat(64),revision:'provider/revision',received_at:'2026-10-04T01:00:00Z',
  folders:['inbox'],flags:{seen:false,flagged:false,answered:false},data:{subject:'Match',sender:'Sender'}});
const result=(account_id:string,extras={})=>({account_id,query,source:'provider',coverage:'complete',complete:true,query_complete:true,exact_total:null,
  items:[item()],next_cursor:null,unsupported:[],provider_result_cap:null,limitations:[],failure_count:0,observed_at:'2026-10-04T01:00:00Z',...extras});
test('unsupported classification requires every account to confirm rejection with no cached matches, failures or continuation',()=>{
 const state:NativeSearchState={query:'in:drafts',busy:false,loading:null,items:[],complete:false,accounts:['a','b'].map(accountId=>({accountId,state:'available',items:[],nextCursor:null,complete:false,unsupported:[{field:'in',reason:'unknown_operator',index:0}],limited:false,failureCount:0,error:''}))};
 assert.equal(nativeSearchUnsupported(state),true);assert.equal(nativeSearchUnsupported({...state,accounts:state.accounts.map(row=>({...row,unsupported:[{field:null,reason:'future_unknown_reason',index:null}],limited:true}))}),true);
 for(const next of [{...state,busy:true,loading:'refresh' as const},{...state,accounts:[]},{...state,items:[{...item(),account_id:'a'}]},
  ...(['pending','failed','denied'] as const).map(status=>({...state,accounts:state.accounts.map((row,index)=>index?{...row,state:status}:row)})),
  ...[{unsupported:[],complete:true},{failureCount:1},{nextCursor:'a-cursor'},{items:[{...item(),account_id:'a'}]}].map(change=>({...state,accounts:state.accounts.map((row,index)=>index?{...row,...change}:row)}))])assert.equal(nativeSearchUnsupported(next),false);
});
test('actual all-account unsupported query renders why and actionable help while held/mixed results retain partial coverage',async()=>{
 const states:NativeSearchState[]=[],bodies:string[]=[];const exactQuery=' in:drafts ',controller=createNativeEmailSearch({accountIds:['a','b'],query:exactQuery,current:()=>true,denied:()=>assert.fail('No denial'),change:state=>states.push(state),fetch:async(path,init)=>{bodies.push(String(init.body));return Response.json(result(path.split('/').at(-2)!,{query:exactQuery,items:[],coverage:'partial',complete:false,query_complete:false,unsupported:[{field:'in',reason:'unknown_operator',index:0}]}));}});
 await controller.start();const state=states.at(-1)!;assert.equal(state.query,exactQuery);assert.ok(bodies.every(body=>JSON.parse(body).query===exactQuery));assert.equal(nativeSearchUnsupported(state),true);
 const source=ts.createSourceFile('page.tsx',readFileSync(new URL('../app/(app)/email/page.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let status:ts.JsxElement|undefined,empty:ts.JsxElement|undefined;
 const visit=(node:ts.Node)=>{if(ts.isJsxElement(node)){const text=node.getText(source);if(node.openingElement.tagName.getText(source)==='p'&&text.includes('Results for ${searchState.query}'))status=node;if(node.openingElement.tagName.getText(source)==='div'&&text.includes('No matches have been loaded.')&&!text.includes('rows.map'))empty=node;}ts.forEachChild(node,visit);};visit(source);assert.ok(status);assert.ok(empty);
 const render=(searchState:NativeSearchState,node:ts.JsxElement)=>renderToStaticMarkup(vm.runInNewContext(ts.transpileModule('('+node.getText(source)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText,{React,searchState,rows:searchState.items,accounts:[{},{}],unsupportedSearch:nativeSearchUnsupported(searchState)}));
 const text=render(state,status)+render(state,empty);assert.match(text,/Search not supported/);assert.match(text,/Edit this query using Search help, then search again/);assert.doesNotMatch(text,/0 matches|partial|No matches|No messages match/);
 const held={...state,busy:true,loading:'refresh' as const};assert.match(render(held,status),/Refreshing search/);assert.doesNotMatch(render(held,status),/not supported/);
 const mixed={...state,items:[{...item(),account_id:'b'}],accounts:state.accounts.map((row,index)=>index?{...row,unsupported:[],items:[{...item(),account_id:'b'}],complete:true}:row)};assert.match(render(mixed,status),/1 matches loaded · results may be partial/);assert.equal(mixed.items[0].account_id,'b');assert.equal(mixed.accounts[0].unsupported[0].reason,'unknown_operator');controller.dispose();
});
test('same-query refresh retains old rows while each exact account is pending and replaces them when confirmed',async()=>{
 const prior=fixture(['a','b']);await prior.controller.start();const previous=prior.states.at(-1)!;prior.controller.dispose();
 const states:NativeSearchState[]=[],releases=new Map<string,(response:Response)=>void>();
 const controller=createNativeEmailSearch({accountIds:['b','a'],query,previous,current:()=>true,denied:()=>{},change:value=>states.push(value),fetch:async path=>new Promise(resolve=>{releases.set(path.split('/').at(-2)!,resolve);})});
 const pending=controller.start();assert.equal(states.at(-1)!.items.length,2,'refresh must keep the two prior rows while requests are held');assert.equal(states.at(-1)!.complete,false);
 releases.get('a')!(Response.json(result('a',{items:[item('b')]})));await new Promise(done=>setImmediate(done));assert.equal(states.at(-1)!.items.length,2);assert.equal(states.at(-1)!.accounts.find(row=>row.accountId==='a')!.items[0].logical_message_id,item('b').logical_message_id);
 releases.get('b')!(Response.json(result('b',{items:[]})));await pending;assert.equal(states.at(-1)!.items.length,1);assert.equal(states.at(-1)!.complete,true);controller.dispose();
});
test('different query or exact account set never seeds previous search rows',async()=>{
 const prior=fixture(['a','b']);await prior.controller.start();const previous=prior.states.at(-1)!;prior.controller.dispose();
 for(const [accountIds,nextQuery] of [[['a'],query],[['a','foreign'],query],[['a','b'],'new query']] as const){const states:NativeSearchState[]=[],releases:Array<(response:Response)=>void>=[];
  const controller=createNativeEmailSearch({accountIds,query:nextQuery,previous,current:()=>true,denied:()=>{},change:value=>states.push(value),fetch:async()=>new Promise(resolve=>releases.push(resolve))});
  const pending=controller.start();assert.equal(states.at(-1)!.items.length,0);assert.equal(states.at(-1)!.loading,'search');controller.dispose();for(const release of releases)release(new Response(null,{status:503}));await pending;
 }
});
test('refresh resets old paging, keeps healthy cached rows on failure and clears revoked account rows',async()=>{
 const prior=fixture(['a','b'],async id=>Response.json(result(id,{complete:false,query_complete:false,coverage:'partial',next_cursor:id+'-old'})));await prior.controller.start();const previous=prior.states.at(-1)!;prior.controller.dispose();
 const states:NativeSearchState[]=[],bodies:Array<{cursor:string|null}>=[],denials:string[]=[];
 const controller=createNativeEmailSearch({accountIds:['a','b'],query,previous,current:()=>true,denied:id=>denials.push(id),change:value=>states.push(value),fetch:async(path,init)=>{bodies.push(JSON.parse(init.body as string));return new Response(null,{status:path.includes('/a/')?503:403});}});
 await controller.start();assert.equal(states[0].loading,'refresh');assert.ok(states[0].accounts.every(row=>row.nextCursor===null&&row.state==='pending'));assert.ok(bodies.every(row=>row.cursor===null));
 const state=states.at(-1)!;assert.equal(state.items.length,1);assert.equal(state.items[0].account_id,'a');assert.equal(state.accounts[0].state,'failed');assert.equal(state.accounts[1].items.length,0);assert.deepEqual(denials,['b']);assert.equal(state.complete,false);controller.dispose();
});
test('revocation cancels the held account and blocks its late result while other accounts finish',async()=>{
 const prior=fixture(['a','b']);await prior.controller.start();const previous=prior.states.at(-1)!;prior.controller.dispose();
 const states:NativeSearchState[]=[],releases=new Map<string,(response:Response)=>void>(),signals=new Map<string,AbortSignal>();
 const controller=createNativeEmailSearch({accountIds:['a','b'],query,previous,current:()=>true,denied:()=>{},change:value=>states.push(value),fetch:async(path,init)=>new Promise(resolve=>{const id=path.split('/').at(-2)!;releases.set(id,resolve);signals.set(id,init.signal as AbortSignal);})});
 const pending=controller.start();controller.revoke('a');assert.equal(signals.get('a')!.aborted,true);assert.equal(signals.get('b')!.aborted,false);assert.deepEqual(states.at(-1)!.items.map(row=>row.account_id),['b']);
 releases.get('a')!(Response.json(result('a')));releases.get('b')!(Response.json(result('b')));await pending;assert.deepEqual(states.at(-1)!.items.map(row=>row.account_id),['b']);assert.equal(states.at(-1)!.accounts[0].state,'denied');controller.dispose();
});
test('refresh pagination uses the new cursor, holds rows while pending and rejects concurrent More',async()=>{
 const prior=fixture(['a'],async id=>Response.json(result(id,{complete:false,query_complete:false,coverage:'partial',next_cursor:'old-cursor'})));await prior.controller.start();const previous=prior.states.at(-1)!;prior.controller.dispose();
 const states:NativeSearchState[]=[],bodies:Array<{cursor:string|null}>=[];let release!:(response:Response)=>void;
 const controller=createNativeEmailSearch({accountIds:['a'],query,previous,current:()=>true,denied:()=>{},change:value=>states.push(value),fetch:async(_path,init)=>{const body=JSON.parse(init.body as string);bodies.push(body);return body.cursor?new Promise(resolve=>{release=resolve;}):Response.json(result('a',{complete:false,query_complete:false,coverage:'partial',next_cursor:'new-cursor'}));}});
 await controller.start();const more=controller.more('a');await controller.more('a');assert.equal(bodies.length,2);assert.equal(bodies[1].cursor,'new-cursor');assert.equal(states.at(-1)!.loading,'more');assert.equal(states.at(-1)!.items.length,1);
 release(Response.json(result('a',{items:[item('b')]})));await more;assert.equal(states.at(-1)!.items.length,2);assert.equal(states.at(-1)!.loading,null);controller.dispose();
});
test('out-of-order old refresh completion cannot overwrite a newer query or emit denial',async()=>{
 const prior=fixture(['a']);await prior.controller.start();const previous=prior.states.at(-1)!;prior.controller.dispose();
 const states:NativeSearchState[]=[],denials:string[]=[];let generation=1,release!:(response:Response)=>void;
 const old=createNativeEmailSearch({accountIds:['a'],query,previous,current:()=>generation===1,denied:id=>denials.push(id),change:value=>states.push(value),fetch:async()=>new Promise(resolve=>{release=resolve;})});const held=old.start();generation=2;old.dispose();
 const fresh=createNativeEmailSearch({accountIds:['a'],query:'new query',previous,current:()=>generation===2,denied:id=>denials.push(id),change:value=>states.push(value),fetch:async()=>Response.json(result('a',{query:'new query',items:[item('b')]}))});await fresh.start();const before=states.length;release(new Response(null,{status:403}));await held;assert.equal(states.length,before);assert.equal(states.at(-1)!.query,'new query');assert.equal(states.at(-1)!.items[0].logical_message_id,item('b').logical_message_id);assert.deepEqual(denials,[]);fresh.dispose();
});
test('actual mailbox Refresh passes current search state and keeps the reader while new query clears it',async()=>{
 const source=ts.createSourceFile('page.tsx',readFileSync(new URL('../app/(app)/email/page.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let expression:ts.Expression|undefined;
 const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='runSearch')expression=node.initializer;ts.forEachChild(node,visit);};visit(source);assert.ok(expression);
 const exactQuery='  in:drafts subject:report  ',nextQuery=' in:sent subject:report ',prior=fixture(['a']);await prior.controller.start();const initial=prior.states.at(-1)!,scoped=initial.items.map(row=>({...row,folders:['drafts']})),previous={...initial,query:exactQuery,items:scoped,accounts:initial.accounts.map(row=>({...row,items:scoped.filter(item=>item.account_id===row.accountId)}))};prior.controller.dispose();const states:NativeSearchState[]=[],selected:unknown[]=[];let release!:(response:Response)=>void;
 const context={folderProjection:{current:null},actionView:{current:null},setFeedbackView:()=>{},reconcileNativeEmailSearchState,ids:['a'],query:exactQuery,searchState:previous,searchController:{current:null as ReturnType<typeof createNativeEmailSearch>|null},searchGeneration:{current:0},pending:{current:null},refresh:{current:null},setRefreshing:()=>{},setBusy:()=>{},setNotice:()=>{},setSearchOpen:()=>{},setSelected:(value:unknown)=>selected.push(value),router:{replace:()=>{}},selectedRef:{current:previous.items[0]},api:{getAccessToken:()=> 'same',fetch:async()=>new Promise<Response>(resolve=>{release=resolve;})},isSameWebSession:()=>true,createNativeEmailSearch,denied:()=>{},messageKey:(row:{account_id:string;logical_message_id:string})=>row.account_id+'/'+row.logical_message_id,setSearchState:(value:NativeSearchState)=>states.push(value)};
 const run=vm.runInNewContext(ts.transpileModule('('+expression.getText(source)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,context);
 const refresh=run(exactQuery,true);assert.equal(states.at(-1)!.query,exactQuery);assert.equal(states.at(-1)!.items.length,1);assert.deepEqual(states.at(-1)!.items[0].folders,['drafts']);assert.ok(selected.every(value=>value!==null));release(Response.json(result('a',{query:exactQuery,items:[{...item(),folders:['drafts']}]})));await refresh;
 selected.length=0;const search=run(nextQuery,false);assert.equal(states.at(-1)!.query,nextQuery);assert.equal(states.at(-1)!.items.length,0);assert.equal(selected[0],null);release(Response.json(result('a',{query:nextQuery,items:[{...item(),folders:['sent']}]})));await search;assert.deepEqual(states.at(-1)!.items[0].folders,['sent']);context.searchController.current!.dispose();
});
test('completed uncapped search remains complete when exact totals or atomic snapshot guarantees are unavailable',async()=>{const f=fixture(['a','b'],async id=>Response.json(result(id,{limitations:['exact_total_unavailable','weak_consistency']})));await f.controller.start();assert.equal(f.states.at(-1)!.complete,true);assert.ok(f.states.at(-1)!.accounts.every(row=>!row.limited));f.controller.dispose();});
function fixture(accounts=['a','b'],fetch:(account:string,body:{query:string;cursor:string|null;limit:number})=>Promise<Response>=async id=>Response.json(result(id))){
 const states:NativeSearchState[]=[],calls:Array<{account:string;body:{query:string;cursor:string|null;limit:number};signal:AbortSignal}>=[],denied:string[]=[];let current=true;
 const controller=createNativeEmailSearch({accountIds:accounts,query,current:()=>current,change:value=>states.push(value),denied:id=>denied.push(id),
  fetch:async(path,options)=>{const account=decodeURIComponent(path.split('/').at(-2)!);const body=JSON.parse(options.body as string);calls.push({account,body,signal:options.signal as AbortSignal});return fetch(account,body);}});
 return {controller,states,calls,denied,end:()=>{current=false;}};
}

test('all-account search limits fanout to two requests and preserves the original query unchanged',async()=>{
 let inFlight=0,maximum=0;const releases:Array<()=>void>=[];
 const f=fixture(['a','b','c','d','e'],async account=>{inFlight++;maximum=Math.max(maximum,inFlight);
  await new Promise<void>(resolve=>releases.push(resolve));inFlight--;return Response.json(result(account));});
 const task=f.controller.start();while(f.calls.length<2)await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.length,2);
 while(f.calls.length<5||inFlight){for(const release of releases.splice(0))release();await new Promise(resolve=>setImmediate(resolve));}
 await task;assert.equal(maximum,2);assert.equal(f.states.at(-1)!.items.length,5);
 assert.ok(f.calls.every(call=>call.body.query===query&&call.body.cursor===null&&call.body.limit===50));
 assert.equal(f.states.at(-1)!.complete,true);assert.equal(f.states.at(-1)!.query,query);f.controller.dispose();
});

test('explicit More sends only that account continuation and keeps duplicate logical IDs separate across accounts',async()=>{
 const f=fixture(['a','b'],async(account,body)=>Response.json(result(account,body.cursor?{items:[item('b')]}:{complete:false,query_complete:false,coverage:'partial',next_cursor:account+'-opaque'})));
 await f.controller.start();assert.equal(f.states.at(-1)!.items.length,2);assert.equal(f.calls.length,2);
 await f.controller.more('a');assert.equal(f.calls.length,3);assert.deepEqual(f.calls.at(-1)!.body,{query,limit:50,cursor:'a-opaque'});
 const state=f.states.at(-1)!;assert.equal(state.items.length,3);assert.equal(state.accounts.find(row=>row.accountId==='b')!.nextCursor,'b-opaque');assert.equal(state.complete,false);f.controller.dispose();
});

test('canonical folder query preserves exact text and per-account continuations beside unavailable folder evidence',async()=>{
 const exactQuery='  in:drafts subject:"Exact phrase"  ',states:NativeSearchState[]=[],calls:Array<{account:string;body:{query:string;cursor:string|null;limit:number}}>=[];
 const controller=createNativeEmailSearch({accountIds:['gmail','microsoft','imap'],query:exactQuery,current:()=>true,denied:()=>assert.fail('No denial'),change:state=>states.push(state),fetch:async(path,init)=>{
  const account=path.split('/').at(-2)!,body=JSON.parse(String(init.body));calls.push({account,body});assert.deepEqual(Object.keys(body).sort(),['cursor','limit','query']);
  return Response.json(result(account,{query:exactQuery,items:account==='imap'?[]:[{...item(body.cursor?'b':'a'),folders:['drafts']}],coverage:'partial',complete:false,query_complete:false,next_cursor:account==='imap'||body.cursor?null:account+'-drafts-cursor',unsupported:account==='imap'?[{field:'in',index:0,reason:'folder_scope_unavailable'}]:[]}));
 }});
 await controller.start();assert.equal(states.at(-1)!.query,exactQuery);assert.equal(states.at(-1)!.items.length,2);assert.equal(nativeSearchUnsupported(states.at(-1)!),false);assert.ok(states.at(-1)!.items.every(row=>row.folders.includes('drafts')));assert.equal(states.at(-1)!.accounts[2].unsupported[0].reason,'folder_scope_unavailable');
 await controller.more('gmail');assert.equal(calls.length,4);assert.deepEqual(calls.at(-1),{account:'gmail',body:{query:exactQuery,cursor:'gmail-drafts-cursor',limit:50}});const state=states.at(-1)!;assert.equal(state.items.length,3);assert.equal(state.accounts[1].nextCursor,'microsoft-drafts-cursor');assert.ok(calls.every(call=>call.body.query===exactQuery));controller.dispose();
});

test('folder Refresh retains scoped matches on failure but another in: scope starts with no rows or old cursor',async()=>{
 const exactQuery=' in:drafts subject:report ',previous:NativeSearchState={query:exactQuery,busy:false,loading:null,complete:false,items:[{...item(),account_id:'gmail',folders:['drafts']}],accounts:[{accountId:'gmail',state:'available',items:[{...item(),account_id:'gmail',folders:['drafts']}],nextCursor:'old-drafts-cursor',complete:false,unsupported:[],limited:false,failureCount:0,error:''}]};
 const states:NativeSearchState[]=[],calls:Array<{query:string;cursor:string|null}>=[];let release!:(response:Response)=>void,generation=1;
 const refresh=createNativeEmailSearch({accountIds:['gmail'],query:exactQuery,previous,current:()=>generation===1,denied:()=>assert.fail('Late denial must be suppressed'),change:state=>states.push(state),fetch:async(_path,init)=>{calls.push(JSON.parse(String(init.body)));return new Promise(resolve=>release=resolve);}});
 let held=refresh.start();assert.equal(states.at(-1)!.loading,'refresh');assert.deepEqual(states.at(-1)!.items,previous.items);assert.equal(states.at(-1)!.accounts[0].nextCursor,null);release(new Response(null,{status:503}));await held;assert.deepEqual(states.at(-1)!.items,previous.items);assert.equal(states.at(-1)!.accounts[0].state,'failed');assert.deepEqual(calls[0],{query:exactQuery,cursor:null,limit:50});refresh.dispose();
 const nextQuery=' in:sent subject:report ',newStates:NativeSearchState[]=[],nextCalls:Array<{query:string;cursor:string|null}>=[],next=createNativeEmailSearch({accountIds:['gmail'],query:nextQuery,previous,current:()=>generation===1,denied:()=>assert.fail('Late denial must be suppressed'),change:state=>newStates.push(state),fetch:async(_path,init)=>{nextCalls.push(JSON.parse(String(init.body)));return new Promise(resolve=>release=resolve);}});
 held=next.start();assert.equal(newStates.at(-1)!.loading,'search');assert.deepEqual(newStates.at(-1)!.items,[]);assert.deepEqual(nextCalls[0],{query:nextQuery,cursor:null,limit:50});const count=newStates.length;generation++;next.dispose();release(new Response(null,{status:403}));await held;assert.equal(newStates.length,count);
});

test('one failed or denied account preserves other results and never reports search complete',async()=>{
 const f=fixture(['healthy','failed','revoked'],async id=>id==='healthy'?Response.json(result(id)):new Response(null,{status:id==='revoked'?403:503}));
 await f.controller.start();const state=f.states.at(-1)!;
 assert.equal(state.items.length,1);assert.equal(state.items[0].account_id,'healthy');assert.equal(state.complete,false);assert.deepEqual(f.denied,['revoked']);
 assert.equal(state.accounts.find(row=>row.accountId==='failed')!.state,'failed');f.controller.dispose();
});

test('unsupported filters and provider caps remain explicit partial account outcomes without invented totals',async()=>{
 const f=fixture(['unsupported','limited'],async id=>Response.json(result(id,id==='unsupported'
  ?{items:[],unsupported:[{field:'received_on',index:0,reason:'unsupported'}],complete:false,query_complete:false,coverage:'partial'}
  :{provider_result_cap:1000,limitations:['provider_cap'],complete:false,query_complete:false,coverage:'partial'})));
 await f.controller.start();const state=f.states.at(-1)!;assert.equal(state.complete,false);
 assert.equal(state.accounts[0].unsupported[0].field,'received_on');assert.equal(state.accounts[1].limited,true);f.controller.dispose();
});

test('expired and cyclic account continuations retain prior matches but require explicit search restart',async()=>{
 for(const cyclic of [false,true]){
  const f=fixture(['a'],async(id,body)=>body.cursor?(cyclic?Response.json(result(id,{complete:false,query_complete:false,coverage:'partial',next_cursor:'opaque'})):new Response(null,{status:409}))
   :Response.json(result(id,{complete:false,query_complete:false,coverage:'partial',next_cursor:'opaque'})));
  await f.controller.start();await f.controller.more('a');const state=f.states.at(-1)!;
  assert.equal(state.items.length,1);assert.equal(state.complete,false);assert.equal(state.accounts[0].state,'failed');assert.equal(state.accounts[0].nextCursor,null);
  assert.match(state.accounts[0].error,/again/);f.controller.dispose();
 }
});

test('held searches cannot publish or nominate denial after scope/account/session replacement',async()=>{
 let release!:(response:Response)=>void;const f=fixture(['a'],()=>new Promise(resolve=>{release=resolve;}));
 const task=f.controller.start(),before=f.states.length;f.end();f.controller.dispose();release(Response.json(result('a')));await task;
 assert.equal(f.states.length,before);assert.deepEqual(f.denied,[]);assert.equal(f.calls[0].signal.aborted,true);
});

test('search responses are pinned to exact account/query; public DTO rejects private provider locator fields',async()=>{
 assert.throws(()=>parseNativeEmailMessage({...item(),provider_source:{locator:'private'}},'a'));
 assert.throws(()=>parseNativeEmailMessage({...item(),account_id:'foreign'},'a'));
 for(const extras of [{query:'different'},{account_id:'foreign'},{provider_source:{locator:'private'}},{complete:true,query_complete:false}]){
  const f=fixture(['a'],async()=>Response.json(result('a',extras)));await f.controller.start();assert.equal(f.states.at(-1)!.items.length,0);assert.equal(f.states.at(-1)!.complete,false);f.controller.dispose();
 }
});

test('native folder navigation is visible only on exact /email and current canonical session scope',()=>{
 const context=readFileSync(new URL('../components/apps/experience-navigation-context.tsx',import.meta.url),'utf8');
 const expression=context.match(/const nativeEmailNavigation=([^;]+);/)![1];const nativeState={pathname:'/email',scope:'current',owner:Symbol('native')};
 for(const [pathname,sessionCacheScope,visible] of [['/email','current',true],['/email','foreign',false],['/apps/old/main','current',false],['/email/other','current',false]]as const)
  assert.equal(!!vm.runInNewContext(expression,{pathname,sessionCacheScope,nativeState}),visible);
 const sidebar=readFileSync(new URL('../components/sidebar.tsx',import.meta.url),'utf8');
 assert.match(sidebar,/if\(pathname==='\/email'\)return <NativeEmailSidebarContent/);
 assert.match(sidebar,/navigation.select\(item.id\);onNav\(\)/);
});

test('native mailbox exposes an accessible Search pill beside Refresh without a header account picker',()=>{
 const source=readFileSync(new URL('../app/(app)/email/page.tsx',import.meta.url),'utf8');
 assert.match(source,/aria-label="Search mail"/);
 assert.ok(!source.includes('<select'));
});
