import {appConsentDeadline} from '../../../../packages/app-kit/src/consent-lifetime';
import {AppDataContextSchema} from '../../../../packages/app-kit/src/app-data';
import {AppLocalJobInteractiveResultSchema,AppLocalJobScheduleRequestSchema,AppLocalJobCancelRequestSchema,AppLocalJobListRequestSchema,AppLocalJobStatusRequestSchema} from '../../../../packages/app-kit/src/local-job';
import {canonicalAppDataJson} from '../../../../packages/app-kit/src/app-data-json';
import type {ExperienceNode} from './app-experience-bridge';
import type {ExperienceUiEvent,ExperienceDocumentContext} from './app-experience-renderer';
type Target=(typeof AppDataContextSchema)['_output']['targets'][number];
type Node=Extract<ExperienceNode,{kind:'local_job_schedule'|'local_job_list'}>;
type Result=(typeof AppLocalJobInteractiveResultSchema)['_output'];
type Calendar={wall_time:string;zone:string;ambiguity:'reject'|'earlier'|'later'};
/** Trusted native calendar review. Persist the reviewed instant; never silently
 * choose one side of a DST overlap or shift a nonexistent wall time. */
export function resolveLocalJobTime(input:Calendar,now=Date.now()){
 const invalid=()=>{throw Error('Choose a valid future date, time and IANA time zone');};
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(input.wall_time)||input.zone.length<1||input.zone.length>128||!['reject','earlier','later'].includes(input.ambiguity))invalid();
 const parts=input.wall_time.match(/\d+/gu)!.map(Number),wall=Date.UTC(parts[0]!,parts[1]!-1,parts[2]!,parts[3]!,parts[4]!);
 if(new Date(wall).toISOString().slice(0,16)!==input.wall_time||!Number.isFinite(now)||wall<now-3*86400000||wall>now+2*366*86400000)invalid();
 let format:Intl.DateTimeFormat;try{format=new Intl.DateTimeFormat('en-CA',{timeZone:input.zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});}catch{ return invalid(); }
 const local=(instant:number)=>{const p=Object.fromEntries(format.formatToParts(new Date(instant)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;},offsets=new Set<number>();
 for(let delta=-48;delta<=48;delta+=6){const instant=wall+delta*3600000,p=local(instant).match(/\d+/gu)!.map(Number);offsets.add(Date.UTC(p[0]!,p[1]!-1,p[2]!,p[3]!,p[4]!)-instant);}
 const candidates=[...offsets].map(offset=>wall-offset).filter(instant=>local(instant)===input.wall_time).sort((a,b)=>a-b);
 if(!candidates.length)throw Error('That local time does not exist because the clock changes. Choose another time.');
 if(candidates.length>1&&input.ambiguity==='reject')throw Error('That local time occurs twice. Choose the earlier or later occurrence.');
 const instant=input.ambiguity==='later'?candidates.at(-1)!:candidates[0]!;if(instant<=now)invalid();
 return {...input,zone:format.resolvedOptions().timeZone,instant:new Date(instant).toISOString()};
}
const digest=async(value:unknown)=>'sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalAppDataJson(value)))),b=>b.toString(16).padStart(2,'0')).join('');
async function read(response:Response,signal:AbortSignal){
 if(!response.ok||response.headers.get('content-type')?.split(';')[0]!=='application/json'||!response.body)throw Error('Local job request was not confirmed');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
 try{for(;;){signal.throwIfAborted();const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>131072)throw Error('Local job result limit');chunks.push(next.value);}const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;chunk.fill(0);}try{return AppLocalJobInteractiveResultSchema.parse(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes)));}finally{bytes.fill(0);}}
 catch(error){await reader.cancel().catch(()=>{});chunks.forEach(chunk=>chunk.fill(0));throw error;}finally{reader.releaseLock();}
}
/** All account selection, date/time review and mutation UUIDs belong to the host.
 * The Worker nominates only a declared operation and immutable source reference. */
export function createExperienceLocalJobHost(options:{select:(store:string,signal:AbortSignal,resource?:{resource_key:string;record_id:string;content_digest:string})=>Promise<Target>;current:()=>boolean;fetch:(path:string,options:RequestInit)=>Promise<Response>}){
 const pending=new Map<string,{target:Target;store_key:string;job_id:string;request_id:string;sent:boolean}>();
 const pin=(target:Target)=>canonicalAppDataJson({session_id:target.session_id,target_key:target.target_key,account_ref:target.account.account_ref});
 const check=(signal:AbortSignal)=>{signal.throwIfAborted();if(!options.current())throw Error('Account access ended');};
 const select=async(node:Node,signal:AbortSignal)=>{check(signal);const target=await options.select(node.store_key,signal,node.kind==='local_job_schedule'?node.resource:undefined),store=target.stores.find(s=>s.declaration.key===node.store_key),keys=node.kind==='local_job_schedule'?[node.operation_key]:node.operation_keys;
  if(!store?.consent||appConsentDeadline(store.consent.expires_at,store.consent.consent_lifetime)<=Date.now()||target.resource_key!==(node.kind==='local_job_schedule'?node.resource.resource_key:node.resource_key)||keys.some(key=>!store.declaration.local_job_operations?.some(op=>op.key===key&&op.local_only)))throw Error('Local job access ended');check(signal);return {target,store};};
 const request=async(node:Node,target:Target,operation:'schedule'|'cancel'|'status'|'list',input:Record<string,unknown>,signal:AbortSignal):Promise<Result>=>{
  const fresh=await select(node,signal);if(pin(fresh.target)!==pin(target))throw Error('Connected account changed');
  const expected=await digest({operation,input});const retained=pending.get(node.id);if((operation==='schedule'||operation==='cancel')&&retained&&retained.request_id===input.request_id)retained.sent=true;const result=await read(await options.fetch(`/api/app-local-jobs/connections/${encodeURIComponent(target.session_id)}/${operation}`,{method:'POST',cache:'no-store',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}),signal);
  const after=await select(node,signal);if(pin(after.target)!==pin(target)||result.operation!==operation||result.input_digest!==expected||('request_id' in input&&operation!=='status'&&result.request_id!==input.request_id))throw Error('Local job result not confirmed');check(signal);return result;
 };
 return {mountLocalJobControl(node:Node,wrapper:HTMLElement,emit:(event:ExperienceUiEvent)=>unknown,context:ExperienceDocumentContext){
  const abort=new AbortController(),signal=AbortSignal.any([abort.signal,context.signal]),live=()=>options.current()&&context.current()&&!signal.aborted;let busy=false,loadGeneration=0;let expiryTimer:ReturnType<typeof setTimeout>|undefined;
  // Native disclosure keeps the same fields and original request alive on close/reopen.
  const panel=node.kind==='local_job_schedule'?document.createElement('details'):wrapper;
  const heading=document.createElement(node.kind==='local_job_schedule'?'summary':'h3');heading.textContent=node.label;
  const updateSummary=()=>{if(node.kind==='local_job_schedule')heading.textContent=pending.has(node.id)?`${node.label} · Check status`:node.label;};
  if(panel!==wrapper){heading.className='min-h-11 cursor-pointer py-3 text-xs';wrapper.append(panel);updateSummary();}panel.append(heading);
  const account=document.createElement('p');account.textContent='Checking current connected account…';panel.append(account);let reviewedTarget:Target|undefined;void select(node,signal).then(({target})=>{if(live()){reviewedTarget=target;account.textContent=`Connected account: ${target.account.label}`;}}).catch(()=>{if(live())account.textContent='Connected account unavailable';});const body=document.createElement('div'),notice=document.createElement('p');notice.setAttribute('role','status');panel.append(body,notice);
  const button=(label:string,action:()=>Promise<void>,parent:HTMLElement=body)=>{const element=document.createElement('button');element.type='button';element.textContent=label;if(node.kind==='local_job_schedule')element.className='ex-button ex-button-ghost';element.addEventListener('click',()=>{if(busy||!live())return;busy=true;element.disabled=true;void action().catch(error=>{if(live()){if(node.kind==='local_job_list')body.replaceChildren();const retained=pending.get(node.id);if(retained&&!retained.sent)pending.delete(node.id);updateSummary();notice.textContent=pending.has(node.id)?'Not confirmed. Check status before making another change.':error instanceof Error?error.message:'Local job request unavailable';}}).finally(()=>{busy=false;if(live())element.disabled=false;});});parent.append(element);return element;};
  const changed=(value:string)=>{if(live())emit({kind:'click',node_id:node.id,value});};
  const recover=async(target:Target,job_id:string,request_id:string)=>{const input=AppLocalJobStatusRequestSchema.parse({store_key:node.store_key,job_id,request_id}),result=await request(node,target,'status',input,signal);if(result.state==='completed'&&(result.job?.job_id!==job_id||result.job.account_ref!==target.account.account_ref))throw Error('Original request scope changed');if(!live())return;notice.textContent=result.state==='completed'?`Original request confirmed: ${result.job_state}`:'Original request was not found. No new schedule was made.';if(result.state==='completed'){pending.delete(node.id);changed('recovered');}else pending.delete(node.id);updateSummary();};
  if(node.kind==='local_job_schedule'){
   body.className='ex-stack ex-mirror-fields';const form=document.createElement('div');form.className='ex-stack ex-mirror-fields';body.append(form);
   const field=<T extends HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>(name:string,input:T)=>{const label=document.createElement('label');label.textContent=name;label.append(input);form.append(label);return input;};
   const date=field('Date and time',document.createElement('input'));date.type='datetime-local';date.step='60';
   const zone=field('Time zone',document.createElement('input'));zone.value=Intl.DateTimeFormat().resolvedOptions().timeZone;zone.maxLength=128;
   const ambiguity=field('If this time occurs twice',document.createElement('select'));for(const [value,label]of [['reject','Require a unique time'],['earlier','Earlier occurrence'],['later','Later occurrence']]){const option=document.createElement('option');option.value=value!;option.textContent=label!;ambiguity.append(option);}
   const note=field(node.profile.note_label,document.createElement('textarea'));note.maxLength=node.profile.max_note_characters;
   const preview=document.createElement('p');form.append(preview);const calendar=()=>resolveLocalJobTime({wall_time:date.value,zone:zone.value,ambiguity:ambiguity.value as Calendar['ambiguity']});
   for(const field of [date,zone,ambiguity])field.addEventListener('change',()=>{try{preview.textContent=`Scheduled instant: ${calendar().instant}`;}catch(error){preview.textContent=error instanceof Error?error.message:'Choose a time';}});
   const schedule=button('Schedule',async()=>{
    if(pending.has(node.id))throw Error('Recover original request first');const {target,store}=await select(node,signal);if(!reviewedTarget||pin(reviewedTarget)!==pin(target)){reviewedTarget=target;account.textContent=`Connected account changed: ${target.account.label}. Review before scheduling.`;throw Error('Connected account changed');}const time=calendar(),job_id=crypto.randomUUID(),request_id=crypto.randomUUID();
    const input=AppLocalJobScheduleRequestSchema.parse({schema_version:'deft.app_local_job_schedule_request.v1',request_id,store_key:node.store_key,job_id,expected_revision:null,operation_key:node.operation_key,resource:node.resource,due_at:time.instant,expires_at:store.consent!.expires_at,value:{schedule:{wall_time:time.wall_time,zone:time.zone,ambiguity:time.ambiguity},[node.profile.note_field]:note.value}});
    if(Date.parse(input.due_at)>=Date.parse(input.expires_at))throw Error('Time is beyond current account access');pending.set(node.id,{target,store_key:node.store_key,job_id,request_id,sent:false});
    const result=await request(node,target,'schedule',input,signal);if(result.state!=='completed'||result.job?.job_id!==job_id||result.job.account_ref!==target.account.account_ref||result.job.revision!==1||result.job.due_at!==input.due_at||result.job.expires_at!==input.expires_at||result.job_state!=='scheduled')throw Error('Schedule not confirmed');pending.delete(node.id);if(live()){updateSummary();notice.textContent='Scheduled';changed('scheduled');}
   });schedule.className='ex-button ex-button-primary';schedule.disabled=node.disabled===true;
   button('Check original request status',async()=>{const saved=pending.get(node.id);if(!saved){notice.textContent='No unconfirmed request in this view.';return;}await recover(saved.target,saved.job_id,saved.request_id);});
  }else{
   let pageCursor:string|null=null;const load=async(cursor:string|null=pageCursor)=>{pageCursor=cursor;body.replaceChildren();const generation=++loadGeneration,{target,store}=await select(node,signal);clearTimeout(expiryTimer);const expire=()=>{const remaining=appConsentDeadline(store.consent!.expires_at,store.consent!.consent_lifetime)-Date.now();if(remaining<=0){body.replaceChildren();notice.textContent='Account access ended';}else expiryTimer=setTimeout(expire,Math.min(remaining,2147483647));};expire();const input=AppLocalJobListRequestSchema.parse({store_key:node.store_key,operation_keys:node.operation_keys,limit:32,cursor}),result=await request(node,target,'list',input,signal);if(!live()||generation!==loadGeneration)return;clearTimeout(expiryTimer);expiryTimer=setTimeout(()=>{body.replaceChildren();void load().catch(()=>{if(live()){body.replaceChildren();notice.textContent='Local job access ended';}});},Math.max(1,Math.min(30000,appConsentDeadline(store.consent!.expires_at,store.consent!.consent_lifetime)-Date.now())));
    for(const row of result.rows??[]){if(row.job.account_ref!==target.account.account_ref||row.resource.resource_key!==node.resource_key||!node.operation_keys.includes(row.operation_key))throw Error('List scope changed');const item=document.createElement('article'),label=document.createElement('p'),detail=document.createElement('p');label.textContent=`${row.presentation.label} · ${row.state} · ${new Date(row.job.due_at).toLocaleString()}`;detail.textContent=row.presentation.detail;item.append(label,detail);body.append(item);
     if(row.state==='scheduled')button('Cancel',async()=>{const request_id=crypto.randomUUID(),input=AppLocalJobCancelRequestSchema.parse({schema_version:'deft.app_local_job_cancel_request.v1',request_id,store_key:node.store_key,job:row.job});pending.set(node.id,{target,store_key:node.store_key,job_id:row.job.job_id,request_id,sent:false});const result=await request(node,target,'cancel',input,signal);if(result.state!=='completed'||result.job_state!=='cancelled'||result.job?.job_id!==row.job.job_id||result.job.revision!==row.job.revision+1||result.job.account_ref!==row.job.account_ref||result.job.custody_generation!==row.job.custody_generation)throw Error('Cancel not confirmed');pending.delete(node.id);if(live()){notice.textContent='Cancelled';await load();changed('cancelled');}},item);
     button('Check original request status',()=>recover(target,row.job.job_id,row.original_request_id),item);
    }if(!result.rows?.length)body.textContent='No local jobs for this account.';if(result.next_cursor)button('Next page',()=>load(result.next_cursor!),body);if(cursor)button('Newest jobs',()=>load(null),body);
   };
   const controls=document.createElement('div');wrapper.insertBefore(controls,body);button('Refresh',load,controls);button('Recover unconfirmed cancel',async()=>{const saved=pending.get(node.id);if(saved)await recover(saved.target,saved.job_id,saved.request_id);},controls);void load().catch(()=>{if(live()){body.replaceChildren();notice.textContent='Local jobs unavailable for this account.';}});
  }
  const ended=()=>{body.replaceChildren();notice.textContent='Account access ended';};signal.addEventListener('abort',ended,{once:true});
  return ()=>{clearTimeout(expiryTimer);abort.abort();signal.removeEventListener('abort',ended);wrapper.replaceChildren();};
 }};
}
