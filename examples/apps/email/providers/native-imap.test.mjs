import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeImapBridge,NATIVE_IMAP_STATE_KEY,NATIVE_IMAP_LIMITS} from './native-imap.mjs';

const message=(uid,modseq=1,flags=[])=>({uid,modseq,flags:new Set(flags),envelope:{subject:'Synthetic '+uid,from:[{address:'synthetic@example.test'}],to:[{address:'owner@example.test'}],messageId:'same-message-id@example.test'},internalDate:new Date('2026-10-01T00:00:00Z'),size:123});
function fixture({condstore=true,folders}={}){
 const boxes=new Map(Object.entries(folders??{INBOX:{validity:'7',modseq:1,next:8,rows:[message(1),message(7)]},'Localized Sent':{validity:'8',modseq:1,next:2,specialUse:'\\Sent',rows:[message(1)]},'Private Work':{validity:'9',modseq:1,next:1,rows:[]}}));
 const states=new Map(),cached=new Map(),calls={connect:0,list:0,locks:[],search:[],fetch:[],released:0,cleanup:0},account={org_id:'org',owner_user_id:'owner',installation_id:'install',account_id:'account',provider:'imap_smtp',resource_binding_id:'binding',authority_epoch:1,connection_revision:1,principal_digest:'a'.repeat(64),health:'connected',capabilities:['read'],primary_address:'owner@example.test',display_label:'Synthetic IMAP'};
 let fetching=false,afterFetch=null,afterLock=null,folderFailure=null,listedOverride=null;
 const client={secureConnection:true,authenticated:'verified-user',enabled:new Set(condstore?['CONDSTORE']:[]),
  async list(){assert.equal(fetching,false);calls.list++;return listedOverride??[...boxes].map(([path,box])=>({path,specialUse:box.specialUse,flags:new Set()}));},
  async getMailboxLock(path,options){assert.equal(fetching,false);assert.deepEqual(options,{readOnly:true});calls.locks.push(path);
   if(folderFailure?.path===path)throw folderFailure.error;
   const box=boxes.get(path);if(!box){const error=Error('Command failed');error.responseStatus='NO';error.response={attributes:[{type:'SECTION',section:[{value:'NONEXISTENT'}]}]};throw error;}
   this.mailbox={path,uidValidity:BigInt(box.validity),uidNext:box.next,exists:box.rows.length,highestModseq:BigInt(box.modseq),readOnly:true};
   const lock={release(){calls.released++;}};afterLock?.();return lock;
  },
  async search(query,options){assert.equal(fetching,false);assert.deepEqual(options,{uid:true});calls.search.push({path:this.mailbox.path,query});
   const ranges=query.uid.split(',').map(value=>value.split(':').map(Number)),box=boxes.get(this.mailbox.path);
   return box.rows.filter(row=>ranges.some(([low,high])=>row.uid>=low&&row.uid<=(high??low))&&(query.modseq===undefined||BigInt(row.modseq)>=query.modseq)).map(row=>row.uid);
  },
  async *fetch(range,query,options){assert.equal(fetching,false);fetching=true;calls.fetch.push({path:this.mailbox.path,range,query,options});
   try{assert.deepEqual(query,{uid:true,envelope:true,flags:true,size:true,internalDate:true});assert.deepEqual(options,{uid:true});const ids=range.split(',').map(Number);assert.ok(ids.length<=100);assert.ok(!range.includes('*'));
    for(const row of boxes.get(this.mailbox.path).rows.filter(row=>ids.includes(row.uid)))yield structuredClone(row);
   }finally{fetching=false;const callback=afterFetch;afterFetch=null;callback?.();}
  },close(){},
 };
 const context={org_id:'org',owner_user_id:'owner',installation_id:'install',account_id:'account',resource_binding_id:'binding',authority_version:'current-authority',expires_at:Date.now()+600000,recheck:async()=>{},
  provider_state:{async read(key){return structuredClone(states.get(key)??null);},async stale(generation,after,limit){return [...cached.values()].filter(row=>row.inventory_generation!==generation&&(!after||row.logical_message_id>after)).sort((a,b)=>a.logical_message_id.localeCompare(b.logical_message_id)).slice(0,limit).map(row=>({logical_message_id:row.logical_message_id,provider_source:structuredClone(row.provider_source)}));}},
 };
 const host={async current(){return structuredClone(account);},async withAuthorizedClient(_context,expected,work){assert.equal(expected.principal_digest,account.principal_digest);calls.connect++;try{return await work(client);}finally{calls.cleanup++;}}};
 const bridge=()=>createNativeImapBridge({host});let cursor=null;
 const commit=page=>{
  for(const row of page.state_updates){assert.ok(Buffer.byteLength(JSON.stringify(row.value))<=65536);assert.match(row.state_key,/^[a-f0-9]{64}$/);states.set(row.state_key,{...structuredClone(row),storage_revision:(states.get(row.state_key)?.storage_revision??0)+1});}
  for(const row of page.items)cached.set(row.logical_message_id,structuredClone(row));for(const id of page.tombstones)cached.delete(id);cursor=page.next_cursor;
 };
 const page=async(instance=bridge(),limit=3)=>{const result=await instance.nativeEmailPage({cursor,limit},context);assert.ok(result.items.length<=limit);assert.ok(result.tombstones.length<=limit);assert.ok(result.state_updates.length<=8);assert.equal(result.has_more,!result.complete);commit(result);return result;};
 const cycle=async(instance=bridge(),limit=3)=>{const pages=[];for(let step=0;step<250;step++){const result=await page(instance,limit);pages.push(result);if(result.complete)return pages;}throw Error('Fixture did not converge');};
 return {boxes,states,cached,calls,account,context,client,bridge,page,cycle,commit,get cursor(){return cursor;},set afterFetch(value){afterFetch=value;},set afterLock(value){afterLock=value;},set folderFailure(value){folderFailure=value;},set listedOverride(value){listedOverride=value;}};
}

test('native IMAP restarts from persisted all-folder state, maps special-use roles, and skips unchanged CONDSTORE headers',async()=>{
 const f=fixture();await f.page();await f.cycle(f.bridge());assert.equal(f.cached.size,3);
 assert.deepEqual([...f.cached.values()].map(row=>row.folders[0]).sort(),['inbox','inbox','sent']);
 const generation=f.states.get(NATIVE_IMAP_STATE_KEY).generation,fetches=f.calls.fetch.length;await f.cycle(f.bridge());
 assert.equal(f.states.get(NATIVE_IMAP_STATE_KEY).generation,generation);assert.equal(f.calls.fetch.length,fetches);
 assert.equal(f.calls.cleanup,f.calls.connect);assert.equal(f.calls.released,f.calls.locks.length);
 assert.ok(f.calls.fetch.every(call=>!Object.hasOwn(call.query,'source')&&!Object.hasOwn(call.query,'bodyStructure')));
});

test('native IMAP bounded UID gaps and flag/addition/expunge changes converge without merging same Message-ID across folders',async()=>{
 const f=fixture({folders:{INBOX:{validity:'7',modseq:1,next:20002,rows:[message(1),message(20001)]},Other:{validity:'9',modseq:1,next:2,rows:[message(1)]}}});
 await f.cycle();assert.equal(f.cached.size,3);assert.ok(f.calls.search.filter(call=>call.query.uid.includes(':')).every(call=>{const [a,b]=call.query.uid.split(':').map(Number);return b-a<4096;}));
 const old=[...f.cached.values()].find(row=>row.provider_source.locator.mailbox==='INBOX'&&row.provider_source.locator.uid===1),box=f.boxes.get('INBOX');
 box.rows=[message(20001,2,['\\Seen','\\Flagged']),message(20002,2)];box.next=20003;box.modseq=2;
 await f.cycle(f.bridge());assert.equal(f.cached.has(old.logical_message_id),false);assert.equal(f.cached.size,3);
 const flagged=[...f.cached.values()].find(row=>row.provider_source.locator.uid===20001);assert.equal(flagged.flags.seen,true);assert.equal(flagged.flags.flagged,true);
 assert.equal(new Set([...f.cached.keys()]).size,3);assert.ok(f.calls.search.some(call=>call.query.modseq===2n));
});

test('UIDVALIDITY reset deletes only the old folder epoch, never the same UID in another folder',async()=>{
 const f=fixture();await f.cycle();const before=[...f.cached.values()],other=before.find(row=>row.folders.includes('sent'));
 const oldInbox=before.filter(row=>row.folders.includes('inbox')),box=f.boxes.get('INBOX');box.validity='99';box.modseq=1;box.rows=[message(1)];box.next=2;
 await f.cycle(f.bridge());assert.equal(f.cached.has(other.logical_message_id),true);assert.ok(oldInbox.every(row=>!f.cached.has(row.logical_message_id)));
 assert.equal([...f.cached.values()].filter(row=>row.folders.includes('inbox')).length,1);assert.equal(f.cached.size,2);
});

test('a message expunged after its inventory upsert is reconciled before first complete',async()=>{
 const f=fixture({folders:{INBOX:{validity:'7',modseq:1,next:2,rows:[message(1)]}}});
 f.afterFetch=()=>{const box=f.boxes.get('INBOX');box.rows=[];box.modseq=2;};await f.cycle();assert.equal(f.cached.size,0);
});

test('folder deletion requires explicit NONEXISTENT and a generic folder failure does not commit or delete',async()=>{
 const f=fixture();await f.cycle();const sent=[...f.cached.values()].find(row=>row.folders.includes('sent'));
 f.folderFailure={path:'Localized Sent',error:Object.assign(Error('Synthetic denied'),{responseStatus:'NO'})};
 await f.page();const before=structuredClone(f.states.get(NATIVE_IMAP_STATE_KEY));
 await assert.rejects(f.page(),/Synthetic denied/);assert.deepEqual(f.states.get(NATIVE_IMAP_STATE_KEY),before);assert.equal(f.cached.has(sent.logical_message_id),true);
 f.folderFailure=null;f.boxes.delete('Localized Sent');await f.cycle();assert.equal(f.cached.has(sent.logical_message_id),false);assert.equal(f.cached.size,2);
});

test('native IMAP authority and principal/generation changes deny held I/O and do not expose credentials',async()=>{
 for(const mutation of [f=>{f.account.health='revoked';},f=>{f.account.connection_revision++;},f=>{f.account.principal_digest='b'.repeat(64);}]){
  const f=fixture();const status=await f.bridge().nativeEmailAccount(f.context);assert.equal(status.provider,'imap_smtp');assert.equal(f.calls.connect,0);assert.equal(Object.hasOwn(status,'password'),false);
  f.afterFetch=()=>mutation(f);await assert.rejects(f.page(),/EMAIL_NATIVE_AUTHORITY_DENIED/);assert.equal(f.states.size,0);assert.equal(f.cached.size,0);assert.equal(f.calls.cleanup,1);assert.equal(f.calls.released,1);
 }
 const cross=fixture();await assert.rejects(cross.bridge().nativeEmailAccount({...cross.context,owner_user_id:'another'}),/EMAIL_NATIVE_AUTHORITY_DENIED/);assert.equal(cross.calls.connect,0);
});

test('TLS, read-only mailbox, fresh scope and replayed cursor are mandatory',async()=>{
 const f=fixture();f.client.secureConnection=false;await assert.rejects(f.page(),/EMAIL_NATIVE_IMAP_TLS_REQUIRED/);assert.equal(f.states.size,0);
 f.client.secureConnection=true;await f.page();const stale=null;await assert.rejects(f.bridge().nativeEmailPage({cursor:stale,limit:3},f.context),/EMAIL_NATIVE_STATE_CONFLICT/);
 f.afterLock=()=>{f.account.health='revoked';};await assert.rejects(f.page(),/EMAIL_NATIVE_AUTHORITY_DENIED/);assert.equal(f.calls.released,f.calls.locks.length);
 const expired=fixture();await assert.rejects(expired.bridge().nativeEmailAccount({...expired.context,expires_at:Date.now()-1}),/EMAIL_NATIVE_AUTHORITY_DENIED/);
});

test('non-CONDSTORE servers rescan flags while malformed inventory never advances state',async()=>{
 const f=fixture({condstore:false});await f.cycle();const box=f.boxes.get('INBOX');box.rows[0].flags.add('\\Seen');const before=f.calls.fetch.length;
 await f.cycle();assert.ok(f.calls.fetch.length>before);assert.equal([...f.cached.values()].find(row=>row.provider_source.locator.mailbox==='INBOX'&&row.provider_source.locator.uid===1).flags.seen,true);
 const invalid=fixture();invalid.listedOverride=Array.from({length:NATIVE_IMAP_LIMITS.folders+1},(_,i)=>({path:String(i),flags:new Set()}));
 await assert.rejects(invalid.page(),/EMAIL_PROVIDER_RESPONSE_LIMIT/);assert.equal(invalid.states.size,0);
});

test('a short metadata FETCH after successful UID SEARCH cannot certify coverage or delete',async()=>{
 const f=fixture();f.client.fetch=async function*(){};
 await assert.rejects(f.page(),/EMAIL_NATIVE_IMAP_FETCH_INCOMPLETE/);assert.equal(f.states.size,0);assert.equal(f.cached.size,0);
 const revoked=fixture();revoked.account.password='must-never-appear';await assert.rejects(revoked.bridge().nativeEmailAccount(revoked.context),/EMAIL_NATIVE_AUTHORITY_DENIED/);
});
