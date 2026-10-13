import {RuntimeObjectSchema,parseRuntimeObjectInput} from '../../../../packages/app-kit/src/runtime-authoring';
import {parseResourceRecordList} from '../../../../packages/app-kit/src/resource-record-list';
import {composerInputDigest} from './app-experience-compose-files';
export const experienceActionDialogKeys=(protocol:string)=>protocol==='7'?['review_run','compose_action','confirm_action','review_resource_action','review_resource_action_batch']:[];
type Scalar=string|number|boolean;
export type ExperienceConfirmationRequest=Readonly<{action_key:string;input:Readonly<Record<string,Scalar>>}>;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length<=max&&!v.includes('\0');
export function parseExperienceConfirmationRequest(value:unknown,actions:readonly string[]):ExperienceConfirmationRequest{
 if(!object(value)||Object.keys(value).sort().join(',')!=='action_key,input'||typeof value.action_key!=='string'||!actions.includes(value.action_key)||!object(value.input)||Object.keys(value.input).length>32||Object.values(value.input).some(v=>typeof v==='string'?!text(v,16384):typeof v==='number'?!Number.isFinite(v):typeof v!=='boolean')||new TextEncoder().encode(JSON.stringify(value)).byteLength>60*1024)throw Error('Action unavailable');
 return Object.freeze({action_key:value.action_key,input:Object.freeze({...value.input} as Record<string,Scalar>)});
}
export async function boundedConfirmationJson(response:Response){
 if(!response.ok){await response.body?.cancel();throw Error('Action unavailable');}const reader=response.body?.getReader();if(!reader)throw Error('Action unavailable');
 const chunks:Uint8Array[]=[];let size=0;try{for(;;){const row=await reader.read();if(row.done)break;size+=row.value.byteLength;if(size>131072)throw Error('Action response limit');chunks.push(row.value);}}catch(e){await reader.cancel().catch(()=>undefined);throw e;}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!object(value))throw Error('Action unavailable');return value;
}
export function createExperienceActionConfirmation({request,sessionId,pins,call,current,uuid=()=>crypto.randomUUID(),now=Date.now}:{request:ExperienceConfirmationRequest;sessionId:string;pins:{app_version_id:string;grant_snapshot_id:string};call:(path:string,body?:unknown)=>Promise<Record<string,unknown>>;current:()=>boolean;uuid?:()=>string;now?:()=>number}){
 const base='/api/app-experiences/sessions/'+encodeURIComponent(sessionId),idempotency=uuid();let context:Record<string,unknown>|null=null,ticket:Record<string,unknown>|null=null,input:Record<string,Scalar>|null=null,dispatched=false;
 const destructive=request.action_key==='permanent_delete_message'||request.input.operation==='permanent_delete';
 function live(){if(!current())throw Error('Action access changed');}
 function checkedContext(value:Record<string,unknown>){if(value.schema_version!=='deft.experience_human_action_context.v1'||value.action_key!==request.action_key||value.draft_policy!==undefined||!text(value.label,200)||!text(value.contract_digest,120)||!text(value.runtime_binding_id,120)||value.app_version_id!==pins.app_version_id||value.grant_snapshot_id!==pins.grant_snapshot_id||typeof value.expires_at!=='string'||!Number.isFinite(Date.parse(value.expires_at))||Date.parse(value.expires_at)<=now())throw Error('Action changed');RuntimeObjectSchema.parse(value.input_schema);return value;}
 return {destructive,get dispatched(){return dispatched;},async load(){
  live();context=checkedContext(await call(base+'/human-actions/'+encodeURIComponent(request.action_key)+'/context'));live();const schema=RuntimeObjectSchema.parse(context.input_schema);input=parseRuntimeObjectInput(schema,request.input);
  const digest=await composerInputDigest(input),rows:{label:string;value:string}[]=[];let resource:{key:string;id:string}|null=null;
  for(const [key,definition] of Object.entries(schema.properties)){const value=input[key];if(value===undefined||value==='')continue;const label=(definition.type==='string'?definition.title:undefined)||key.replaceAll('_',' ');
   if(definition.type==='string'&&definition.format==='resource_record_list'){const ids=parseResourceRecordList(value as string,{maxItems:definition.maxItems});rows.push({label,value:`${ids.length} selected ${ids.length===1?'record':'records'}`});resource??={key:definition.resourceKey!,id:ids[0]};}
   else rows.push({label,value:typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(value)?'Previous confirmed operation':String(value).replaceAll('_',' ').slice(0,2000)});
  }
  if(resource&&(input.destination||input.add_labels||input.remove_labels)&&input.operation!=='undo'){
   const result=await call(base+'/resources/'+encodeURIComponent(resource.key)+'/content',{operation:'triage_options',record_id:resource.id});live();const options=result.output;
   if(!object(options)||options.schema_version!=='deft.experience_triage_options.v1'||!Array.isArray(options.destinations)||!Array.isArray(options.labels))throw Error('Action options unavailable');
   const name=(id:string,catalog:unknown[])=>{const row=catalog.find(row=>object(row)&&row.id===id);if(!object(row)||!text(row.label,200))throw Error('Selected option changed');return row.label;};
   for(const row of rows){if(row.label===((schema.properties.destination?.type==='string'?schema.properties.destination.title:undefined)||'destination')&&input.destination)row.value=name(String(input.destination),options.destinations);for(const key of ['add_labels','remove_labels'])if(row.label===((schema.properties[key]?.type==='string'?schema.properties[key].title:undefined)||key.replaceAll('_',' '))&&input[key])row.value=String(input[key]).split(',').map(id=>name(id,options.labels as unknown[])).join(', ');}
  }
  ticket=await call(base+'/human-actions/'+encodeURIComponent(request.action_key)+'/prepare',{input,idempotency_key:idempotency});live();if(ticket.schema_version!=='deft.experience_human_action_ticket.v1'||typeof ticket.ticket!=='string'||ticket.ticket.length>131072||ticket.input_digest!==digest||typeof ticket.expires_at!=='string'||!Number.isFinite(Date.parse(ticket.expires_at))||Date.parse(ticket.expires_at)<=now())throw Error('Action preparation changed');
  return {label:context.label as string,rows,expires_at:ticket.expires_at as string};
 },async confirm(explicitDestructive=false){
  live();if(dispatched||!context||!ticket||!input||destructive&&!explicitDestructive||Date.parse(String(ticket.expires_at))<=now())throw Error('Review this action again');
  const refreshed=checkedContext(await call(base+'/human-actions/'+encodeURIComponent(request.action_key)+'/context'));live();for(const key of ['contract_digest','runtime_binding_id','app_version_id','grant_snapshot_id','input_schema'])if(JSON.stringify(refreshed[key])!==JSON.stringify(context[key]))throw Error('Action changed');
  dispatched=true;const result=await call(base+'/human-actions/confirm',{ticket:ticket.ticket,expected_input_digest:ticket.input_digest});live();if(!object(result.run)||!text(result.run.id,120)||!text(result.run.state,40))throw Error('Action outcome unknown');return {id:result.run.id,state:result.run.state};
 }};
}
