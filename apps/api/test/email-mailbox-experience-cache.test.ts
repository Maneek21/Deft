import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeEmailMailboxExperienceCache, getNativeEmailMailboxExperiencePage } from '../src/lib/email-mailbox-experience-cache.js';
import { NATIVE_EMAIL_CACHE_CURSOR_PREFIX } from '../src/lib/app-experience-provider-browse.js';
import type { AppConnectionProjection } from '../src/lib/app-connection-contract.js';
import type { EmailCachedPage, EmailScope, EmailListRequest } from '../src/lib/email-mailbox-service.js';

function fixture(){
  const logical='mail_'+'a'.repeat(64),conversation='conversation_'+'b'.repeat(64);
  const caller={org_id:'org',user_id:'owner',sid:'sid',access_expires_at:10000};
  const projection:AppConnectionProjection={org_id:'org',owner_user_id:'owner',web_session_id:'sid',resource_binding_id:'binding',installation_id:'app',app_version_id:'version',grant_snapshot_id:'grant',target_key:'personal',resource_key:'inbox',purpose:'browse_resource',allowed_operations:['list_summary'],expires_at:9000,action_key:null,action_binding_id:null,experience_session_id:'session',runtime_registration_id:'registration',descriptor_digest:'digest',lifecycle_epoch:1,grant_epoch:1,runtime_epoch:1,checked_at:1000};
  const row={account:{org_id:'org',owner_user_id:'owner',account_id:'account',resource_binding_id:'binding',provider:'gmail',principal_digest:'a'.repeat(64)},binding:{id:'binding',org_id:'org',owner_user_id:'owner',app_installation_id:'app',app_version_id:'version',grant_snapshot_id:'grant',target_key:'personal',resource_key:'inbox'}};
  const state={now:1000,rows:[row],inspections:0,reads:0,lookup:0,held:async()=>{},seenCursor:null as string|null,
    capability:{scope:{org_id:'org',owner_user_id:'owner',account_id:'account'},resource_binding_id:'binding',authority_version:'version',expires_at:9000},
    account:{account_id:'account',resource_binding_id:'binding',provider:'gmail',principal_digest:'a'.repeat(64),health:'connected',capabilities:['read'],authority_epoch:7,connection_revision:3,primary_address:'private@example.test',display_label:'Private'},
    page:{account_id:'account',items:[{account_id:'account',logical_message_id:logical,revision:'r1',received_at:null,flags:{seen:true,flagged:false,answered:false},folders:['inbox'],
      data:{account_id:'account',provider:'gmail',logical_message_id:logical,conversation_id:conversation,subject:'Cached subject'},
      provider_source:{schema_version:'deft.email_provider_source.v1',account_id:'account',provider:'gmail',logical_message_id:logical,conversation_id:conversation,authority_epoch:1,locator:{message_id:'private-provider-id'}}}],
      next_cursor:'private-native-cursor',observed_at:new Date(500).toISOString(),fresh_until:new Date(5000).toISOString(),coverage:'complete',exact_total:11,sync_state:'idle',checkpoint_revision:2} as {-readonly[K in keyof EmailCachedPage]:EmailCachedPage[K]}};
  const query={from(){return query;},innerJoin(){return query;},where(){return query;},limit(value:number){assert.equal(value,2);return query;},then(resolve:(value:unknown)=>unknown){return Promise.resolve(structuredClone(state.rows)).then(resolve);}};
  const cache=new NativeEmailMailboxExperienceCache({select(){state.lookup++;return query;}} as unknown as ConstructorParameters<typeof NativeEmailMailboxExperienceCache>[0],async actor=>{
    assert.deepEqual(actor,{user_id:'owner',web_session_id:'sid',access_expires_at:10000});
    return {authority:{inspect:async()=>{state.inspections++;return structuredClone({capability:state.capability,account:state.account});}},store:{readPage:async(scope:EmailScope,input:EmailListRequest)=>{
      state.reads++;assert.equal(scope.account_id,'account');assert.equal(input.folder,'inbox');assert.equal(input.limit,10);state.seenCursor=input.cursor;const page=structuredClone(state.page);await state.held();return page;
    }}} as unknown as Awaited<ReturnType<ConstructorParameters<typeof NativeEmailMailboxExperienceCache>[1]>>;
  },()=>state.now);
  const read=async(cursor:string|null=null,signal=new AbortController().signal)=>{const result=await cache.read({caller,projection,folder:'inbox',cursor,limit:10},signal);if(!result)return null;await result.recheck();return result.page;};
  return {state,read,caller,projection,cache};
}

test('fresh complete cache returns private source with current verified epoch using exactly two status inspections',async()=>{
  const f=fixture(),page=await f.read();assert.equal(page?.items[0]?.provider_source.authority_epoch,7);
  assert.equal(f.state.page.items[0]!.provider_source.authority_epoch,1,'stored source stays immutable');
  assert.equal(page?.next_cursor,NATIVE_EMAIL_CACHE_CURSOR_PREFIX+'private-native-cursor');assert.equal(page?.complete,false);
  assert.equal(page?.count.exact_total,null);assert.equal(f.state.inspections,2);assert.equal(f.state.reads,1);
  f.state.page.next_cursor=null;assert.equal((await f.read())?.complete,true);
});

test('unenrolled or initial stale/partial cache falls back while provider continuation skips native work',async()=>{
  for(const kind of ['unenrolled','stale','partial']){const f=fixture();if(kind==='unenrolled')f.state.rows=[];if(kind==='stale')f.state.page.fresh_until=new Date(1000).toISOString();if(kind==='partial')f.state.page.coverage='partial';assert.equal(await f.read(),null,kind);}
  const f=fixture();assert.equal(await f.read('private-provider-cursor'),null);assert.equal(f.state.lookup,0);assert.equal(f.state.inspections,0);assert.equal(f.state.reads,0);
});

test('native continuations cannot downgrade to provider traversal when enrollment, coverage or freshness expires',async()=>{
  for(const kind of ['unenrolled','stale','partial','empty']){const f=fixture();if(kind==='unenrolled')f.state.rows=[];if(kind==='stale')f.state.page.fresh_until=new Date(1000).toISOString();if(kind==='partial')f.state.page.coverage='partial';await assert.rejects(f.read(NATIVE_EMAIL_CACHE_CURSOR_PREFIX+(kind==='empty'?'':'sealed-cursor')),/EMAIL_ACCESS_DENIED/,kind);}
  const f=fixture();await f.read(NATIVE_EMAIL_CACHE_CURSOR_PREFIX+'sealed-cursor');assert.equal(f.state.seenCursor,'sealed-cursor');
});

test('revocation, reconnect epoch, principal, authority and expiry changes across held cache reads deny',async()=>{
  for(const kind of ['disconnect','epoch','principal','authority','expiry','connection']){const f=fixture();f.state.held=async()=>{
    if(kind==='disconnect')f.state.account.health='revoked';if(kind==='epoch')f.state.account.authority_epoch++;
    if(kind==='principal')f.state.account.principal_digest='b'.repeat(64);if(kind==='authority')f.state.capability.authority_version='changed';
    if(kind==='expiry')f.state.now=9000;if(kind==='connection')f.state.account.connection_revision++;
  };await assert.rejects(f.read(),/EMAIL_ACCESS_DENIED/,kind);}
});

test('foreign enrollment, ambiguous binding or mismatched cached account/provider/logical/source identity fails closed',async()=>{
  for(const kind of ['owner','installation','ambiguous','source-account','source-provider','source-logical','data-account','data-logical','duplicate']){
    const f=fixture(),m=f.state.page.items[0]!;
    if(kind==='owner')f.state.rows[0]!.account.owner_user_id='foreign';if(kind==='installation')f.state.rows[0]!.binding.app_installation_id='foreign';if(kind==='ambiguous')f.state.rows.push(structuredClone(f.state.rows[0]!));
    if(kind==='source-account')m.provider_source.account_id='foreign';if(kind==='source-provider')m.provider_source.provider='microsoft';if(kind==='source-logical')m.provider_source.logical_message_id='mail_'+'c'.repeat(64);
    if(kind==='data-account')m.data.account_id='foreign';if(kind==='data-logical')m.data.logical_message_id='mail_'+'c'.repeat(64);if(kind==='duplicate')f.state.page.items.push(structuredClone(m));
    await assert.rejects(f.read(),/EMAIL_ACCESS_DENIED/,kind);
  }
});

test('cancelled held cache results and expired store cursors never return a page',async()=>{
  const f=fixture(),controller=new AbortController();f.state.held=async()=>controller.abort();
  await assert.rejects(f.read(null,controller.signal),{name:'AbortError'});
  f.state.held=async()=>{throw Error('EMAIL_CURSOR_EXPIRED');};await assert.rejects(f.read(NATIVE_EMAIL_CACHE_CURSOR_PREFIX+'expired'),/EMAIL_CURSOR_EXPIRED/);
});

test('production hook is absent by default and on false',()=>{
  const original=process.env.DEFT_NATIVE_EMAIL_ENABLED;try{delete process.env.DEFT_NATIVE_EMAIL_ENABLED;assert.equal(getNativeEmailMailboxExperiencePage(),undefined);process.env.DEFT_NATIVE_EMAIL_ENABLED='false';assert.equal(getNativeEmailMailboxExperiencePage(),undefined);}finally{if(original===undefined)delete process.env.DEFT_NATIVE_EMAIL_ENABLED;else process.env.DEFT_NATIVE_EMAIL_ENABLED=original;}
});
test('unsupported folders keep existing provider behavior and never claim a complete empty cache',async()=>{
  const f=fixture();assert.equal(await f.cache.read({caller:f.caller,projection:f.projection,folder:'custom_unreviewed',cursor:null,limit:10},new AbortController().signal),null);assert.equal(f.state.lookup,0);
});
