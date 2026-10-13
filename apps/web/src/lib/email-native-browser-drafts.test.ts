import test from 'node:test';
import assert from 'node:assert/strict';
import {checkNativeBrowserDraftSource,createNativeBrowserDraftDiscovery} from './email-native-browser-drafts';
import {emptyNativeDraft} from './email-native-drafts';
import {createNativeEmailOfflineDraftJournal,type NativeOfflineDraftDriver,type NativeOfflineDraftStoredRow,type NativeOfflineDraftMetadata,type NativeOfflineDraftSnapshot} from './email-native-offline-drafts';
const owner={orgId:'org',userId:'owner'},draftId='11111111-1111-4111-8111-111111111111';
const metadata:NativeOfflineDraftMetadata={draftId,branchId:null,localRevision:1,baseServerRevision:0,dirty:true,sendOutcome:'none',updatedAt:1};
const snapshot:NativeOfflineDraftSnapshot={...metadata,content:{...emptyNativeDraft(),body:'Crash text',bcc:'private@example.test',attachments:[{file_id:'file',filename:'private.txt',media_type:'text/plain',size_bytes:3,sha256:'a'.repeat(64)}]}};
test('orphan and conflict copies are discovered as metadata; explicit open preserves text/Bcc and drops attachment references',async()=>{
 let proofs=0,reads=0;const branchId='22222222-2222-4222-8222-222222222222';
 const discovery=createNativeBrowserDraftDiscovery({owner,checkSource:async()=>'missing',current:()=>true,prove:async()=>{proofs++;},open:async(scope,authorize)=>{assert.equal(await authorize(),true);assert.equal(scope.userId,'owner');return {listAccount:async()=>[metadata,{...metadata,branchId}],read:async()=>{reads++;return snapshot;},readConflict:async id=>{assert.equal(id,branchId);reads++;return snapshot;}};}});
 const rows=await discovery.list('account');assert.equal(rows.length,2);assert.equal(reads,0);assert.equal(proofs,1);
 const selection=await discovery.open('account',rows[1]);assert.equal(proofs,2);assert.equal(reads,1);assert.equal(selection.draftId,undefined);assert.equal(selection.initialContent?.body,'Crash text');assert.equal(selection.initialContent?.bcc,'private@example.test');assert.deepEqual(selection.initialContent?.attachments,[]);assert.equal(snapshot.content.attachments.length,1);discovery.dispose();
});
test('unknown send and metadata changed during open never produce a new compose',async()=>{
 let reads=0;const discovery=createNativeBrowserDraftDiscovery({owner,checkSource:async()=>'missing',current:()=>true,prove:async()=>{},open:async()=>({listAccount:async()=>[metadata],read:async()=>{reads++;return {...snapshot,sendOutcome:'unknown'};},readConflict:async()=>snapshot})});
 await assert.rejects(discovery.open('account',{...metadata,sendOutcome:'unknown'}));assert.equal(reads,0);await assert.rejects(discovery.open('account',metadata));assert.equal(reads,1);discovery.dispose();
});
test('denied account proof, disposed scope, and late decrypt cannot disclose private text',async()=>{
 let opened=0,current=true,resolve!:(value:NativeOfflineDraftSnapshot)=>void;const held=new Promise<NativeOfflineDraftSnapshot>(yes=>{resolve=yes;});
 const denied=createNativeBrowserDraftDiscovery({owner,checkSource:async()=>'missing',current:()=>true,prove:async()=>{throw Error('denied');},open:async()=>{opened++;throw Error('should not open');}});await assert.rejects(denied.list('account'));assert.equal(opened,0);denied.dispose();
 const discovery=createNativeBrowserDraftDiscovery({owner,checkSource:async()=>'missing',current:()=>current,prove:async()=>{},open:async()=>({listAccount:async()=>[metadata],read:()=>held,readConflict:async()=>snapshot})});
 const opening=discovery.open('account',metadata);await new Promise(resolve=>setTimeout(resolve,0));current=false;resolve(snapshot);await assert.rejects(opening);discovery.dispose();await assert.rejects(discovery.list('account'));
});
test('an eight-second-style total deadline bounds storage and invalid draft IDs are excluded',async()=>{
 const discovery=createNativeBrowserDraftDiscovery({owner,checkSource:async()=>'missing',current:()=>true,deadlineMs:5,prove:async()=>{},open:async()=>({listAccount:()=>new Promise(()=>{}),read:async()=>snapshot,readConflict:async()=>snapshot})});await assert.rejects(discovery.list('account'));discovery.dispose();
 const bounded=createNativeBrowserDraftDiscovery({owner,checkSource:async()=>'missing',current:()=>true,prove:async()=>{},open:async()=>({listAccount:async()=>[metadata,{...metadata,draftId:'not-a-draft'}],read:async()=>snapshot,readConflict:async()=>snapshot})});assert.equal((await bounded.list('account')).length,1);bounded.dispose();
});
test('agent provenance, changed server lifecycle, and a previously saved source missing now block new copies',async()=>{
 for(const source of ['agent','blocked','missing'] as const){let reads=0;const discovery=createNativeBrowserDraftDiscovery({owner,current:()=>true,prove:async()=>{},checkSource:async()=>source,open:async()=>({listAccount:async()=>[metadata],read:async()=>{reads++;return snapshot;},readConflict:async()=>snapshot})});await assert.rejects(discovery.open('account',{...metadata,baseServerRevision:4}),source==='agent'?/agent draft/:/sending status/);assert.equal(reads,0);discovery.dispose();}
});
test('real source check performs GETs only and fails closed on legacy/outbox uncertainty and agent provenance',async()=>{
 const source={draft_id:draftId,revision:4,status:'draft',content:emptyNativeDraft(),origin:{kind:'human',created_by_user_id:'owner',originating_run_id:null},last_edited_by_user_id:'owner',created_at:'2026-10-04T00:00:00.000Z',updated_at:'2026-10-04T00:00:00.000Z'};
 for(const mode of ['idle','legacy-uncertain','outbox-uncertain','agent','submitted','missing'] as const){const calls:string[]=[];
  const result=await checkNativeBrowserDraftSource('account',draftId,{current:()=>true,fetch:async(path,init)=>{assert.equal(init.method,'GET');calls.push(path);if(path.endsWith('/'+draftId))return mode==='missing'?Response.json({code:'EMAIL_DRAFT_NOT_FOUND'},{status:404}):Response.json({...source,...(mode==='agent'?{origin:{...source.origin,kind:'agent'}}:{}),...(mode==='submitted'?{status:'submitted'}:{})});if(mode==='outbox-uncertain'&&path.includes('/outbox/'))throw Error('held outcome');if(mode==='legacy-uncertain'&&path.includes('/send/'))throw Error('held outcome');return Response.json({operation:null});}},new AbortController().signal);
  assert.equal(result,mode==='idle'?'human':mode==='agent'?'agent':mode==='missing'?'missing':'blocked');assert.equal(calls.length,mode==='idle'||mode==='legacy-uncertain'?3:mode==='outbox-uncertain'?2:1);
 }
});
test('real encrypted journal orphan and CAS branch survive discovery without exposing another owner',async()=>{
 const rows=new Map<string,NativeOfflineDraftStoredRow>(),keys=new Map<string,CryptoKey>();
 const driver:NativeOfflineDraftDriver={deviceId:async()=>draftId,key:async(owner,create)=>{const key=keys.get(owner)??await create();keys.set(owner,key);return key;},read:async id=>rows.get(id)??null,list:async owner=>[...rows.values()].filter(row=>row.owner===owner),commit:async input=>{if((rows.get(input.headId)?.localRevision??0)!==input.expectedRevision){rows.set(input.conflict.id,input.conflict);return 'conflict_saved';}rows.set(input.headId,input.head);return 'saved';},remove:async()=>false};
 const scope={...owner,accountId:'account',draftId};
 const writer=await createNativeEmailOfflineDraftJournal(scope,{authorize:()=>true,driver});await writer.put({expectedLocalRevision:0,baseServerRevision:0,content:{...emptyNativeDraft(),body:'Original encrypted text',bcc:'private@example.test'}});
 await assert.rejects(writer.put({expectedLocalRevision:0,baseServerRevision:0,content:{...emptyNativeDraft(),body:'Other tab branch',bcc:'private@example.test'}}));
 const discovery=createNativeBrowserDraftDiscovery({owner,current:()=>true,prove:async()=>{},checkSource:async()=> 'missing',open:(scope,authorize)=>createNativeEmailOfflineDraftJournal(scope,{authorize,driver})});const metadata=await discovery.list('account');assert.equal(metadata.length,2);const branch=metadata.find(row=>row.branchId)!;assert.ok(branch);assert.equal((await discovery.open('account',branch)).initialContent?.body,'Other tab branch');assert.equal((await discovery.open('account',metadata.find(row=>!row.branchId)!)).initialContent?.body,'Original encrypted text');
 assert.equal([...rows.values()].some(row=>new TextDecoder().decode(row.ciphertext).includes('private@example.test')),false);
 const other=createNativeBrowserDraftDiscovery({owner:{...owner,userId:'other-owner'},current:()=>true,prove:async()=>{},checkSource:async()=> 'missing',open:(scope,authorize)=>createNativeEmailOfflineDraftJournal(scope,{authorize,driver})});assert.deepEqual(await other.list('account'),[]);other.dispose();discovery.dispose();
});
