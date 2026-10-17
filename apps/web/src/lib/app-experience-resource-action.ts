import {AppResourceActionDialogInputSchema,AppResourceActionReviewSchema,type AppResourceActionDialogInput} from '../../../../packages/app-kit/src/app-resource-action';
import {canonicalAppDataJson} from '../../../../packages/app-kit/src/app-data';
import {composerInputDigest} from './app-experience-compose-files';

export function parseExperienceResourceAction(value:unknown,admitted:{actions:readonly string[];stores:readonly string[];resources:readonly string[]}):AppResourceActionDialogInput{
 const request=AppResourceActionDialogInputSchema.parse(value);
 if(!admitted.actions.includes(request.action_key)||!admitted.stores.includes(request.store_key)||!admitted.resources.includes(request.resource_key))throw Error('Action not admitted');
 for(const reference of [...(request.record_sources??[]),...(request.destination?[request.destination]:[]),...(request.labels?[...request.labels.add,...request.labels.remove]:[])])if(!admitted.stores.includes(reference.store_key))throw Error('Reference store not admitted');
 return request;
}
type Run={id:string;state:string};
export function createExperienceResourceAction({request,sessionId,targetKey,connectionSessionId,accountRef,call,current,uuid=()=>crypto.randomUUID(),now=Date.now}:{
 request:AppResourceActionDialogInput;sessionId:string;targetKey:string;connectionSessionId:string;accountRef:string;
 call:(path:string,body?:unknown)=>Promise<unknown>;current:()=>boolean;uuid?:()=>string;now?:()=>number;
}){
 const prefix='/api/app-data/experiences/'+encodeURIComponent(sessionId)+'/targets/'+encodeURIComponent(targetKey);
 const idempotency=uuid();let review:ReturnType<typeof AppResourceActionReviewSchema.parse>|null=null,loading=false,dispatched=false;
 const live=()=>{if(!current())throw Error('Action access changed');};
 const run=(value:unknown):Run=>{const row=value as {run?:unknown};const candidate=(row?.run??value) as Run;
  if(!candidate||!AppResourceActionDialogInputSchema.shape.sources.element.shape.record_id.safeParse(candidate.id).success||typeof candidate.state!=='string'||!/^[a-z_]{1,40}$/u.test(candidate.state))throw Error('Submission not confirmed');
  return {id:candidate.id,state:candidate.state};};
 return {get dispatched(){return dispatched;},async load(){
  live();if(loading)throw Error('Review already requested');loading=true;
  const value=AppResourceActionReviewSchema.parse(await call(prefix+'/resource-actions/'+encodeURIComponent(request.action_key)+'/prepare',{
   connection_session_id:connectionSessionId,store_key:request.store_key,resource_key:request.resource_key,operation_key:request.operation_key,sources:request.sources,...(request.record_sources?{record_sources:request.record_sources}:{}),...(request.parameters?{parameters:request.parameters}:{}),idempotency_key:idempotency,
   ...(request.destination?{destination:request.destination}:{}),...(request.labels?{labels:request.labels}:{}),...(request.undo?{undo:request.undo}:{})}));
  live();const p=value.prepared,i=value.input;
  if(p.action_key!==request.action_key||p.operation_key!==request.operation_key||p.resource_key!==request.resource_key||p.account_ref!==accountRef
   ||i.resource_store_key!==request.store_key||i.connection_session_id!==connectionSessionId||Date.parse(value.expires_at)<=now()
   ||Object.entries(p.input).some(([key,field])=>i[key as keyof typeof i]!==field)
   ||p.preview.items.length!==request.sources.length+(request.record_sources?.length??0)||p.preview.items.some(item=>![...request.sources,...(request.record_sources??[])].some(source=>source.record_id===item.record_id))
   ||canonicalAppDataJson(p.record_refs??[])!==canonicalAppDataJson([...(request.record_sources??[]),...(request.destination?[request.destination]:[]),...(request.labels?[...request.labels.add,...request.labels.remove]:[])])
   ||p.source_manifest_digest!=='sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalAppDataJson(request.sources)))),byte=>byte.toString(16).padStart(2,'0')).join('')
   ||value.input_digest!==await composerInputDigest(i))throw Error('Prepared action changed');
  live();review=value;return value;
 },async confirm(){
  live();if(!review||dispatched||Date.parse(review.expires_at)<=now())throw Error('Review unavailable');
  dispatched=true;const result=await call(prefix+'/resource-actions/confirm',{ticket:review.ticket,expected_input_digest:review.input_digest});live();return run(result);
 },async status(){
  live();if(!dispatched)throw Error('No submission to check');
  const result=await call('/api/app-experiences/sessions/'+encodeURIComponent(sessionId)+'/human-actions/'+encodeURIComponent(request.action_key)+'/submissions/'+encodeURIComponent(idempotency));live();return run(result);
 }};
}
