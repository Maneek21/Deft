import {AppResourceActionBatchDialogSchema,AppResourceActionBatchReviewSchema,type AppResourceActionBatchDialog} from '../../../../packages/app-kit/src/app-resource-action-batch';
import {parseExperienceResourceAction,createExperienceResourceAction} from './app-experience-resource-action';
import {canonicalAppDataJson} from '../../../../packages/app-kit/src/app-data';
const resourceBatchDigest=async(value:unknown)=>'sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalAppDataJson(value)))),byte=>byte.toString(16).padStart(2,'0')).join('');
export function parseExperienceResourceActionBatch(value:unknown,admitted:Parameters<typeof parseExperienceResourceAction>[1]){
 const request=AppResourceActionBatchDialogSchema.parse(value);
 for(const child of request.children)parseExperienceResourceAction(child,admitted);
 return request;
}
export type ResourceBatchSubmission={batch:{id:string;state:string;release_mode:string;item_count:number};items:{key:string;label:string;run_id:string;state:string}[]};
export function createExperienceResourceActionBatch({request,sessionId,targetKey,connectionSessionId,accountRef,call,current,uuid=()=>crypto.randomUUID(),now=Date.now}:{
 request:AppResourceActionBatchDialog;sessionId:string;targetKey:string;connectionSessionId:string;accountRef:string;
 call:(path:string,body?:unknown)=>Promise<unknown>;current:()=>boolean;uuid?:()=>string;now?:()=>number;
}){
 const prefix='/api/app-data/experiences/'+encodeURIComponent(sessionId)+'/targets/'+encodeURIComponent(targetKey)+'/resource-action-batches';
 const batchId=uuid();let review:ReturnType<typeof AppResourceActionBatchReviewSchema.parse>|null=null,loading=false,dispatched=false;
 const live=()=>{if(!current())throw Error('Action access changed');};
 const result=(raw:unknown)=>{const value=raw as {batch?:{id?:unknown;state?:unknown;release_mode?:unknown;item_count?:unknown};items?:{key?:unknown;label?:unknown;run_id?:unknown;state?:unknown}[]};
  if(value?.batch?.id!==batchId||!['approved','cancelled'].includes(String(value.batch.state))||value.batch.release_mode!=='prepared_resource_sequential'||value.batch.item_count!==request.children.length||!Array.isArray(value.items)||value.items.length!==request.children.length||new Set(value.items.map(item=>item.run_id)).size!==value.items.length||value.items.some((item,ordinal)=>item.key!==String(ordinal)||!AppResourceActionBatchReviewSchema.shape.batch_id.safeParse(item.run_id).success||typeof item.state!=='string'||!/^[a-z_]{1,40}$/u.test(item.state)))throw Error('Submission not confirmed');return {batch:{id:batchId,state:String(value.batch.state),release_mode:'prepared_resource_sequential',item_count:request.children.length},items:value.items.map(item=>({key:String(item.key),label:typeof item.label==='string'?item.label.slice(0,200):'Selected group',run_id:String(item.run_id),state:String(item.state)}))};
 };
 return {get dispatched(){return dispatched;},async load(){
  live();if(loading)throw Error('Review already requested');loading=true;
  const value=AppResourceActionBatchReviewSchema.parse(await call(prefix+'/'+encodeURIComponent(request.children[0]!.action_key)+'/prepare',{connection_session_id:connectionSessionId,idempotency_key:batchId,children:request.children}));
  live();if(value.batch_id!==batchId||value.children.length!==request.children.length||Date.parse(value.expires_at)<=now()||value.review_digest!==await resourceBatchDigest({batch_id:value.batch_id,children:value.children,source_groups:value.source_groups})||value.input_digest!==await resourceBatchDigest({batch_id:value.batch_id,review_digest:value.review_digest}))throw Error('Prepared selection changed');
  for(const [ordinal,child]of request.children.entries()){
   await createExperienceResourceAction({request:child,sessionId,targetKey,connectionSessionId,accountRef,current,now,call:async()=>value.children[ordinal]}).load();
   if(await resourceBatchDigest(value.source_groups[ordinal])!==await resourceBatchDigest(child.sources))throw Error('Prepared selection changed');
  }
  live();review=value;return value;
 },async confirm(){
  live();if(!review||dispatched||Date.parse(review.expires_at)<=now())throw Error('Review unavailable');
  dispatched=true;const value=await call(prefix+'/confirm',{review,expected_input_digest:review.input_digest});live();return result(value);
 },async status(){
  live();if(!dispatched)throw Error('No submission to check');const value=await call(prefix+'/'+encodeURIComponent(batchId));live();return result(value);
 }};
}
