import test from 'node:test';
import assert from 'node:assert/strict';
import {getTableName} from 'drizzle-orm';
import {PostgresEmailProviderDraftSettings,EmailProviderDraftSettingsError} from '../src/lib/email-provider-draft-settings.js';
import {EmailMailboxError} from '../src/lib/email-mailbox-service.js';
const actor={user_id:'owner',web_session_id:'sid',access_expires_at:10000},scope={org_id:'org',owner_user_id:'owner',account_id:'account'};
const denied=(error:unknown)=>error instanceof EmailMailboxError&&error.code==='EMAIL_ACCESS_DENIED';
function fixture(){
 const state={now:1000,provider:'gmail',principal:'a'.repeat(64),connection:1,caps:['read','modify'],graph:1,member:1,events:[] as string[],afterWrite:undefined as (()=>void)|undefined,afterLegacy:undefined as (()=>void)|undefined,afterRead:undefined as (()=>void)|undefined,afterPause:undefined as (()=>void)|undefined,
  row:{...scope,provider:'gmail',resource_binding_id:'binding',principal_digest:'a'.repeat(64),state:'active',revoked_at:null,consented_at:new Date(500),authority_revision:1,provider_draft_sync_enabled:false,created_at:new Date(500),updated_at:new Date(500)},mirrors:['queued','syncing','unknown']};
 const tx={select:()=>{let table='';const result=()=>table==='org_members'?[{org_id:'org',user_id:'owner',role:'member',active:true,authorization_version:state.member,kind:'human',is_agent:false}]:[{...state.row}];
  const query={from:(value:any)=>{table=getTableName(value);return query;},innerJoin:()=>query,where:()=>query,
   limit:()=>({then:(resolve:any)=>{state.events.push('account-read');const rows=result();state.afterRead?.();return Promise.resolve(rows).then(resolve);},for:async(lock:string)=>{state.events.push('account-'+lock);return result();}}),
   then:(resolve:any)=>{state.events.push('member-read');return Promise.resolve(result()).then(resolve);}};return query;},
  update:()=>({set:(values:any)=>({where:()=>({returning:async()=>{state.events.push('write');state.row={...state.row,...values};state.afterWrite?.();return [{...state.row}];}})})})};
 const database={...tx,transaction:async(run:any)=>{const row={...state.row},mirrors=[...state.mirrors];try{const result=await run(tx);state.events.push('commit');return result;}catch(error){state.row=row;state.mirrors=mirrors;state.events.push('rollback');throw error;}}} as any;
 const service=new PostgresEmailProviderDraftSettings(database,{now:()=>new Date(state.now),loadBinding:async(actual:any,input:any)=>{assert.equal(actual,tx);assert.equal(input.resource_binding_id,'binding');state.events.push('legacy');state.afterLegacy?.();return {binding:{id:'binding',org_id:'org',owner_user_id:'owner'},registration:{operator_user_id:'owner'},installation:{id:'install',epoch:state.graph},checked_at:new Date(state.now)} as any;},
  runtime:async()=>({authority:{inspect:async(actual:any,actualScope:any,operation:any,held:any)=>{assert.deepEqual(actual,actor);assert.deepEqual(actualScope,scope);if(held){assert.equal(held,tx);assert.ok(state.events.includes('account-update'));}state.events.push(operation);
   return {capability:{scope,resource_binding_id:'binding',authority_version:'version-'+state.row.authority_revision,expires_at:10000},account:{account_id:'account',provider:state.provider,resource_binding_id:'binding',authority_epoch:state.row.authority_revision,health:'connected',connection_revision:state.connection,principal_digest:state.principal,capabilities:state.caps}} as any;}}}),
  pauseQueued:async(actual:any,actualScope:any)=>{assert.equal(actual,tx);assert.deepEqual(actualScope,scope);state.events.push('pause');state.mirrors=state.mirrors.map(value=>value==='queued'?'paused':value);state.afterPause?.();},
  resumePaused:async(actual:any,actualScope:any)=>{assert.equal(actual,tx);assert.deepEqual(actualScope,scope);state.events.push('resume');state.mirrors=state.mirrors.map(value=>value==='paused'?'queued':value);}});
 return {state,service};
}
test('default off GET is fresh human-read on both sides; changing revision during read denies stale disclosure',async()=>{
 const f=fixture();assert.deepEqual(await f.service.get(actor,'org','account'),{account_id:'account',enabled:false,revision:1,supported:true});assert.deepEqual(f.state.events,['human_read','account-read','human_read']);
 f.state.afterRead=()=>{f.state.row.authority_revision++;};await assert.rejects(f.service.get(actor,'org','account'),denied);f.state.afterRead=undefined;
 f.state.row.owner_user_id='other';await assert.rejects(f.service.get(actor,'org','account'),denied);
});
test('explicit opt-in takes legacy then native UPDATE before exact human inspection and bumps authority CAS',async()=>{
 const f=fixture();assert.deepEqual(await f.service.update(actor,'org','account',{enabled:true,expected_revision:1}),{account_id:'account',enabled:true,revision:2,supported:true});
 assert.ok(f.state.events.indexOf('legacy')<f.state.events.indexOf('account-update'));assert.ok(f.state.events.indexOf('account-update')<f.state.events.indexOf('human_modify'));assert.equal(f.state.events.filter(event=>event==='human_modify').length,2);assert.ok(f.state.events.includes('resume'));
 await assert.rejects(f.service.update(actor,'org','account',{enabled:false,expected_revision:1}),(error:unknown)=>error instanceof EmailProviderDraftSettingsError&&error.code==='EMAIL_DRAFT_SYNC_CONFLICT');assert.equal(f.state.row.provider_draft_sync_enabled,true);
});
test('off toggle requires human read only, pauses queued mirrors and preserves uncertain/inflight claims',async()=>{
 const f=fixture();f.state.row.provider_draft_sync_enabled=true;f.state.caps=['read'];assert.deepEqual(await f.service.update(actor,'org','account',{enabled:false,expected_revision:1}),{account_id:'account',enabled:false,revision:2,supported:false});assert.deepEqual(f.state.mirrors,['paused','syncing','unknown']);assert.equal(f.state.events.filter(event=>event==='human_read').length,2);assert.ok(!f.state.events.includes('human_modify'));
});
test('Microsoft current modify permission supports opt-in; IMAP and missing modify remain unavailable',async()=>{
 const graph=fixture();graph.state.provider='microsoft';graph.state.row.provider='microsoft';assert.equal((await graph.service.get(actor,'org','account')).supported,true);assert.deepEqual(await graph.service.update(actor,'org','account',{enabled:true,expected_revision:1}),{account_id:'account',enabled:true,revision:2,supported:true});
 const graphMissing=fixture();graphMissing.state.provider='microsoft';graphMissing.state.row.provider='microsoft';graphMissing.state.caps=['read'];assert.equal((await graphMissing.service.get(actor,'org','account')).supported,false);await assert.rejects(graphMissing.service.update(actor,'org','account',{enabled:true,expected_revision:1}),denied);
 const f=fixture();f.state.provider='imap_smtp';f.state.row.provider='imap_smtp';assert.equal((await f.service.get(actor,'org','account')).supported,false);
 await assert.rejects(f.service.update(actor,'org','account',{enabled:true,expected_revision:1}),(error:unknown)=>error instanceof EmailProviderDraftSettingsError&&error.code==='EMAIL_DRAFT_SYNC_UNSUPPORTED');
 const missing=fixture();missing.state.caps=['read'];assert.equal((await missing.service.get(actor,'org','account')).supported,false);await assert.rejects(missing.service.update(actor,'org','account',{enabled:true,expected_revision:1}),denied);
 const noop=fixture();assert.equal((await noop.service.update(actor,'org','account',{enabled:false,expected_revision:1})).revision,1);assert.ok(!noop.state.events.includes('write'));assert.ok(!noop.state.events.includes('pause'));
});
test('late graph/member/principal/connection change and expiry roll back flag plus queued mirror transitions',async()=>{
 for(const change of ['graph','member','principal','connection','expiry']){const f=fixture();f.state.afterWrite=()=>{if(change==='graph')f.state.graph++;if(change==='member')f.state.member++;if(change==='principal')f.state.principal='b'.repeat(64);if(change==='connection')f.state.connection++;if(change==='expiry')f.state.now=10000;};
  await assert.rejects(f.service.update(actor,'org','account',{enabled:true,expected_revision:1}),denied);assert.equal(f.state.row.provider_draft_sync_enabled,false);assert.equal(f.state.row.authority_revision,1);assert.deepEqual(f.state.mirrors,['queued','syncing','unknown']);assert.equal(f.state.events.at(-1),'rollback');}
});
test('binding changes during graph wait are rejected before custody; bad/extra input does not enter SQL',async()=>{
 const f=fixture();f.state.afterLegacy=()=>{f.state.row.resource_binding_id='changed';};await assert.rejects(f.service.update(actor,'org','account',{enabled:true,expected_revision:1}),denied);assert.ok(!f.state.events.includes('human_modify'));
 const bad=fixture();await assert.rejects(bad.service.update(actor,'org','account',{enabled:true,expected_revision:1,grant_agent:true} as never));assert.deepEqual(bad.state.events,[]);
 const aborted=new AbortController();aborted.abort(Error('Stopped'));await assert.rejects(bad.service.update(actor,'org','account',{enabled:true,expected_revision:1},aborted.signal),/Stopped/);assert.deepEqual(bad.state.events,[]);
 const late=fixture(),controller=new AbortController();late.state.row.provider_draft_sync_enabled=true;late.state.afterPause=()=>controller.abort(Error('Stopped after SQL'));await assert.rejects(late.service.update(actor,'org','account',{enabled:false,expected_revision:1},controller.signal),/Stopped after SQL/);assert.equal(late.state.row.provider_draft_sync_enabled,true);assert.deepEqual(late.state.mirrors,['queued','syncing','unknown']);
});
