import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeEmailFolders,nativeFolderLabel,parseNativeFolderPage,type NativeFolder,type NativeFolderState} from './email-native-folders';
const folder=(suffix='a',label='Projects'):NativeFolder=>({folder_id:'label:'+suffix.repeat(64),label,kind:'label',parent_folder_id:null,canonical_role:null,destination_id:'sealed_destination_'+suffix,labels_allowed:true});
const page=(account:string,extras={})=>({account_id:account,provider:'gmail',items:[folder()],next_cursor:null,has_more:false,observed_at:'2026-10-04T00:00:00Z',coverage:'complete',consistency:'weak',exact_total:null,...extras});
function fixture(ids=['a'],fetch:(account:string,body:{cursor:string|null;limit:number})=>Promise<Response>=async id=>Response.json(page(id))){let current=true;const states:NativeFolderState[]=[],calls:Array<{account:string;body:{cursor:string|null;limit:number}}>=[],denied:string[]=[];const controller=createNativeEmailFolders({accountIds:ids,current:()=>current,change:state=>states.push(state),denied:id=>denied.push(id),fetch:async(path,options)=>{const account=decodeURIComponent(path.split('/').at(-3)!),body=JSON.parse(options.body as string);calls.push({account,body});return fetch(account,body);}});return {controller,calls,states,denied,end:()=>{current=false;}};}
test('M24 management catalogue is explicit and preserves the ordinary browse request and parser contract',async()=>{
 const calls:unknown[]=[],states:NativeFolderState[]=[];const management=createNativeEmailFolders({accountIds:['a'],management:true,current:()=>true,denied:()=>{},change:state=>states.push(state),fetch:async(_path,options)=>{calls.push(JSON.parse(String(options.body)));return Response.json(page('a',{create_allowed:true,items:[{...folder(),rename_id:'sealed_rename'}]}));}});
 await management.start();assert.deepEqual(calls,[{cursor:null,limit:50,management:true}]);assert.equal(states.at(-1)?.accounts[0]?.createAllowed,true);assert.equal(states.at(-1)?.accounts[0].items[0]?.rename_id,'sealed_rename');management.dispose();
 const ordinary=fixture();await ordinary.controller.start();assert.deepEqual(ordinary.calls[0].body,{cursor:null,limit:50});assert.equal(Object.hasOwn(ordinary.states.at(-1)!.accounts[0],'createAllowed'),false);ordinary.controller.dispose();
});
test('M24 management metadata never contaminates ordinary Move handles or guesses missing eligibility',()=>{
 const manage=page('a',{create_allowed:true,items:[{...folder(),rename_id:'sealed_rename'}]});assert.equal(parseNativeFolderPage(manage,'a',true).createAllowed,true);assert.throws(()=>parseNativeFolderPage(manage,'a'));
 assert.throws(()=>parseNativeFolderPage(page('a'),'a',true));for(const fields of [{create_allowed:'true'},{items:[{...folder(),rename_id:'https://provider'}]},{items:[{...folder(),rename_id:undefined}]}])assert.throws(()=>parseNativeFolderPage({...manage,...fields},'a',true));
 const denied=page('a',{create_allowed:false,items:[{...folder(),rename_id:null}]});assert.equal(parseNativeFolderPage(denied,'a',true).items[0].rename_id,null);assert.equal(parseNativeFolderPage(page('a'),'a').items[0].destination_id,folder().destination_id);
});
test('folder catalogue bounds fanout to two and keeps explicit pagination on its exact account',async()=>{
 let inFlight=0,maximum=0;const releases:Array<()=>void>=[];const f=fixture(['a','b','c'],async(account,body)=>{inFlight++;maximum=Math.max(maximum,inFlight);if(!body.cursor)await new Promise<void>(resolve=>releases.push(resolve));inFlight--;return Response.json(page(account,body.cursor?{items:[folder('b')]}:{next_cursor:'scoped_'+account,has_more:true,coverage:'partial'}));});
 const task=f.controller.start();while(f.calls.length<2)await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.length,2);
 while(inFlight||f.calls.length<3){for(const release of releases.splice(0))release();await new Promise(resolve=>setImmediate(resolve));}await task;assert.equal(maximum,2);assert.equal(f.states.at(-1)?.accounts[0].complete,false);
 await f.controller.more('a');assert.equal(f.calls.length,4);assert.deepEqual(f.calls[3],{account:'a',body:{cursor:'scoped_a',limit:50}});assert.equal(f.states.at(-1)?.accounts[0].items.length,2);assert.equal(f.states.at(-1)?.accounts[1].nextCursor,'scoped_b');f.controller.dispose();
});
test('expired/cyclic folder cursors retain known labels but disable stale move destinations until reload',async()=>{
 for(const cycle of [false,true]){const f=fixture(['a'],async(account,body)=>body.cursor?(cycle?Response.json(page(account,{next_cursor:'same_cursor',has_more:true,coverage:'partial'})):new Response(null,{status:409})):Response.json(page(account,{next_cursor:'same_cursor',has_more:true,coverage:'partial'})));
  await f.controller.start();await f.controller.more('a');const row=f.states.at(-1)!.accounts[0];assert.equal(row.items.length,1);assert.equal(row.complete,false);assert.equal(row.state,'failed');assert.equal(row.nextCursor,null);assert.match(row.notice,/Reload/);f.controller.dispose();}
});
test('catalogue pins account, strips no fields silently and keeps sealed destination distinct from folder filter identity',()=>{
 const valid=page('a');assert.equal(parseNativeFolderPage(valid,'a').items[0].destination_id,'sealed_destination_a');assert.equal(parseNativeFolderPage(valid,'a').items[0].folder_id,'label:'+'a'.repeat(64));
 for(const bad of [{...valid,account_id:'foreign'},{...valid,provider_locator:'private'},{...valid,next_cursor:'cursor',has_more:false},{...valid,items:[{...folder(),id:'provider-folder-id'}]},{...valid,items:[{...folder(),destination_id:'https://remote'}]}])assert.throws(()=>parseNativeFolderPage(bad,'a'));
});
test('account denial clears only its folder labels, and held catalogues cannot publish after scope disposal',async()=>{
 const denied=fixture(['healthy','revoked'],async id=>id==='healthy'?Response.json(page(id)):new Response(null,{status:403}));await denied.controller.start();assert.deepEqual(denied.denied,['revoked']);assert.equal(denied.states.at(-1)?.accounts[0].items.length,1);assert.equal(denied.states.at(-1)?.accounts[1].items.length,0);denied.controller.dispose();
 let release!:(response:Response)=>void;const held=fixture(['a'],async()=>new Promise(resolve=>{release=resolve;}));const task=held.controller.start(),count=held.states.length;held.end();held.controller.dispose();release(Response.json(page('a')));await task;assert.equal(held.states.length,count);assert.deepEqual(held.denied,[]);
});
test('folder display disambiguates loaded parents without exposing opaque folder IDs and bounds malformed cycles',()=>{
 const parent=folder('b','Client'),child={...folder('a'),parent_folder_id:parent.folder_id};assert.equal(nativeFolderLabel(child,[parent,child]),'Client / Projects');assert.equal(nativeFolderLabel(child,[child]),'… / Projects');
 assert.equal(nativeFolderLabel({...child,parent_folder_id:child.folder_id},[child]),'… / Projects');
});
