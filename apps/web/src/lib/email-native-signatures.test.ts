import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeSignatureSettings,parseNativeSignatureEntry,parseNativeSignaturePreferences,type NativeSignatureEntry,type NativeSignaturePreferences} from './email-native-signatures';
const key='a'.repeat(64),otherKey='b'.repeat(64);
const primary:NativeSignatureEntry={address:'owner@example.com',plain:'Best,\nOwner',html:'',placement:'both'};
const old:NativeSignatureEntry={address:'old@example.com',plain:'Old signature',html:'',placement:'reply'};
const row:NativeSignaturePreferences={account_id:'account',revision:2,preferences:{identities:[primary,old]},identity_availability:{available:[{address:primary.address,identity_key:key}],saved:[{address:primary.address,identity_key:key,current:true},{address:old.address,identity_key:otherKey,current:false}]}};
const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
const changed={...primary,plain:'Regards,\nOwner',placement:'new' as const};
const receipt={...row,revision:3,preferences:{identities:[changed,old]}};
function fixture(fetch:(path:string,init:RequestInit)=>Promise<Response>,primaryAddress=primary.address){let current=true;const client=createNativeSignatureSettings({accountId:'account',primaryAddress,fetch,current:()=>current,change:()=>{}});return {client,end:()=>{current=false;}};}

test('signature projection is closed and scope-bound, with exact saved/current identity metadata and no private fields',()=>{
 assert.deepEqual(parseNativeSignaturePreferences(row,'account'),row);
 for(const value of [{...row,credential:'secret'},{...row,account_id:'foreign'},{...row,revision:-1},{...row,preferences:{identities:[primary,primary]}},{...row,identity_availability:{...row.identity_availability,saved:[{address:primary.address,identity_key:key,current:true}]}},{...row,identity_availability:{available:null,saved:row.identity_availability.saved}},{...row,identity_availability:{...row.identity_availability,available:[{address:primary.address,identity_key:'bad'}]}}])assert.throws(()=>parseNativeSignaturePreferences(value,'account'));
});
test('signature content uses the closed safe compose grammar and plain/rich parity with bounded preferences',()=>{
 assert.deepEqual(parseNativeSignatureEntry({...primary,html:'<p>Best,<br>Owner</p>'}),{...primary,html:'<p>Best,<br>Owner</p>'});
 for(const value of [{...primary,plain:'x'.repeat(2049)},{...primary,html:'<p>Other</p>'},{...primary,html:'<p><a href="https://example.com">Owner</a></p>'},{...primary,html:'<p onclick="alert(1)">Best,<br>Owner</p>'},{...primary,plain:'\0'},{...primary,html:'x'.repeat(16385)},{...primary,placement:'always'},{...primary,credential:'secret'}])assert.throws(()=>parseNativeSignatureEntry(value));
});
test('explicit primary-identity save sends only that identity and CAS revision; unavailable signatures remain retained',async()=>{
 const calls:{path:string;init:RequestInit}[]=[];const f=fixture(async(path,init)=>{calls.push({path,init});return response(init.method==='PUT'?receipt:row);});await f.client.load();f.client.edit(changed);await f.client.save();
 assert.equal(calls[0]!.path,'/api/email/accounts/account/signatures');assert.equal(calls[0]!.init.cache,'no-store');assert.deepEqual(JSON.parse(calls[1]!.init.body as string),{expected_revision:2,identities:[changed]});assert.equal(f.client.snapshot().dirty,false);assert.deepEqual(f.client.snapshot().saved!.preferences.identities[1],old);assert.match(f.client.snapshot().notice,/Existing drafts are unchanged/);await f.client.save();assert.equal(calls.length,2);f.client.dispose();
});
test('missing current primary identity permits only a retained read; caller cannot switch to an unverified sender',async()=>{
 let puts=0;const f=fixture(async(_path,init)=>{if(init.method==='PUT')puts++;return response(row);},'missing@example.com');await f.client.load();assert.equal(f.client.snapshot().entry,null);f.client.edit({...changed,address:'missing@example.com'});await f.client.save();assert.equal(puts,0);f.client.dispose();
 const known=fixture(async()=>response(row));await known.client.load();known.client.edit({...changed,address:old.address});assert.deepEqual(known.client.snapshot().entry,primary);assert.equal(known.client.snapshot().dirty,false);known.client.dispose();
});
test('lost save acknowledgment blocks further PUT until read-only exact saved-value confirmation',async()=>{
 let reads=0,puts=0;const f=fixture(async(_path,init)=>{if(init.method==='PUT'){puts++;throw Error('lost');}return response(++reads===1?row:receipt);});await f.client.load();f.client.edit(changed);await f.client.save();assert.equal(f.client.snapshot().uncertain,true);assert.deepEqual(f.client.snapshot().entry,changed);await f.client.save();await f.client.load();assert.equal(puts,1);assert.equal(reads,1);await f.client.check();assert.equal(reads,2);assert.equal(puts,1);assert.equal(f.client.snapshot().uncertain,false);assert.equal(f.client.snapshot().dirty,false);assert.match(f.client.snapshot().notice,/confirmed/);f.client.dispose();
});
test('conflicting or unconfirmed server content keeps local text and requires explicit discard before a new save',async()=>{
 for(const status of [409,200]){let reads=0,puts=0;const f=fixture(async(_path,init)=>{if(init.method==='PUT'){puts++;return status===409?response({},409):response({...receipt,preferences:{identities:[primary,old]}});}reads++;return response(row);});await f.client.load();f.client.edit(changed);await f.client.save();if(status===200)await f.client.check();assert.equal(f.client.snapshot().conflict,true);assert.deepEqual(f.client.snapshot().entry,changed);await f.client.save();assert.equal(puts,1);await f.client.load(true);assert.deepEqual(f.client.snapshot().entry,primary);assert.equal(f.client.snapshot().dirty,false);assert.equal(f.client.snapshot().conflict,false);assert.ok(reads>=2);f.client.dispose();}
});
test('writes serialize, invalid local content stays visible, and held results cannot publish across session changes',async()=>{
 let resolve!:(response:Response)=>void,puts=0;const f=fixture(async(_path,init)=>{if(init.method==='PUT'){puts++;return new Promise(done=>{resolve=done;});}return response(row);});await f.client.load();f.client.edit({...changed,plain:'x'.repeat(2049)});await f.client.save();assert.equal(puts,0);assert.equal(f.client.snapshot().entry!.plain.length,2049);f.client.edit(changed);const save=f.client.save();await f.client.save();assert.equal(puts,1);f.client.edit(primary);assert.deepEqual(f.client.snapshot().entry,changed);f.end();resolve(response(receipt));await save;assert.equal(f.client.snapshot().saved!.revision,2);f.client.dispose();
});
test('fresh access denial clears all saved and edited signature content and stops future requests',async()=>{
 let calls=0;const f=fixture(async(_path,init)=>{calls++;return init.method==='PUT'?response({},403):response(row);});await f.client.load();f.client.edit(changed);await f.client.save();assert.equal(f.client.snapshot().status,'denied');assert.equal(f.client.snapshot().saved,null);assert.equal(f.client.snapshot().entry,null);await f.client.load(true);await f.client.save();assert.equal(calls,2);f.client.dispose();
});
test('oversized or held stale initial projections expose no signature content',async()=>{
 const big=fixture(async()=>new Response('x'.repeat(131073)));await big.client.load();assert.equal(big.client.snapshot().status,'failed');assert.equal(big.client.snapshot().saved,null);big.client.dispose();
 let resolve!:(response:Response)=>void;const held=fixture(()=>new Promise(done=>{resolve=done;}));const load=held.client.load();held.end();resolve(response(row));await load;assert.equal(held.client.snapshot().saved,null);held.client.dispose();
});
test('every current verified identity can be edited using account-wide CAS without dropping other or unavailable saved signatures',async()=>{
 const alias={address:'alias@example.com',identity_key:'c'.repeat(64)},catalog={...row,identity_availability:{...row.identity_availability,available:[...row.identity_availability.available!,alias]}};const entry:NativeSignatureEntry={address:alias.address,plain:'Alias text',html:'',placement:'reply'},saved={...catalog,revision:3,preferences:{identities:[primary,old,entry]},identity_availability:{...catalog.identity_availability,saved:[...catalog.identity_availability.saved,{...alias,current:true}]}};
 const calls:RequestInit[]=[];const f=fixture(async(_path,init)=>{calls.push(init);return response(init.method==='PUT'?saved:catalog);});await f.client.load();f.client.select(old.address);assert.equal(f.client.snapshot().entry!.address,primary.address);f.client.select(alias.address);assert.equal(f.client.snapshot().entry!.address,alias.address);assert.equal(f.client.snapshot().entry!.plain,'');f.client.edit(entry);f.client.select(primary.address);assert.equal(f.client.snapshot().entry!.address,alias.address);await f.client.save();assert.deepEqual(JSON.parse(calls[1]!.body as string),{expected_revision:2,identities:[entry]});assert.deepEqual(f.client.snapshot().saved!.preferences.identities,[primary,old,entry]);assert.equal(f.client.snapshot().dirty,false);f.client.select(primary.address);assert.deepEqual(f.client.snapshot().entry,primary);f.client.dispose();
});
