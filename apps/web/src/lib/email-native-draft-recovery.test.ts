import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeDraftRecovery} from './email-native-draft-recovery';
import {emptyNativeDraft,type NativeDraftSaveState} from './email-native-drafts';
import type {NativeOfflineDraftSnapshot} from './email-native-offline-drafts';
import {createNativeEmailOfflineDraftJournal,type NativeOfflineDraftDriver,type NativeOfflineDraftStoredRow} from './email-native-offline-drafts';
const scope={orgId:'org',userId:'owner',accountId:'one',draftId:'11111111-1111-4111-8111-111111111111'};
const editor=(body='',revision=4,dirty=false):NativeDraftSaveState=>({content:{...emptyNativeDraft(),body},revision,dirty,state:'idle',notice:''});
const local=(body='offline',base=4):NativeOfflineDraftSnapshot=>({content:{...emptyNativeDraft(),body},baseServerRevision:base,localRevision:2,dirty:true,sendOutcome:'none',updatedAt:1});
const held=<T>()=>{let resolve!:(value:T)=>void;return {promise:new Promise<T>(yes=>{resolve=yes;}),resolve};};
test('reads before writes and explicitly restores only the same untouched server revision',async()=>{
 const writes:unknown[]=[];const recovery=createNativeDraftRecovery({scope,current:()=>true,prove:async()=>{},open:async()=>({read:async()=>local(),put:async input=>{writes.push(input);return {...local(),localRevision:3};}}),change:()=>{}});
 await recovery.start(editor('server'));recovery.record(editor('typed',4,true));await recovery.settled();assert.equal(writes.length,0);
 assert.equal(recovery.restore(editor('typed',4,true)),null);assert.equal(recovery.restore(editor('server',5)),null);
 assert.equal(recovery.restore(editor('server'))?.body,'offline');recovery.record(editor('offline',4,true));await recovery.settled();assert.equal(writes.length,1);recovery.dispose();
});
test('typing during held storage survives and writes are serialized using acknowledged local CAS',async()=>{
 const read=held<null>(),first=held<NativeOfflineDraftSnapshot>();const writes:{body:string;cas:number;base:number}[]=[];
 const recovery=createNativeDraftRecovery({scope,current:()=>true,prove:async()=>{},open:async()=>({read:()=>read.promise,put:async input=>{writes.push({body:input.content.body,cas:input.expectedLocalRevision,base:input.baseServerRevision});return writes.length===1?first.promise:{...local(input.content.body),localRevision:2};}}),change:()=>{}});
 const bootstrap=recovery.start(editor());recovery.record(editor('first',4,true));read.resolve(null);await new Promise(resolve=>setTimeout(resolve,0));
 recovery.record(editor('new typing',5,true));assert.equal(writes.length,1);first.resolve({...local('first'),localRevision:1});await bootstrap;await recovery.settled();
 assert.deepEqual(writes,[{body:'first',cas:0,base:4},{body:'new typing',cas:1,base:5}]);recovery.dispose();
});
test('unknown Send copy cannot be restored or silently overwritten',async()=>{
 let writes=0;const recovery=createNativeDraftRecovery({scope,current:()=>true,prove:async()=>{},open:async()=>({read:async()=>({...local(),sendOutcome:'unknown'}),put:async()=>{writes++;return local();}}),change:()=>{}});
 await recovery.start(editor());assert.equal(recovery.restore(editor()),null);recovery.record(editor('edited',4,true));await recovery.settled();assert.equal(writes,0);recovery.keepCurrent();assert.equal(recovery.snapshot().candidate,null);recovery.dispose();
});
test('scope revoked during crypto cannot expose a late recovery or start writing',async()=>{
 let current=true,changes=0,writes=0;const read=held<NativeOfflineDraftSnapshot>();const recovery=createNativeDraftRecovery({scope,current:()=>current,prove:async()=>{},open:async()=>({read:()=>read.promise,put:async()=>{writes++;return local();}}),change:()=>{changes++;}});
 const bootstrap=recovery.start(editor());await new Promise(resolve=>setTimeout(resolve,0));current=false;read.resolve(local());await bootstrap;
 assert.equal(changes,0);assert.equal(writes,0);assert.equal(recovery.snapshot().candidate,null);recovery.dispose();
});
test('one bootstrap deadline bounds a held storage open and late result stays unusable',async()=>{
 const open=held<{read:()=>Promise<NativeOfflineDraftSnapshot>;put:()=>Promise<NativeOfflineDraftSnapshot>}>();let writes=0;
 const recovery=createNativeDraftRecovery({scope,current:()=>true,prove:async()=>{},deadlineMs:5,open:()=>open.promise,change:()=>{}});
 await recovery.start(editor());assert.equal(recovery.snapshot().checking,false);assert.equal(recovery.snapshot().status,'unavailable');
 open.resolve({read:async()=>local(),put:async()=>{writes++;return local();}});await new Promise(resolve=>setTimeout(resolve,0));recovery.record(editor('current typing',4,true));await recovery.settled();assert.equal(writes,0);assert.equal(recovery.restore(editor()),null);recovery.dispose();
});
test('lease expiry pauses local writes without discarding pending typing, revalidation resumes',async()=>{
 let now=0,writes=0;const recovery=createNativeDraftRecovery({scope,current:()=>true,now:()=>now,leaseMs:10,prove:async()=>{},open:async()=>({read:async()=>null,put:async input=>{writes++;return {...local(input.content.body),localRevision:writes};}}),change:()=>{}});
 await recovery.start(editor());now=11;recovery.record(editor('kept',4,true));await recovery.settled();assert.equal(writes,0);assert.equal(recovery.snapshot().status,'paused');await recovery.revalidate();assert.equal(writes,1);recovery.dispose();
});
test('quota or unsupported storage leaves online editor unblocked',async()=>{
 const recovery=createNativeDraftRecovery({scope,current:()=>true,prove:async()=>{},open:async()=>{throw Error('storage unavailable');},change:()=>{}});
 await recovery.start(editor());assert.equal(recovery.snapshot().checking,false);assert.equal(recovery.snapshot().candidate,null);assert.equal(recovery.snapshot().status,'unavailable');recovery.dispose();
});
test('real encrypted journal and recovery coordinator reopen the known draft without replacing server text',async()=>{
 const rows=new Map<string,NativeOfflineDraftStoredRow>(),keys=new Map<string,CryptoKey>();
 const driver:NativeOfflineDraftDriver={deviceId:async()=>scope.draftId,key:async(owner,create)=>{const key=keys.get(owner)??await create();keys.set(owner,key);return key;},read:async id=>rows.get(id)??null,list:async owner=>[...rows.values()].filter(row=>row.owner===owner),commit:async input=>{if((rows.get(input.headId)?.localRevision??0)!==input.expectedRevision)return 'conflict_capacity';rows.set(input.headId,input.head);return 'saved';},remove:async()=>false};
 const open=(authorize:()=>boolean)=>createNativeEmailOfflineDraftJournal(scope,{authorize,driver});
 const first=createNativeDraftRecovery({scope,current:()=>true,prove:async()=>{},open,change:()=>{}});await first.start(editor('server'));first.record(editor('Local private text',4,true));await first.settled();first.dispose();
 assert.equal(rows.size,1);assert.equal(new TextDecoder().decode([...rows.values()][0]!.ciphertext).includes('Local private text'),false);assert.equal([...keys.values()][0]!.extractable,false);
 const reopened=createNativeDraftRecovery({scope,current:()=>true,prove:async()=>{},open,change:()=>{}});const remote=editor('server');await reopened.start(remote);assert.equal(remote.content.body,'server');assert.equal(reopened.snapshot().candidate?.content.body,'Local private text');assert.equal(reopened.restore(remote)?.body,'Local private text');reopened.dispose();
});
test('normal online lease renewal is coalesced and preserves local saves beyond five minutes',async()=>{
 let now=0,proofs=0,writes=0;const proof=held<void>();
 const recovery=createNativeDraftRecovery({scope,current:()=>true,now:()=>now,leaseMs:300000,prove:async()=>{proofs++;if(proofs>1)await proof.promise;},open:async()=>({read:async()=>null,put:async input=>{writes++;return {...local(input.content.body),localRevision:writes};}}),change:()=>{}});
 await recovery.start(editor());now=240000;const one=recovery.revalidate(),two=recovery.revalidate();assert.equal(proofs,2);proof.resolve();await Promise.all([one,two]);now=310000;recovery.record(editor('typing beyond five minutes',4,true));await recovery.settled();assert.equal(writes,1);assert.equal(recovery.snapshot().status,'saved');recovery.dispose();
});

test('reconnect retries a failed bootstrap and discovers the retained browser draft before writes',async()=>{
 let proofs=0,writes=0;
 const recovery=createNativeDraftRecovery({scope,current:()=>true,prove:async()=>{if(++proofs===1)throw Error('offline');},open:async()=>({read:async()=>local('retained browser text'),put:async()=>{writes++;return local();}}),change:()=>{}});
 await recovery.start(editor('server'));recovery.record(editor('new typing',4,true));
 await recovery.revalidate(true,editor('server'));
 assert.equal(recovery.snapshot().candidate?.content.body,'retained browser text');assert.equal(writes,0);recovery.dispose();
});

test('reconnect bootstrap is coalesced and resumes the latest typing when no recovery copy exists',async()=>{
 let proofs=0,writes=0;const proof=held<void>();
 const recovery=createNativeDraftRecovery({scope,current:()=>true,prove:async()=>{if(++proofs===1)throw Error('offline');await proof.promise;},open:async()=>({read:async()=>null,put:async input=>{writes++;assert.equal(input.content.body,'latest typing');return {...local(input.content.body),localRevision:1};}}),change:()=>{}});
 await recovery.start(editor('server'));recovery.record(editor('first typing',4,true));
 const one=recovery.revalidate(true,editor('server')),two=recovery.revalidate(true,editor('server'));
 assert.equal(one,two);assert.equal(recovery.snapshot().checking,true);assert.equal(proofs,2);recovery.record(editor('latest typing',4,true));proof.resolve();await one;await recovery.settled();assert.equal(writes,1);recovery.dispose();
});
test('keep current preserves the earlier recovery copy through focus and reconnect checks',async()=>{
 let proofs=0,writes=0;
 const recovery=createNativeDraftRecovery({scope,current:()=>true,prove:async()=>{proofs++;},open:async()=>({read:async()=>local(),put:async()=>{writes++;return local();}}),change:()=>{}});
 await recovery.start(editor('server'));recovery.keepCurrent();recovery.record(editor('new text',4,true));await recovery.revalidate(true,editor('new text',4,true));assert.equal(proofs,1);assert.equal(writes,0);assert.equal(recovery.snapshot().status,'paused');recovery.dispose();
});
