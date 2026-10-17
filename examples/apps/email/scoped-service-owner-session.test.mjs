import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm}from 'node:fs/promises';import {tmpdir}from 'node:os';import {join}from 'node:path';
import {createEmailSharedOwnerSession,withEmailOwnerSessionLock}from './scoped-service-owner-session.mjs';
function fixture(){let pair={accessToken:'old',refreshToken:'old-refresh'},pending=null,rotations=0,tail=Promise.resolve();const identity={id:'owner',org_id:'org',sid:'sid'};
 const ports={lock:async work=>{const before=tail;let release;tail=new Promise(done=>{release=done;});await before;try{return await work();}finally{release();}},
 read:async()=>structuredClone(pair),write:async value=>{pair=structuredClone(value);},loadPending:async()=>pending,savePending:async value=>{pending=value;},clearPending:async()=>{pending=null;},
 validate:value=>({...identity,exp:value.accessToken==='old'?1:100000}),now:()=>100000,
 rotate:async token=>{rotations++;assert.equal(token,pair.refreshToken);await new Promise(done=>setTimeout(done,10));return{accessToken:'renewed',refreshToken:'renewed-refresh'};}};
 return{ports,read:()=>pair,pending:()=>pending,count:()=>rotations};}
test('three exact managers share one rotation and every reader obtains the durable latest pair',async()=>{const f=fixture();const managers=[1,2,3].map(()=>createEmailSharedOwnerSession(f.ports));
 const pairs=await Promise.all(managers.map(manager=>manager.current()));assert.equal(f.count(),1);assert.equal(f.pending(),null);for(const pair of pairs)assert.deepEqual(pair,f.read());
 assert.deepEqual(await createEmailSharedOwnerSession(f.ports).current(),f.read());assert.equal(f.count(),1);
});
test('lost refresh response preserves previous file and restart never reuses its spent token',async()=>{const f=fixture();f.ports.rotate=async()=>{throw Error('transport-lost');};
 await assert.rejects(createEmailSharedOwnerSession(f.ports).current());assert.equal(f.read().accessToken,'old');assert.equal(f.pending().phase,'uncertain');
 let called=false;f.ports.rotate=async()=>{called=true;};await assert.rejects(createEmailSharedOwnerSession(f.ports).current(),/REFRESH_UNKNOWN/);assert.equal(called,false);
});
test('foreign identity, reused refresh and malformed response remain latched without replacing prior pair',async()=>{for(const mutate of ['foreign','reused','malformed']){const f=fixture();const validate=f.ports.validate;
 f.ports.validate=value=>{if(value.accessToken==='renewed'&&mutate==='foreign')return{...validate(value),org_id:'other'};if(mutate==='malformed'&&value.accessToken==='renewed')throw Error('invalid');return validate(value);};
 if(mutate==='reused')f.ports.rotate=async()=>({accessToken:'renewed',refreshToken:'old-refresh'});
 await assert.rejects(createEmailSharedOwnerSession(f.ports).current());assert.equal(f.read().accessToken,'old');assert.equal(f.pending().phase,'uncertain');
}});
test('kernel fd lock serializes actual processes without replacing a live lock', {skip:process.platform!=='linux'||process.getuid?.()!==0},async t=>{
 const root=await mkdtemp(join(tmpdir(),'deft-owner-lock-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'owner.lock');let release,entered;
 const held=new Promise(done=>{release=done;}),ready=new Promise(done=>{entered=done;});let second=false;
 const first=withEmailOwnerSessionLock(path,async()=>{entered();await held;});await ready;
 const next=withEmailOwnerSessionLock(path,async()=>{second=true;});await new Promise(done=>setTimeout(done,100));assert.equal(second,false);release();await Promise.all([first,next]);assert.equal(second,true);
 await withEmailOwnerSessionLock(path,async()=>assert.equal(second,true));
});
