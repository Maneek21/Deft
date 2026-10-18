import {appConsentDeadline} from '../../../../packages/app-kit/src/consent-lifetime';
import {AppDataContextSchema} from '../../../../packages/app-kit/src/app-data';
import {AppRecordMirrorDeclarationsSchema,AppRecordMirrorStatusSchema,AppRecordMirrorReviewRequestSchema} from '../../../../packages/app-kit/src/record-mirror';
import {canonicalAppDataJson} from '../../../../packages/app-kit/src/app-data-json';
import {AppRecordMirrorReviewResultSchema as reviewSchema,AppRecordMirrorLookupResultSchema as lookupSchema,type DeftExperienceRecordMirrorControlNode} from '../../../../packages/app-kit/src/record-mirror-controls';
import type {ExperienceDocumentContext,ExperienceUiEvent} from './app-experience-renderer';

type Target=(typeof AppDataContextSchema)['_output']['targets'][number];
type Status=(typeof AppRecordMirrorStatusSchema)['_output'];
type Node=DeftExperienceRecordMirrorControlNode;
type Review=(typeof reviewSchema)['_output'];
type Pending=({kind:'confirm';requestId:string}|{kind:'pause';receiptId:string;revision:number})&{sent:boolean};
async function read(response:Response,signal:AbortSignal):Promise<unknown>{
 if(!response.ok||response.headers.get('content-type')?.split(';')[0]!=='application/json'||!response.body)throw Error('Sync request was not confirmed.');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){signal.throwIfAborted();const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>65536)throw Error('Sync response limit.');chunks.push(next.value);}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;chunk.fill(0);}try{return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));}finally{bytes.fill(0);}}
 catch(error){await reader.cancel().catch(()=>{});throw error;}finally{chunks.forEach(chunk=>chunk.fill(0));reader.releaseLock();}
}

/** The host owns account selection, explicit recurring review and request recovery.
 * Author nodes can nominate only a signed store policy; they cannot enable it. */
export function createExperienceRecordMirrorHost(options:{experienceId:string;select:(store:string,signal:AbortSignal)=>Promise<Target>;current:()=>boolean;fetch:(path:string,options:RequestInit)=>Promise<Response>}){
 const pending=new Map<string,Pending>();
 return {mountRecordMirrorControl(node:Node,wrapper:HTMLElement,_emit:(event:ExperienceUiEvent)=>unknown,context:ExperienceDocumentContext){
  const abort=new AbortController(),signal=AbortSignal.any([abort.signal,context.signal]),live=()=>options.current()&&context.current()&&!signal.aborted;
  let busy=false,opened=false,status:Status|null=null,target:Target|undefined,review:Review|undefined,reviewRequestId:string|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  const header=document.createElement('div');header.className='ex-stack ex-stack-horizontal';const title=document.createElement('h3');title.textContent=node.label;header.append(title);wrapper.append(header);
  const body=document.createElement('div');body.className='ex-stack ex-mirror-fields';body.hidden=true;wrapper.append(body);
  const notice=document.createElement('p');notice.setAttribute('role','status');wrapper.append(notice);
  const text=(value:string,parent:HTMLElement=body)=>{const p=document.createElement('p');p.textContent=value;parent.append(p);return p;};
  const storageKey=()=>target?`${target.session_id}/${target.account.account_ref}/${node.store_key}/${node.mirror_key}`:'';
  const pin=(value:Target)=>canonicalAppDataJson({session:value.session_id,target:value.target_key,account:value.account.account_ref,store:value.stores.find(row=>row.declaration.key===node.store_key)});
  const current=async()=>{signal.throwIfAborted();if(!live())throw Error('Account access ended.');const next=await options.select(node.store_key,signal);if(!live()||target&&pin(next)!==pin(target))throw Error('Connected account changed. Reopen settings.');
   const store=next.stores.find(row=>row.declaration.key===node.store_key);if(!store?.consent||appConsentDeadline(store.consent.expires_at,store.consent.consent_lifetime)<=Date.now())throw Error('Saved record access ended.');
   const policies=AppRecordMirrorDeclarationsSchema.parse((store.declaration as unknown as {record_mirrors?:unknown}).record_mirrors),policy=policies.find(row=>row.key===node.mirror_key);if(!policy)throw Error('Sync is not available for this account.');target=next;return {target:next,store,policy};};
  const request=async(operation:'status'|'review'|'confirm'|'pause',input:unknown)=>{const {target:selected}=await current();const waiting=pending.get(storageKey());if(waiting&&operation===waiting.kind)waiting.sent=true;const result=await read(await options.fetch(`/api/app-data/experiences/${encodeURIComponent(options.experienceId)}/targets/${encodeURIComponent(selected.target_key)}/record-mirrors/${operation}`,{method:'POST',signal,cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}),signal);await current();return result;};
  const matches=(value:Status)=>{if(!target||value.account_ref!==target.account.account_ref||value.store_key!==node.store_key||value.mirror_key!==node.mirror_key)throw Error('Sync account changed.');return value;};
  const button=(label:string,action:()=>Promise<void>|void,parent:HTMLElement=body,primary=false)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.className=primary?'ex-button ex-button-primary':'ex-button ex-button-ghost';b.addEventListener('click',()=>{if(busy||!live())return;busy=true;const controls=[...wrapper.querySelectorAll<HTMLButtonElement|HTMLInputElement>('button,input')];controls.forEach(control=>control.disabled=true);void Promise.resolve().then(action).catch(error=>{const waiting=pending.get(storageKey());if(waiting&&!waiting.sent)pending.delete(storageKey());review=undefined;if(timer)clearTimeout(timer);if(live()){notice.textContent=pending.has(storageKey())?'Change not confirmed. Check status before making another change.':error instanceof Error?error.message:'Sync unavailable.';if(opened)render();}}).finally(()=>{busy=false;if(live())controls.forEach(control=>control.disabled=false);});});parent.append(b);return b;};
  const recover=async()=>{const {target:selected}=await current(),old=pending.get(storageKey());const result=lookupSchema.parse(await request('status',{connection_session_id:selected.session_id,store_key:node.store_key,mirror_key:node.mirror_key,...(old?.kind==='confirm'?{request_id:old.requestId}:{})}));status=result.mirror?matches(result.mirror):null;
   if(old?.kind==='confirm'&&status?.request_id===old.requestId){pending.delete(storageKey());notice.textContent='Original sync change confirmed.';}
   else if(old?.kind==='pause'&&status?.receipt_id===old.receiptId&&status.revision>old.revision&&status.state!=='enabled'){pending.delete(storageKey());notice.textContent='Sync is paused. Provider copies are preserved.';}
   else if(old)notice.textContent='Original change is still unconfirmed. No change was repeated.';
   if(live())render();};
  function render(){
   body.replaceChildren();if(!target)return;text(`Connected account: ${target.account.label}`);
   text((pending.has(storageKey())?'Change unconfirmed · last known: ':'')+(status?`${status.state==='enabled'?'Enabled':status.state==='paused'?'Paused':status.state==='expired'?'Expired':'Access revoked'} · ${status.attempts_remaining} of ${status.max_attempts_per_day} attempts remaining in 24 hours.`:'Off'));
   if(status)text(`Access ends ${new Date(status.expires_at).toLocaleString()}.`);
   if(status?.activity){const activity=status.activity;text(activity.mirror_state==='unknown'?'Latest provider result is unknown. The saved local record is kept; no automatic retry.':activity.mirror_state==='conflict'?'The provider copy changed. The saved local record is kept; resolve the conflict before another provider change.':`Latest provider activity: ${activity.mirror_state} · saved revision ${activity.record_revision}.`);}
   text('When enabled, background sync is allowed; it does not confirm that a provider copy has been saved. Conflicts or uncertain results keep the local record and stop blind retries.');
   if(pending.has(storageKey())){button('Check original change',recover);return;}
   if(review){const value=review;text('Allow this app to create, update and inspect copies of saved records in this connected account. After an accepted submission, it may delete only the matching provider copy.');text(`Until ${new Date(value.expires_at).toLocaleString()} · up to ${value.max_attempts_per_day} attempts per 24 hours · maximum ${(value.max_mime_bytes/1048576).toFixed(1)} MB per record, including files.`);
    button('Enable sync',async()=>{if(review!==value||!reviewRequestId||Date.parse(value.review_expires_at)<=Date.now())throw Error('Review expired. Review the current account again.');const original=reviewRequestId;if(timer)clearTimeout(timer);pending.set(storageKey(),{kind:'confirm',requestId:original,sent:false});review=undefined;const result=matches(AppRecordMirrorStatusSchema.parse(await request('confirm',{ticket:value.ticket,expected_authority_digest:value.authority_digest})));if(result.request_id!==original)throw Error('Original sync change not confirmed.');status=result;pending.delete(storageKey());notice.textContent='Sync enabled. Provider progress is separate.';render();},body,true);
    button('Cancel',()=>{review=undefined;reviewRequestId=undefined;if(timer)clearTimeout(timer);render();});return;
   }
   if(status?.state==='enabled'){const value=status;button('Pause sync',async()=>{pending.set(storageKey(),{kind:'pause',receiptId:value.receipt_id,revision:value.revision,sent:false});status=matches(AppRecordMirrorStatusSchema.parse(await request('pause',{request_id:crypto.randomUUID(),receipt_id:value.receipt_id,expected_revision:value.revision,connection_session_id:target!.session_id,store_key:node.store_key})));if(status.receipt_id!==value.receipt_id||status.revision<=value.revision||status.state==='enabled')throw Error('Pause not confirmed.');pending.delete(storageKey());notice.textContent='Sync paused. Provider copies are preserved.';render();});button('Refresh status',recover);return;}
   const store=target.stores.find(row=>row.declaration.key===node.store_key)!,policy=AppRecordMirrorDeclarationsSchema.parse((store.declaration as unknown as {record_mirrors?:unknown}).record_mirrors).find(row=>row.key===node.mirror_key)!;
   const expiry=Math.min(Date.now()+7*86400000,Date.now()+policy.max_authority_seconds*1000,appConsentDeadline(store.consent!.expires_at,store.consent!.consent_lifetime));
   const label=(name:string,input:HTMLInputElement)=>{const l=document.createElement('label');l.textContent=name;l.className='ex-field';l.append(input);body.append(l);return input;};
   const date=label('Access until',document.createElement('input'));date.type='datetime-local';date.value=new Date(expiry-new Date(expiry).getTimezoneOffset()*60000).toISOString().slice(0,16);
   const limit=label('Maximum attempts per 24 hours',document.createElement('input'));limit.type='number';limit.min='1';limit.max=String(policy.max_attempts_per_day);limit.step='1';limit.value=String(Math.min(100,policy.max_attempts_per_day));
   button('Review sync',async()=>{const fresh=await current(),expiresAt=new Date(date.value).toISOString(),attempts=Number(limit.value);if(Date.parse(expiresAt)<=Date.now()||Date.parse(expiresAt)>Math.min(Date.now()+fresh.policy.max_authority_seconds*1000,appConsentDeadline(fresh.store.consent!.expires_at,fresh.store.consent!.consent_lifetime))||!Number.isInteger(attempts)||attempts<1||attempts>fresh.policy.max_attempts_per_day)throw Error('Choose a future expiry and a limit within current account access.');
    const input=AppRecordMirrorReviewRequestSchema.parse({connection_session_id:fresh.target.session_id,store_key:node.store_key,mirror_key:node.mirror_key,request_id:crypto.randomUUID(),expected_revision:status?.revision??0,expires_at:expiresAt,max_attempts_per_day:attempts});
    const value=reviewSchema.parse(await request('review',input));if(value.account_ref!==fresh.target.account.account_ref||value.store_key!==node.store_key||value.mirror_key!==node.mirror_key||value.expires_at!==input.expires_at||value.max_attempts_per_day!==input.max_attempts_per_day||value.max_mime_bytes!==fresh.policy.max_mime_bytes||Date.parse(value.review_expires_at)<=Date.now())throw Error('Sync review changed.');review=value;reviewRequestId=input.request_id;notice.textContent='Review this recurring access before enabling.';render();timer=setTimeout(()=>{review=undefined;reviewRequestId=undefined;if(live()){notice.textContent='Review expired. Review the current account again.';render();}},Math.max(0,Date.parse(value.review_expires_at)-Date.now()));
   },body,true);button('Refresh status',recover);
  }
  button('Manage sync',async()=>{opened=true;body.hidden=false;notice.textContent='';await recover();},header);
  return()=>{abort.abort();if(timer)clearTimeout(timer);review=undefined;target=undefined;wrapper.replaceChildren();};
 }};
}
