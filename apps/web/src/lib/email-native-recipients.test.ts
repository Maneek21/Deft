import assert from 'node:assert/strict';
import test from 'node:test';
import {createNativeRecipientQuery,parseNativeRecipientPage,selectNativeRecipient,nativeRecipientKey,nativeRecipientProvenanceLabel,nativeRecipientAssistanceStatus,nativeRecipientLimitNotice,type NativeRecipientPage} from './email-native-recipients';
const page=(account_id='account',query='Ada')=>({account_id,query,items:[{address:'Ada@example.test',name:'Ada',provenance:['contacts']}],sources:{contacts:'available',recent:'available'},has_more:false});
test('keyboard moves through suggestions, Enter chooses explicitly and Escape closes without committing',()=>{
 assert.deepEqual(nativeRecipientKey('ArrowUp',0,2),{action:'navigate',index:1});assert.deepEqual(nativeRecipientKey('ArrowDown',1,2),{action:'navigate',index:0});
 assert.deepEqual(nativeRecipientKey('Enter',1,2),{action:'choose',index:1});assert.equal(nativeRecipientKey('Escape',1,2).action,'close');assert.equal(nativeRecipientKey('Enter',0,0).action,'none');
});
test('suggestions are a strict scoped projection and reject raw fields, duplicates and malformed addresses',()=>{
 assert.equal(parseNativeRecipientPage(page(),'account','Ada').items.length,1);
 for(const invalid of [{...page(),account_id:'foreign'},{...page(),query:'old'},{...page(),body:'private'}, {...page(),items:[...page().items,...page().items]}, {...page(),items:[{...page().items[0],address:'a\r\nb@example.test'}]}])assert.throws(()=>parseNativeRecipientPage(invalid,'account','Ada'));
});
test('explicit selection preserves display case, does not change other fields, and refuses duplicates across To Cc Bcc',()=>{
 const suggestion=parseNativeRecipientPage(page(),'account','Ada').items[0]!;const original=[{address:'one@example.test',displayName:'One'}];assert.deepEqual(selectNativeRecipient(original,suggestion),[...original,{address:'Ada@example.test',displayName:'Ada'}]);assert.equal(original.length,1);
 assert.throws(()=>selectNativeRecipient(original,suggestion,['ada@EXAMPLE.test']),/already/);
 assert.throws(()=>selectNativeRecipient(Array.from({length:200},(_,i)=>({address:`a${i}@example.test`,displayName:''})),suggestion),/full/);
});
test('native selection and send preflight count all supplied To/Cc/Bcc rows to200 before transport deduplication',()=>{
 const addresses=Array.from({length:32},(_,i)=>({address:`a${i}@example.test`,displayName:`Person ${i}`})),suggestion={address:'next@example.test',name:'Next',provenance:['contacts'] as const};
 assert.equal(selectNativeRecipient(addresses,{...suggestion,provenance:['contacts']}).length,33);
 const other=Array.from({length:168},(_,i)=>`b${i}@example.test`).join(', ');assert.throws(()=>selectNativeRecipient(addresses,{...suggestion,provenance:['contacts']},[other]),/200 recipients/);
 const repeated=(count:number)=>Array.from({length:count},()=> 'same@example.test').join(', ');
 assert.equal(nativeRecipientLimitNotice([repeated(100),repeated(100),'']),'');assert.match(nativeRecipientLimitNotice([repeated(100),repeated(100),'another@example.test']),/at most 200/);
 assert.match(nativeRecipientLimitNotice(['unfinished@','','']),/kept for correction/);assert.equal(nativeRecipientLimitNotice(['','','']),'');assert.equal(addresses.length,32);
});
test('held old query is aborted and cannot publish after new text or account disposal',async()=>{
 const requests:{signal:AbortSignal;resolve:(r:Response)=>void;body:unknown}[]=[],changes:unknown[]=[];let live=true;
 const client=createNativeRecipientQuery({accountId:'account',current:()=>live,change:p=>changes.push(p),fetch:async(_path,init)=>new Promise<Response>(resolve=>requests.push({signal:init.signal as AbortSignal,resolve,body:JSON.parse(String(init.body))}))});
 const first=client.query('Ada');assert.deepEqual(requests[0]!.body,{query:'Ada',limit:10});const second=client.query('Bob');assert.equal(requests[0]!.signal.aborted,true);
 requests[0]!.resolve(new Response(JSON.stringify(page())));await first;assert.equal(changes.filter(Boolean).length,0);
 requests[1]!.resolve(new Response(JSON.stringify({...page('account','Bob'),items:[]})));await second;assert.equal(changes.filter(Boolean).length,1);
 const third=client.query('Ada');live=false;client.dispose();requests[2]!.resolve(new Response(JSON.stringify(page())));await third;assert.equal(changes.filter(Boolean).length,1);
});
test('revocation clears suggestions and invalid scope response never creates a recipient',async()=>{
 let denied=0;const changes:unknown[]=[];const client=createNativeRecipientQuery({accountId:'account',current:()=>true,change:(p,n)=>changes.push({p,n}),denied:()=>denied++,fetch:async()=>new Response('{}',{status:403})});await client.query('Ada');assert.equal(denied,1);assert.equal(changes.some(v=>(v as {p:unknown}).p),false);client.dispose();
});
test('deduplicated suggestion keeps both Contact and Recent provenance without changing its exact address',()=>{
 const value=parseNativeRecipientPage({...page(),items:[{...page().items[0],provenance:['recent','contacts']}]},'account','Ada').items[0]!;
 assert.equal(nativeRecipientProvenanceLabel(value),'Contact · Recent');assert.equal(selectNativeRecipient([],value)[0].address,'Ada@example.test');
 assert.equal(nativeRecipientProvenanceLabel({...value,provenance:['recent']}),'Recent');assert.equal(nativeRecipientProvenanceLabel({...value,provenance:['contacts']}),'Contact');
 for(const provenance of [['contacts','contacts'],['provider'],[]])assert.throws(()=>parseNativeRecipientPage({...page(),items:[{...value,provenance}]},'account','Ada'));
});
test('only useful partial-source, bounded-results and empty states need a visible notice',()=>{
 const full=parseNativeRecipientPage(page(),'account','Ada');assert.equal(nativeRecipientAssistanceStatus(full).actionable,false);assert.match(nativeRecipientAssistanceStatus(full).text,/selected sending account/);
 assert.deepEqual(nativeRecipientAssistanceStatus({...full,has_more:true}),{text:'More suggestions may be available. Keep typing to narrow.',actionable:true});
 assert.match(nativeRecipientAssistanceStatus({...full,items:[]}).text,/Enter an email address/);
 const contactsUnavailable:NativeRecipientPage={...full,items:[{...full.items[0],provenance:['recent']}],sources:{contacts:'unavailable',recent:'available'}};
 const recentUnavailable:NativeRecipientPage={...full,sources:{contacts:'available',recent:'unavailable'}};
 assert.equal(nativeRecipientAssistanceStatus(contactsUnavailable).actionable,true);assert.match(nativeRecipientAssistanceStatus(contactsUnavailable).text,/Contacts unavailable/);
 assert.match(nativeRecipientAssistanceStatus(recentUnavailable).text,/Recent recipients unavailable/);
 assert.equal(nativeRecipientAssistanceStatus({...contactsUnavailable,sources:{contacts:'not_installed',recent:'available'}}).actionable,false);
 for(const value of [full,contactsUnavailable,recentUnavailable,{...full,has_more:true}])assert.doesNotMatch(nativeRecipientAssistanceStatus(value).text,/account$|account_id|complete|all matches|\d+ contacts/);
});
test('unavailable Contacts does not reject healthy scoped recent suggestions or change manual addressing',async()=>{
 const response={...page(),sources:{contacts:'unavailable',recent:'available'},items:[{...page().items[0],provenance:['recent']}]};let received:NativeRecipientPage|null=null,notice='';
 const client=createNativeRecipientQuery({accountId:'account',current:()=>true,change:(value,message)=>{received=value;notice=message;},fetch:async()=>new Response(JSON.stringify(response))});await client.query('Ada');
 assert.equal(notice,'');assert.deepEqual(received,response);assert.deepEqual(selectNativeRecipient([{address:'typed@example.test',displayName:''}],response.items[0] as NativeRecipientPage['items'][number]).map(item=>item.address),['typed@example.test','Ada@example.test']);client.dispose();
});
