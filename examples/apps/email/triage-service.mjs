import {validateEmailScope,sameEmailScope} from './account-registry.mjs';
import {TRIAGE_LIMITS,validateTriageBinding,validateTriageOperation,assertTriageBinding,triageLocator,triageDigest,triageJson,sameTriageState,exact} from './providers/triage-contract.mjs';
import {fail,text} from './providers/contract.mjs';

const uuid=value=>{if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value??''))fail('EMAIL_TRIAGE_INPUT_INVALID');return value;};
const publicResult=value=>({schema_version:'deft.email_triage_result.v1',operation_id:value.plan.operation_id,digest:value.plan.digest,
 items:value.items.map(item=>({logical_id:item.logical_id,state:item.state==='started'?'unknown':item.state,...(item.code?{code:item.code}:{}),...(item.state==='succeeded'?{locator:item.after?.locator??null}:{}),undo_supported:item.state==='succeeded'&&item.undo_supported===true})),automatic_retry:false});

/** Host authority and logical-ID resolution are trusted server ports. Caller IDs
 * only nominate; no browser owner, provider locator, token or permission enters.
 * Runtime integration must derive these ports from the approved current Run. */
export function createEmailTriageService({resolveAuthority,resolveMessage,adapterFor,journal,now=Date.now}){
 if([resolveAuthority,resolveMessage,adapterFor].some(fn=>typeof fn!=='function')||['create','load','change'].some(key=>typeof journal?.[key]!=='function'))fail('EMAIL_TRIAGE_AUTHORITY_REQUIRED');
 async function authority(scope,account_id,operation,phase,review_digest=null){
  const current=await resolveAuthority({scope:structuredClone(scope),account_id,operation,phase,review_digest});
  const binding=validateTriageBinding(current?.binding);if(!sameEmailScope(scope,binding.scope)||binding.account.account_id!==account_id||!binding.operations.includes(operation)||binding.account.health!=='connected'||current.actor?.kind!=='human'||current.actor.user_id!==scope.owner_id||!Number.isSafeInteger(current.expires_at)||current.expires_at<=now())fail('EMAIL_TRIAGE_AUTHORITY_STALE');
  if(phase==='execute'&&operation==='permanent_delete'&&(current.destructive_confirmation?.accepted!==true||current.destructive_confirmation.review_digest!==review_digest))fail('EMAIL_TRIAGE_DESTRUCTIVE_CONFIRMATION_REQUIRED');
  return {...current,binding};
 }
 function digestPlan(plan){const {digest,...content}=plan;return triageDigest(content);}
 function checkedPlan(value,scope,id,digest){const plan=value?.plan;if(!plan||plan.schema_version!=='deft.email_triage_plan.v1'||plan.operation_id!==id||!sameEmailScope(plan.binding.scope,scope)||plan.digest!==digest||digestPlan(plan)!==digest)fail('EMAIL_TRIAGE_PLAN_DENIED');return plan;}
 async function prepare(input){
  exact(input,['scope','account_id','operation_id','operation','logical_ids']);const scope=validateEmailScope(input.scope),account_id=text(input.account_id,256),operation_id=uuid(input.operation_id),operation=validateTriageOperation(input.operation);
  if(!Array.isArray(input.logical_ids)||!input.logical_ids.length||input.logical_ids.length>TRIAGE_LIMITS.items||new Set(input.logical_ids).size!==input.logical_ids.length)fail('EMAIL_TRIAGE_ITEM_LIMIT');const logical_ids=input.logical_ids.map(value=>text(value,256));
  const current=await authority(scope,account_id,operation.kind,'prepare'),prior=await journal.load(scope,operation_id);
  if(prior){const plan=checkedPlan(prior,scope,operation_id,prior.plan.digest);assertTriageBinding(plan.binding,current.binding,operation.kind);if(plan.undo_of||plan.binding.account.account_id!==account_id||!sameTriageState(plan.operation,operation)||!sameTriageState(plan.items.map(item=>item.logical_id),logical_ids))fail('EMAIL_TRIAGE_OPERATION_CONFLICT');return structuredClone(plan);}
  const adapter=await adapterFor(current.binding),items=[];if(adapter.provider!==current.binding.account.provider)fail('EMAIL_TRIAGE_ACCOUNT_MISMATCH');
  for(const logical_id of logical_ids){const resolved=await resolveMessage({scope,account_id,logical_id,binding:current.binding});
   if(!resolved||!sameEmailScope(resolved.scope,scope)||resolved.account_id!==account_id)fail('EMAIL_TRIAGE_ACCOUNT_MISMATCH');const locator=triageLocator(resolved.locator,current.binding.account.provider);
   const guard=async()=>{const fresh=await authority(scope,account_id,operation.kind,'prepare');assertTriageBinding(current.binding,fresh.binding,operation.kind);};
   await guard();try{const before=await adapter.readState(locator,operation.kind,guard);items.push({logical_id,before});}catch(error){if(error.code!=='EMAIL_TRIAGE_NOT_FOUND')throw error;items.push({logical_id,before:null,error_code:error.code});}await guard();
  }
  const final=await authority(scope,account_id,operation.kind,'prepare');assertTriageBinding(current.binding,final.binding,operation.kind);
  const created_at=now(),plan={schema_version:'deft.email_triage_plan.v1',operation_id,binding:current.binding,operation,items,created_at,expires_at:Math.min(current.expires_at,final.expires_at,created_at+TRIAGE_LIMITS.ttl_ms)};
  plan.digest=digestPlan(plan);if(Buffer.byteLength(triageJson(plan))>TRIAGE_LIMITS.plan_bytes)fail('EMAIL_TRIAGE_PLAN_LIMIT');await journal.create(plan);return structuredClone(plan);
 }
 async function execute(input){
  exact(input,['scope','operation_id','expected_digest']);const scope=validateEmailScope(input.scope),operation_id=uuid(input.operation_id);if(!/^[a-f0-9]{64}$/.test(input.expected_digest??''))fail('EMAIL_TRIAGE_INPUT_INVALID');
  const loaded=await journal.load(scope,operation_id),plan=checkedPlan(loaded,scope,operation_id,input.expected_digest);
  const phase=plan.undo_of?'undo':'execute';const guard=async()=>{if(now()>=plan.expires_at)fail('EMAIL_TRIAGE_PLAN_EXPIRED');const current=await authority(scope,plan.binding.account.account_id,plan.operation.kind,phase,plan.digest);assertTriageBinding(plan.binding,current.binding,plan.operation.kind);};
  await guard();const adapter=await adapterFor(plan.binding);if(adapter.provider!==plan.binding.account.provider)fail('EMAIL_TRIAGE_ACCOUNT_MISMATCH');
  for(let index=0;index<plan.items.length;index++){
   await journal.change(scope,operation_id,async(value,write)=>{
    checkedPlan(value,scope,operation_id,plan.digest);const state=value.items[index],item=plan.items[index];
    // A durable started marker is an unknown outcome after any restart. Neither
    // a missing response nor an identical repeat authorizes a second write.
    if(state.state!=='prepared')return;
    if(!item.before){state.state='failed';state.code=item.error_code;await write(value);return;}
    let started=false;
    try{await guard();const providerState=await adapter.readState(item.before.locator,plan.operation.kind,guard);if(!sameTriageState(providerState,item.before))fail('EMAIL_TRIAGE_CONFLICT');
     const startOnce=async()=>{await guard();if(!started){state.state='started';await write(value);started=true;}};
     const result=plan.undo_of?await adapter.undo({before:item.restore_before,after:item.before,operation:plan.operation,guard,reserve:startOnce}):await adapter.apply({operation:plan.operation,before:item.before,guard,reserve:startOnce});
     if(!started)fail('EMAIL_TRIAGE_ADAPTER_PROTOCOL_INVALID');await guard();
     state.state='succeeded';state.after=result.after;state.undo_supported=result.undo_supported===true&&plan.operation.kind!=='permanent_delete'&&!plan.undo_of;await write(value);
    }catch(error){const rejected=started&&['EMAIL_TRIAGE_PROVIDER_REJECTED','EMAIL_TRIAGE_CONFLICT'].includes(error.code)&&error.status>=400&&error.status<500&&error.status!==408;state.state=started&&!rejected?'unknown':'failed';state.code=/^[A-Z0-9_]{1,100}$/.test(error.code??'')?error.code:'EMAIL_TRIAGE_UNAVAILABLE';await write(value);}
   });
  }
  await guard();return publicResult(await journal.load(scope,operation_id));
 }
 async function prepareUndo(input){
  exact(input,['scope','operation_id','expected_digest','undo_operation_id']);const scope=validateEmailScope(input.scope),original=checkedPlan(await journal.load(scope,uuid(input.operation_id)),scope,input.operation_id,input.expected_digest),undo_operation_id=uuid(input.undo_operation_id);
  if(original.operation.kind==='permanent_delete'||original.undo_of||undo_operation_id===original.operation_id)fail('EMAIL_TRIAGE_UNDO_UNSUPPORTED');
  const current=await authority(scope,original.binding.account.account_id,original.operation.kind,'undo',original.digest);assertTriageBinding(original.binding,current.binding,original.operation.kind);
  const prior=await journal.load(scope,undo_operation_id);if(prior){const plan=checkedPlan(prior,scope,undo_operation_id,prior.plan.digest);if(plan.undo_of!==original.digest)fail('EMAIL_TRIAGE_OPERATION_CONFLICT');return structuredClone(plan);}
  const value=await journal.load(scope,original.operation_id),items=value.items.map((item,index)=>({item,index})).filter(({item})=>item.state==='succeeded'&&item.undo_supported===true).map(({item,index})=>({logical_id:item.logical_id,before:item.after,restore_before:original.items[index].before}));
  if(!items.length)fail('EMAIL_TRIAGE_UNDO_UNSUPPORTED');const created_at=now(),plan={schema_version:'deft.email_triage_plan.v1',operation_id:undo_operation_id,binding:original.binding,operation:original.operation,items,undo_of:original.digest,created_at,expires_at:Math.min(current.expires_at,created_at+TRIAGE_LIMITS.ttl_ms)};
  if(plan.expires_at<=now())fail('EMAIL_TRIAGE_PLAN_EXPIRED');plan.digest=digestPlan(plan);if(Buffer.byteLength(triageJson(plan))>TRIAGE_LIMITS.plan_bytes)fail('EMAIL_TRIAGE_PLAN_LIMIT');await journal.create(plan);return structuredClone(plan);
 }
 async function status({scope,operation_id,expected_digest}){scope=validateEmailScope(scope);const value=await journal.load(scope,uuid(operation_id)),plan=checkedPlan(value,scope,operation_id,expected_digest),current=await authority(scope,plan.binding.account.account_id,plan.operation.kind,'status',plan.digest);assertTriageBinding(plan.binding,current.binding,plan.operation.kind);return publicResult(value);}
 async function destinations({scope,account_id,operation='move'}){scope=validateEmailScope(scope);if(!['move','labels'].includes(operation))fail('EMAIL_TRIAGE_INPUT_INVALID');const current=await authority(scope,account_id,operation,'destinations'),adapter=await adapterFor(current.binding),result=await adapter.listDestinations(operation),final=await authority(scope,account_id,operation,'destinations');assertTriageBinding(current.binding,final.binding,operation);return result;}
 return Object.freeze({prepare,execute,prepareUndo,status,destinations});
}
