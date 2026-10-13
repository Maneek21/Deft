import {createEmailAccountRuntime} from './providers/account-runtime.mjs';
import {PROVIDER_LIMITS,fail} from './providers/contract.mjs';
import {sameEmailScope,validateEmailAccount,validateEmailScope} from './account-registry.mjs';

const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
 &&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const text=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]/u.test(value);
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const sameIdentity=(left,right)=>exact(left,Object.keys(right))&&Object.entries(right).every(([key,value])=>
 typeof value==='object'?key==='scope'&&exact(left[key],['org_id','owner_id','installation_id'])&&sameEmailScope(left[key],value):left[key]===value);
const validProviderReceipt=value=>value&&typeof value==='object'&&!Array.isArray(value)
 &&Object.keys(value).sort().join(',')==='provider,provider_message_id'
 &&['gmail','microsoft'].includes(value.provider)
 &&(value.provider==='microsoft'&&value.provider_message_id===null||typeof value.provider_message_id==='string'
 &&value.provider_message_id.length>0&&value.provider_message_id.length<=2048
 &&!/[\u0000-\u001f\u007f]/u.test(value.provider_message_id));
const indeterminate=()=>Object.freeze({status:'indeterminate'});

function effectContext(value,request){
 if(!exact(value,['run_id','attempt_id','operation_name','scope','account','draft_ref','snapshot_ref','expires_at'])
   ||value.run_id!==request.run_id||value.attempt_id!==request.attempt_id
   ||!['send_message','reply_message'].includes(value.operation_name))fail('OUTGOING_RUNTIME_EFFECT_DENIED');
 let scope,account;try{scope=validateEmailScope(value.scope);account=validateEmailAccount(value.account);}catch{fail('OUTGOING_RUNTIME_EFFECT_DENIED');}
 if(!['gmail','microsoft'].includes(account.provider)||account.health!=='connected'||!account.capabilities.includes('send'))fail('OUTGOING_RUNTIME_ACCOUNT_DENIED');
 const draft=value.draft_ref,snapshot=value.snapshot_ref;
 if(!exact(draft,['draft_state_key','draft_id','expected_revision'])||!/^[a-z][a-z0-9_]{0,47}$/u.test(draft.draft_state_key??'')
   ||!uuid(draft.draft_id)||!Number.isSafeInteger(draft.expected_revision)||draft.expected_revision<1
   ||!exact(snapshot,['snapshot_id','digest'])||!text(snapshot.snapshot_id)||!digest(snapshot.digest)
   ||typeof value.expires_at!=='string'||!Number.isFinite(Date.parse(value.expires_at))
   ||new Date(value.expires_at).toISOString()!==value.expires_at)fail('OUTGOING_RUNTIME_REFERENCE_DENIED');
 return freeze({...value,scope,account,draft_ref:{...draft},snapshot_ref:{...snapshot}});
}

function snapshotIdentity(effect,snapshot){
 const payload=snapshot?.payload;
 if(snapshot?.snapshot_id!==effect.snapshot_ref.snapshot_id||snapshot?.payload_digest!==effect.snapshot_ref.digest
   ||!payload||!sameEmailScope(payload.scope,effect.scope)||payload.account_id!==effect.account.account_id
   ||payload.authority_epoch!==effect.account.authority_epoch||payload.provider!==effect.account.provider
   ||payload.draft_id!==effect.draft_ref.draft_id||payload.draft_revision!==effect.draft_ref.expected_revision
   ||!(effect.operation_name==='reply_message'?['reply','reply_all']:['compose','forward']).includes(payload.mode)
   ||!digest(snapshot.mime_digest)||!Array.isArray(payload.files)||!Number.isSafeInteger(payload.mime?.byte_count)
   ||payload.mime.byte_count<1||payload.mime.byte_count>PROVIDER_LIMITS.mime_bytes)fail('OUTGOING_RUNTIME_SNAPSHOT_DENIED');
 return freeze({operation_id:`mail-${effect.run_id}`,run_id:effect.run_id,
  snapshot_id:snapshot.snapshot_id,snapshot_digest:snapshot.payload_digest,mime_digest:snapshot.mime_digest,
  scope:{...effect.scope},account_id:effect.account.account_id,authority_epoch:effect.account.authority_epoch,
  resource_binding_id:effect.account.resource_binding_id,action_binding_id:effect.account.action_binding_id,
  draft_id:effect.draft_ref.draft_id,draft_revision:effect.draft_ref.expected_revision});
}

function acceptedOutput(identity,value){
 if(!exact(value,['operation_id','transport_outcome','sent_copy_outcome'])||value.operation_id!==identity.operation_id
   ||value.transport_outcome!=='provider_accepted'||value.sent_copy_outcome!=='pending')fail('OUTGOING_RUNTIME_OUTCOME_DENIED');
 return freeze({...value});
}

/** Server-only Email bridge. None of these injected ports may be author Worker
 * functions. resolveEffect independently authenticates a current released Run,
 * exact attempt/lease and account bindings; it never trusts the nominated IDs.
 * loadSnapshot returns the exact pre-confirmation sealed MIME, not a new draft.
 * Snapshot reserve and reserveTransport are durable phases of one operation:
 * reserved -> provider_started -> accepted/unknown, with no automatic takeover.
 * All outcome ports fence this complete identity; accepted cannot downgrade.
 */
export function createOutgoingSendRuntime({host,snapshots,custody,fetch:fetchImpl=globalThis.fetch,now=Date.now}={}){
 if(['resolveEffect','loadSnapshot','assertEffect','reserveTransport','recordOutcome','readOutcome'].some(key=>typeof host?.[key]!=='function')
   ||typeof snapshots?.bind!=='function'||typeof custody?.getAccessToken!=='function'||typeof fetchImpl!=='function'||typeof now!=='function')fail('OUTGOING_RUNTIME_HOST_PORT_REQUIRED');
 return Object.freeze({
  async execute(input){
   if(!exact(input,['run_id','attempt_id'])||!uuid(input.run_id)||!uuid(input.attempt_id))fail('OUTGOING_RUNTIME_INPUT_INVALID');
   const request=freeze({...input});let resolved;
   try{resolved=structuredClone(await host.resolveEffect(request));}catch{fail('OUTGOING_RUNTIME_EFFECT_DENIED');}
   const effect=effectContext(resolved,request);let deadline=Date.parse(effect.expires_at);
   const checkEffect=async()=>{
    let allowed=false;try{allowed=await host.assertEffect(effect);}catch{}
    const current=now();if(allowed!==true||!Number.isFinite(current)||current>=deadline)fail('OUTGOING_RUNTIME_EFFECT_DENIED');
   };
   await checkEffect();
   let snapshot;try{snapshot=await host.loadSnapshot(effect);}catch{fail('OUTGOING_RUNTIME_SNAPSHOT_DENIED');}
   const identity=snapshotIdentity(effect,snapshot);
   for(const file of snapshot.payload.files){const expires=Date.parse(file.expires_at);if(!Number.isFinite(expires))fail('OUTGOING_RUNTIME_SNAPSHOT_DENIED');deadline=Math.min(deadline,expires);}
   await checkEffect();
   const packet=await snapshots.bind(snapshot,{operation_id:identity.operation_id,expected_digest:identity.snapshot_digest});
   if(packet.replay===true){
    // A prior reservation is never a permit to repeat the provider request.
    let outcome;try{outcome=await host.readOutcome(identity);}catch{return indeterminate();}
    await checkEffect();
    if(!(exact(outcome,['identity','state','output'])||exact(outcome,['identity','state','output','provider_receipt']))
      ||!sameIdentity(outcome.identity,identity)||outcome.state!=='accepted'
      ||Object.hasOwn(outcome,'provider_receipt')&&(!validProviderReceipt(outcome.provider_receipt)
       ||outcome.provider_receipt.provider!==effect.account.provider))return indeterminate();
    return freeze({status:'returned',provider_succeeded:true,output:acceptedOutput(identity,outcome.output)});
   }
   if(packet.operation_id!==identity.operation_id||packet.snapshot_id!==identity.snapshot_id
     ||packet.snapshot_digest!==identity.snapshot_digest||packet.mime_digest!==identity.mime_digest)fail('OUTGOING_RUNTIME_PACKET_DENIED');
   const runtime=createEmailAccountRuntime({scope:effect.scope,accounts:[effect.account],
    authorize:async({scope,account,operation})=>{if(operation!=='send'||!sameEmailScope(scope,effect.scope)
      ||account.account_id!==identity.account_id||account.authority_epoch!==identity.authority_epoch
      ||account.resource_binding_id!==identity.resource_binding_id||account.action_binding_id!==identity.action_binding_id)return false;
      await checkEffect();return true;},
    custody:{
     async getAccessToken(request){await checkEffect();const token=await custody.getAccessToken(request);await checkEffect();return token;},
     async reserveSend(request){
      if(request.operation_id!==identity.operation_id||request.mime_digest!==identity.mime_digest
        ||request.account_id!==identity.account_id||request.authority_epoch!==identity.authority_epoch)return false;
      await checkEffect();return await host.reserveTransport(identity)===true;
     },
    },fetch:async(...args)=>{await checkEffect();return fetchImpl(...args);},
   });
   let result;
   try{result=await runtime.send(identity.account_id,packet);}
   catch{
    // A durable reservation survives failed acknowledgement. It forbids retry
    // even when recording the uncertain result itself cannot be acknowledged.
    try{await host.recordOutcome(freeze({identity,state:'unknown'}));}catch{}
    return indeterminate();
   }
   const output=acceptedOutput(identity,{operation_id:result.operation_id,transport_outcome:result.transport_outcome,sent_copy_outcome:result.sent_copy_outcome});
   const provider_receipt={provider:effect.account.provider,provider_message_id:result.provider_message_id};
   if(!validProviderReceipt(provider_receipt))return indeterminate();
   try{if(await host.recordOutcome(freeze({identity,state:'accepted',output,provider_receipt}))!==true)return indeterminate();}catch{return indeterminate();}
   return freeze({status:'returned',provider_succeeded:true,output});
  },
 });
}
