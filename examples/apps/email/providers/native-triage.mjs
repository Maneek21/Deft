import {createEmailTriageService} from '../triage-service.mjs';
import {createGmailTriageAdapter} from './triage-gmail.mjs';
import {createMicrosoftTriageAdapter} from './triage-microsoft.mjs';
import {resolveProviderSource} from './provider-browser.mjs';
import {resolveNativeImapSource} from './native-imap-alias.mjs';
import {exact,sameTriageState,triageJson,triageDigest,TRIAGE_LIMITS} from './triage-contract.mjs';
import {fail,text} from './contract.mjs';
import {gmailMessageFolders} from './native-folder-identity.mjs';

const operations=['mark_read','mark_unread','flag','unflag','archive','trash','move'].sort();
const labelsOperations=Object.freeze(['labels']);
const recoveryOperations=Object.freeze(['not_spam','restore','spam']);
const publicKind=kind=>kind==='flag'?'star':kind==='unflag'?'unstar':kind;
const uuid=value=>{if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value))fail('EMAIL_TRIAGE_INPUT_INVALID');return value;};
function confirmedFlags(provider,after){
 if(!after||typeof after!=='object')return undefined;
 const strings=value=>Array.isArray(value)&&value.length<=100&&value.every(item=>typeof item==='string'&&item.length>0&&item.length<=256)&&new Set(value).size===value.length;
 if(provider==='gmail'&&strings(after.label_ids))return {seen:!after.label_ids.includes('UNREAD'),flagged:after.label_ids.includes('STARRED'),answered:null};
 if(provider==='microsoft'&&typeof after.seen==='boolean'&&after.flag&&['notFlagged','flagged','complete'].includes(after.flag.flagStatus))
  return {seen:after.seen,flagged:after.flag.flagStatus!=='notFlagged',answered:null};
 if(provider==='imap_smtp'&&strings(after.flags))return {seen:after.flags.includes('\\Seen'),flagged:after.flags.includes('\\Flagged'),answered:after.flags.includes('\\Answered')};
 return undefined;
}
function confirmedFolders(provider,after){
 if(provider!=='gmail'||!after||!Array.isArray(after.label_ids)||after.label_ids.length>100
   ||after.label_ids.some(id=>typeof id!=='string'||!id||id.length>256)||new Set(after.label_ids).size!==after.label_ids.length)return undefined;
 const folders=gmailMessageFolders(after.label_ids).sort();return folders.length<=100?folders:undefined;
}
// Scoped request-local receipts may ACK only a newly completed exact after-state.
// State/locator hashes are bounded by the existing durable journal budget.
const effectKey=after=>after&&typeof after==='object'&&Buffer.byteLength(triageJson(after))<=TRIAGE_LIMITS.journal_bytes?triageDigest(after):null;
const receipt=(value,plan,account,settled,newlyEffected)=>({schema_version:'deft.email_native_triage_result.v1',account_id:account.account_id,
 operation_id:value.operation_id,operation:publicKind(plan.operation.kind),items:value.items.map((item,index)=>({logical_message_id:item.logical_id,
  state:item.state,...(item.code?{code:item.code}:{}),undo_supported:item.undo_supported===true,
  ...(item.state==='succeeded'&&settled.items[index].state==='succeeded'&&newlyEffected.has(effectKey(settled.items[index].after))&&confirmedFlags(account.provider,settled.items[index].after)?{confirmed_flags:confirmedFlags(account.provider,settled.items[index].after)}:{}),
  ...(item.state==='succeeded'&&settled.items[index].state==='succeeded'&&newlyEffected.has(effectKey(settled.items[index].after))&&confirmedFolders(account.provider,settled.items[index].after)?{confirmed_folders:confirmedFolders(account.provider,settled.items[index].after)}:{})})),
 undo_available:value.items.some(item=>item.undo_supported===true),automatic_retry:false});

/** Ordinary human mutation composition. runtime is host-selected modify custody;
 * journal commits prepared/started/terminal states durably before continuation.
 * No Experience projection, Run, review or agent authority is synthesized. */
export function createNativeEmailTriageBridge({runtime,adapterFor,now=Date.now}){
 if(typeof runtime!=='function')fail('EMAIL_TRIAGE_AUTHORITY_REQUIRED');
 return Object.freeze({async nativeEmailTriage(input,context){
  if(!input||!['apply','status','undo'].includes(input.mode))fail('EMAIL_TRIAGE_INPUT_INVALID');
  exact(input,input.mode==='apply'?['mode','operation_id','operation','sources']:input.mode==='undo'?['mode','operation_id','undo_operation_id']:['mode','operation_id']);
  uuid(input.operation_id);if(input.mode==='undo')uuid(input.undo_operation_id);
  if(input.mode!=='status'&&typeof context?.triage_before_reserve!=='function')fail('EMAIL_TRIAGE_AUTHORITY_REQUIRED');
  const value=await runtime(context);await value.check();
  const {account,scope}=value,journal=context.triage_journal,newlyEffected=new Set();
  if(!account.capabilities.includes('modify')||!text(account.action_binding_id,256)
   ||!journal||['create','load','change'].some(key=>typeof journal[key]!=='function'))fail('EMAIL_TRIAGE_AUTHORITY_REQUIRED');
  // Legacy public receipts intentionally omit provider state. Re-load the
  // exact settled journal under fresh custody checks rather than reading an
  // `after` property that the public service never returns.
  const settledReceipt=async(result,plan)=>{
   await value.check();const settled=await journal.load(scope,plan.operation_id);await value.check();
   if(!settled||result.operation_id!==plan.operation_id||result.digest!==plan.digest||!sameTriageState(settled.plan,plan)
    ||!Array.isArray(settled.items)||settled.items.length!==plan.items.length||result.items.length!==plan.items.length
    ||result.items.some((item,index)=>item.logical_id!==plan.items[index].logical_id||settled.items[index]?.logical_id!==item.logical_id
     ||item.state==='succeeded'&&(settled.items[index].state!=='succeeded'||!sameTriageState(item.locator,settled.items[index].after?.locator??null))))fail('EMAIL_TRIAGE_PLAN_DENIED');
   return receipt(result,plan,account,settled,newlyEffected);
  };
  let loaded;if(input.mode!=='apply'){loaded=await journal.load(scope,input.operation_id);await value.check();}
  // Choose one static authority family; retained plans never widen current operations.
  const familyKind=input.mode==='apply'?input.operation?.kind:loaded?.plan?.operation?.kind;
  const selectedOperations=familyKind==='labels'?labelsOperations:recoveryOperations.includes(familyKind)?recoveryOperations:operations;
  if(selectedOperations===labelsOperations&&account.provider!=='gmail'||selectedOperations===recoveryOperations&&!['gmail','microsoft'].includes(account.provider))fail('EMAIL_TRIAGE_OPERATION_UNSUPPORTED');
  const binding={scope,account,action_binding_id:account.action_binding_id,operations:selectedOperations},sources=new Map();let operation;
  if(input.mode==='apply'){
   exact(input.operation,input.operation?.kind==='labels'?['kind','label_action','destinations']:['kind','destination']);const kind=input.operation.kind==='star'?'flag':input.operation.kind==='unstar'?'unflag':input.operation.kind;
   if(!selectedOperations.includes(kind))fail('EMAIL_TRIAGE_OPERATION_UNSUPPORTED');operation={kind};
   if(kind==='labels'){
    if(!['add','remove'].includes(input.operation.label_action)||!Array.isArray(input.operation.destinations)||!input.operation.destinations.length||input.operation.destinations.length>16)fail('EMAIL_TRIAGE_INPUT_INVALID');
    const ids=[];for(const destination of input.operation.destinations){exact(destination,['account_id','provider','id','kind']);
     if(destination.account_id!==account.account_id||destination.provider!=='gmail'||destination.kind!=='label')fail('EMAIL_TRIAGE_ACCOUNT_MISMATCH');ids.push(text(destination.id,256));}
    if(new Set(ids).size!==ids.length)fail('EMAIL_TRIAGE_INPUT_INVALID');
    operation.add_labels=input.operation.label_action==='add'?ids:[];operation.remove_labels=input.operation.label_action==='remove'?ids:[];
   }else if(kind==='move'){
    const destination=input.operation.destination;exact(destination,['account_id','provider','id','kind']);
    if(destination.account_id!==account.account_id||destination.provider!==account.provider||destination.kind!==(account.provider==='gmail'?'label':'folder'))fail('EMAIL_TRIAGE_ACCOUNT_MISMATCH');
    operation.destination=text(destination.id,256);
   }else if(input.operation.destination!==undefined)fail('EMAIL_TRIAGE_INPUT_INVALID');
   if(!Array.isArray(input.sources)||!input.sources.length||input.sources.length>TRIAGE_LIMITS.items)fail('EMAIL_TRIAGE_ITEM_LIMIT');
   for(const source of input.sources){const parent=account.provider==='imap_smtp'?await resolveNativeImapSource({scope,account,source,aliases:context.imap_aliases,check:value.check}):resolveProviderSource({scope,account,source});if(sources.has(parent.logical_message_id))fail('EMAIL_TRIAGE_ITEM_LIMIT');sources.set(parent.logical_message_id,parent);}
  }
  const adapter=adapterFor?await adapterFor({binding,value,context,input}):(account.provider==='gmail'?createGmailTriageAdapter:createMicrosoftTriageAdapter)({binding,fetch:value.adapterOptions.fetch,now,
   getAccessToken:async()=>{await value.check();return value.getModifyCredential();},assertAuthority:async()=>{await value.check();return true;}});
  // Flag and membership ACKs represent only this request's newly reserved effects.
  // A retained receipt must never replay an older provider state snapshot.
  const runEffect=async(method,request)=>{let reserved=false;const result=await adapter[method]({...request,reserve:async()=>{await context.triage_before_reserve?.();await value.check();await request.reserve();reserved=true;}});
   const key=reserved?effectKey(result.after):null;if(key!==null)newlyEffected.add(key);return result;};
  const reserveAdapter={...adapter,apply:request=>runEffect('apply',request),undo:request=>runEffect('undo',request)};
  const service=createEmailTriageService({journal,now,adapterFor:async expected=>{await value.check();if(!sameTriageState(expected,binding))fail('EMAIL_TRIAGE_ACCOUNT_MISMATCH');return reserveAdapter;},
   resolveAuthority:async({scope:expected,account_id,operation:kind})=>{await value.check();if(!sameTriageState(expected,scope)||account_id!==account.account_id||!selectedOperations.includes(kind))fail('EMAIL_TRIAGE_ACCOUNT_MISMATCH');return {binding,actor:{kind:'human',user_id:scope.owner_id},expires_at:context.expires_at};},
   resolveMessage:async({logical_id})=>{await value.check();const parent=sources.get(logical_id);if(!parent)fail('EMAIL_TRIAGE_ACCOUNT_MISMATCH');return {scope,account_id:account.account_id,locator:parent.locator};}});
  if(input.mode==='apply'){loaded=await journal.load(scope,input.operation_id);await value.check();}
  if(input.mode==='status'){
   if(!loaded)fail('EMAIL_TRIAGE_PLAN_DENIED');const result=await service.status({scope,operation_id:input.operation_id,expected_digest:loaded.plan.digest});return settledReceipt(result,loaded.plan);
  }
  if(input.mode==='undo'){
   if(!loaded)fail('EMAIL_TRIAGE_PLAN_DENIED');const plan=await service.prepareUndo({scope,operation_id:input.operation_id,expected_digest:loaded.plan.digest,undo_operation_id:input.undo_operation_id});
   const prior=await journal.load(scope,input.undo_operation_id);await value.check();
   const result=prior.items.some(item=>item.state==='prepared')?await service.execute({scope,operation_id:input.undo_operation_id,expected_digest:plan.digest}):await service.status({scope,operation_id:input.undo_operation_id,expected_digest:plan.digest});
   return settledReceipt(result,plan);
  }
  const plan=await service.prepare({scope,account_id:account.account_id,operation_id:input.operation_id,operation,logical_ids:[...sources.keys()]});
  // Repeated settled/started identities return retained status even after plan
  // expiry. Durable started is unknown after restart and never resent.
  loaded=await journal.load(scope,input.operation_id);await value.check();
  const result=loaded.items.some(item=>item.state==='prepared')?await service.execute({scope,operation_id:input.operation_id,expected_digest:plan.digest}):await service.status({scope,operation_id:input.operation_id,expected_digest:plan.digest});
  return settledReceipt(result,plan);
 }});
}
