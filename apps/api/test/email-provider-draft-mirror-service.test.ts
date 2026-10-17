import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { EmailProviderDraftMirrorService } from '../src/lib/email-provider-draft-mirror-service.js';

const scope={org_id:'fixture-org',owner_user_id:'fixture-owner',account_id:'fixture-account'};
const lease={job_id:randomUUID(),lock_token:'queue-lock-token-123456789',job_name:'native-email-draft-sync' as const,draft_id:randomUUID(),revision:1};
const capability={scope,resource_binding_id:'fixture-binding',authority_version:'fixture-authority',expires_at:Date.now()+60_000};
const mime=(text:string)=>new Uint8Array(Buffer.from(text,'utf8'));
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const draft={draft_id:lease.draft_id,revision:1,content_revision:1,status:'draft',content:{subject:'Hello',body:'private draft'},
  origin:{kind:'human',created_by_user_id:scope.owner_user_id,originating_run_id:null},last_edited_by_user_id:scope.owner_user_id,
  created_at:new Date().toISOString(),updated_at:new Date().toISOString()} as const;
const privateState=(bytes:Uint8Array)=>({schema_version:'deft.email_provider_draft_state.v1',account_id:scope.account_id,
  provider:'gmail' as const,provider_draft_ref:'private-provider-id',baseline_digest:digest(bytes),provider_version:'gmail-message-version'});

function harness(previous:any=null,desiredText='desired MIME',hooks:{denyEffect?:boolean;readback?:Uint8Array}={}){
  const desired=mime(desiredText),finished:any[]=[],requests:any[]=[],effects:any[]=[],reads:any[]=[];let claimAvailable=true;
  const claim={draft_id:lease.draft_id,desired_revision:1,generation:1,envelope_revision:previous?1:0,operation_id:randomUUID(),
    previous_state:previous?'synced':'queued',provider_state:previous};
  const mirrors={async claim(){if(!claimAvailable)return null;return claim;},async verifyClaim(_scope:any,_id:any,_claim:any,_token:any,_guard:any){return !hooks.denyEffect;},
    async finish(_scope:any,_id:any,_claim:any,_token:any,outcome:any){finished.push(outcome);if(['unknown','conflict','unsupported','paused'].includes(outcome.state))claimAvailable=false;return outcome.state;},
    async releaseBeforeEffect(){reads.push('released');return true;}};
  const drafts={async read(){return draft;}};
  const mimeBuilder={async prepareDesired(){return {provider:'gmail',authority_epoch:7,mime_bytes:desired,mime_digest:digest(desired)};}};
  const provider:any={async sync(request:any,host:any){
    requests.push(request);
    if(request.operation==='inspect'){
      const bytes=hooks.readback??mime('old MIME');
      return {schema_version:'deft.email_draft_sync_result.v1',account_id:scope.account_id,provider:'gmail',operation_id:request.operation_id,
        outcome:'present',provider_draft_ref:'private-provider-id',baseline_digest:digest(bytes),provider_version:'version-now',limitations:[],mime_bytes:bytes};
    }
    const accepted=await host.draft_sync_before_effect({operation_id:request.operation_id,operation:request.operation,account_id:scope.account_id,
      authority_epoch:7,provider_draft_ref:request.provider_draft_ref??null,baseline_digest:request.baseline_digest??null,
      desired_digest:request.desired.mime_digest});
    effects.push(accepted);if(!accepted)throw new Error('denied before effect');
    if(request.operation==='create')return {schema_version:'deft.email_draft_sync_result.v1',account_id:scope.account_id,provider:'gmail',
      operation_id:request.operation_id,outcome:'created',provider_draft_ref:'private-provider-id',baseline_digest:request.desired.mime_digest,
      provider_version:'created-version',limitations:[],mime_bytes:new Uint8Array(request.desired.mime_bytes)};
    return {schema_version:'deft.email_draft_sync_result.v1',account_id:scope.account_id,provider:'gmail',operation_id:request.operation_id,
      outcome:'updated',provider_draft_ref:'private-provider-id',baseline_digest:request.desired.mime_digest,provider_version:'updated-version',
      limitations:[],mime_bytes:new Uint8Array(request.desired.mime_bytes)};
  }};
  const current=async(actual:any,actualLease:any)=>{assert.deepEqual(actual,scope);assert.equal(actualLease.job_id,lease.job_id);return capability;};
  return {service:new EmailProviderDraftMirrorService(current as any,drafts as any,mirrors as any,mimeBuilder as any,provider as any),
    finished,requests,effects,reads,desired,provider,claim};
}

test('provider draft processor reserves before create, stores only private metadata, and zeroes MIME buffers',async()=>{
  const h=harness(),expectedDigest=digest(h.desired);const result=await h.service.sync(scope,lease.draft_id,1,lease as any);
  assert.deepEqual(result,{state:'synced',revision:1});assert.equal(h.requests[0].operation,'create');
  assert.equal(h.requests[0].operation_id,h.claim.operation_id);assert.deepEqual(h.effects,[true]);
  assert.equal(h.finished[0].provider_state.provider_draft_ref,'private-provider-id');assert.equal(h.finished[0].provider_state.baseline_digest,expectedDigest);
  assert.ok(h.desired.every(byte=>byte===0));
});

test('provider update requires unchanged remote baseline and fresh version',async()=>{
  const original=mime('old MIME'),h=harness(privateState(original));const result=await h.service.sync(scope,lease.draft_id,1,lease as any);
  assert.deepEqual(result,{state:'synced',revision:1});assert.deepEqual(h.requests.map(row=>row.operation),['inspect','update']);
  assert.equal(h.requests[1].baseline_digest,digest(original));assert.equal(h.requests[1].provider_version,'version-now');
  assert.equal(h.requests[1].operation_id,h.claim.operation_id);assert.deepEqual(h.effects,[true]);
  assert.equal(h.finished[0].provider_state.provider_version,'updated-version');
});

test('remote edit conflict performs no update and retains prior comparison baseline',async()=>{
  const original=mime('old MIME'),h=harness(privateState(original),'desired MIME',{readback:mime('edited elsewhere')});
  assert.deepEqual(await h.service.sync(scope,lease.draft_id,1,lease as any),{state:'conflict',revision:1});
  assert.deepEqual(h.requests.map(row=>row.operation),['inspect']);assert.deepEqual(h.effects,[]);
  assert.equal(h.finished[0].state,'conflict');assert.equal(h.finished[0].provider_state.baseline_digest,digest(original));
});

test('unknown create result is terminal and never automatically repeated',async()=>{
  const h=harness();h.provider.sync=async(request:any,host:any)=>{
    if(request.operation==='create'){
      const accepted=await host.draft_sync_before_effect({operation_id:request.operation_id,operation:'create',account_id:scope.account_id,
        authority_epoch:7,provider_draft_ref:null,baseline_digest:null,desired_digest:request.desired.mime_digest});
      h.effects.push(accepted);return {schema_version:'deft.email_draft_sync_result.v1',account_id:scope.account_id,provider:'gmail',
        operation_id:request.operation_id,outcome:'unknown',limitations:[]};
    }
    throw new Error('unknown create must not retry');
  };
  assert.deepEqual(await h.service.sync(scope,lease.draft_id,1,lease as any),{state:'unknown',revision:1});
  assert.equal(h.finished[0].state,'unknown');assert.deepEqual(h.effects,[true]);
});

test('failed claim preflight releases only before any provider effect',async()=>{
  const h=harness(null,'desired MIME',{denyEffect:true});
  await assert.rejects(h.service.sync(scope,lease.draft_id,1,lease as any),/EMAIL_DRAFT_SYNC_RETRY/);
  assert.deepEqual(h.effects,[false]);assert.deepEqual(h.reads,['released']);assert.equal(h.finished.length,0);
});
