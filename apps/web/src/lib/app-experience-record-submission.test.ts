import assert from 'node:assert/strict';
import test from 'node:test';
import {createExperienceBridge,type ExperiencePin,type ExperiencePort} from './app-experience-bridge';
import {deliverExperienceRecordSubmission,reopenExperienceAfterSubmission} from './app-experience-record-submission';
const pin:ExperiencePin={org_id:'org',user_id:'owner',app_installation_id:'app',app_version_id:'version',grant_snapshot_id:'grant',lifecycle_epoch:1,grant_epoch:1,session_id:'session_12345678',session_epoch:1};
const row={record_id:'11111111-1111-4111-8111-111111111111',revision:8,content_digest:'sha256:'+'a'.repeat(64),status:'draft' as const,value:{body:'PRIVATE BODY',attachments:['PRIVATE FILE']}};
class Port implements ExperiencePort{onmessage:((event:MessageEvent)=>void)|null=null;sent:unknown[]=[];postMessage(value:unknown){this.sent.push(value);}close(){}}
const options=()=>({confirmed:true,nodeId:'compose',row,current:()=>true,signal:new AbortController().signal});
test('actual saturated host bridge drops submitted reference, then bounded recovery posts it once without any body bytes',async()=>{
 const port=new Port();let release!:()=>void,checks=0;
 const held=new Promise<boolean>(resolve=>{release=()=>resolve(true);});
 const bridge=createExperienceBridge({port,pin,resourceKeys:[],actionKeys:[],onView:()=>{},broker:{isLive:()=>++checks===1?held:true}});
 const queued=Array.from({length:16},(_,index)=>bridge.sendUiEvent({kind:'input',node_id:'compose',value:String(index)}));
 assert.equal(await bridge.sendUiEvent({kind:'input',node_id:'compose',record_state:'submitted'}),false);assert.equal(port.sent.length,0);
 const delivery=deliverExperienceRecordSubmission({...options(),timeoutMs:200,retryDelayMs:5,send:(event,signal)=>bridge.sendUiEvent(event,{signal})});
 setTimeout(release,10);assert.equal(await delivery,true);await Promise.all(queued);
 const sent=port.sent as {event:Record<string,unknown>}[];const submitted=sent.filter(item=>item.event.record_state==='submitted');assert.equal(submitted.length,1);
 assert.equal(submitted[0].event.record_revision,8);assert.equal(submitted[0].event.dirty,false);assert.equal(submitted[0].event.valid,false);
 assert.equal(JSON.stringify(submitted).includes('PRIVATE'),false);assert.equal(sent.at(-1)?.event.record_state,'submitted');bridge.revoke();
});
test('submitted metadata retry is finite, does not acknowledge a false delivery and retains exact identity',async()=>{
 const seen:unknown[]=[];assert.equal(await deliverExperienceRecordSubmission({...options(),retryDelayMs:1,maxAttempts:3,send:event=>{seen.push(event);return false;}}),false);
 assert.equal(seen.length,3);assert.equal(seen[0],seen[1]);assert.deepEqual(seen[0],seen[2]);assert.equal(Object.isFrozen(seen[0]),true);
});
test('unknown/unconfirmed outcome never creates submitted event, while revoked/aborted scope stops retries',async()=>{
 let calls=0;assert.equal(await deliverExperienceRecordSubmission({...options(),confirmed:false,send:()=>{calls++;return true;}}),false);assert.equal(calls,0);
 for(const change of ['revoked','aborted']){let live=true;const abort=new AbortController();calls=0;
  assert.equal(await deliverExperienceRecordSubmission({...options(),current:()=>live,signal:abort.signal,retryDelayMs:1,send:()=>{calls++;if(change==='revoked')live=false;else abort.abort();return false;}}),false);assert.equal(calls,1);}
});
test('expired metadata delivery cancels live check and suppresses late port disclosure without revoking healthy bridge',async()=>{
 const port=new Port();let release!:(live:boolean)=>void,signal:AbortSignal|undefined;
 const bridge=createExperienceBridge({port,pin,resourceKeys:[],actionKeys:[],onView:()=>{},broker:{isLive:(_pin,currentSignal)=>{signal=currentSignal;return new Promise(resolve=>{release=resolve;});}}});
 const result=await deliverExperienceRecordSubmission({...options(),timeoutMs:10,send:(event,signal)=>bridge.sendUiEvent(event,{signal})});assert.equal(result,false);assert.equal(signal?.aborted,true);
 release(true);await new Promise(resolve=>setTimeout(resolve,0));assert.equal(port.sent.length,0);assert.equal(bridge.active,true);bridge.revoke();
});
test('late rejected liveness after cancellation never revokes or posts, and pre-aborted delivery does no work',async()=>{
 const port=new Port();let reject!:(reason:Error)=>void;
 const bridge=createExperienceBridge({port,pin,resourceKeys:[],actionKeys:[],onView:()=>{},broker:{isLive:()=>new Promise((_resolve,fail)=>{reject=fail;})}});
 assert.equal(await deliverExperienceRecordSubmission({...options(),timeoutMs:5,send:(event,signal)=>bridge.sendUiEvent(event,{signal})}),false);
 reject(Error('late'));await new Promise(resolve=>setTimeout(resolve,0));assert.equal(bridge.active,true);assert.equal(port.sent.length,0);bridge.revoke();
 const abort=new AbortController();abort.abort();let calls=0;assert.equal(await deliverExperienceRecordSubmission({...options(),signal:abort.signal,send:()=>{calls++;return true;}}),false);assert.equal(calls,0);
});
test('safe submitted reconciliation opens normal host flow only after every writer is confirmed in the same current scope',async()=>{
 for(const blocked of ['unconfirmed','flush','settle','revoked','throw']){let reopened=0,live=true;
  assert.equal(await reopenExperienceAfterSubmission({confirmed:blocked!=='unconfirmed',current:()=>live,
   flush:async()=>{if(blocked==='throw')throw Error('unknown write');return blocked!=='flush';},
   settle:async()=>{if(blocked==='revoked')live=false;return blocked!=='settle';},reopen:()=>reopened++}),false);assert.equal(reopened,0);}
 const events:string[]=[];assert.equal(await reopenExperienceAfterSubmission({confirmed:true,current:()=>true,
  flush:async()=>{events.push('flush');return true;},settle:async()=>{events.push('settle');return true;},reopen:()=>{events.push('reopen');}}),true);
 assert.deepEqual(events,['flush','settle','reopen']);
});
