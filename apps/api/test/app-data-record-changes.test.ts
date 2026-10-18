import assert from 'node:assert/strict';import test from 'node:test';
import {invokeRecordChange} from '../src/lib/app-data-record-change-service';
import {recordChangeAuthorities,verifyPreparedRecordChange} from '../src/lib/app-data-record-change-guards';
import {fixture,uuid,digest,hash} from './app-data-record-changes-test-fixture';
function harness(options:{apply?:boolean;duplicate?:boolean;revokeAt?:number;foreign?:boolean}={}){const f=fixture(),prepared=f.prepare(),events:any[]=[],finished:any[]=[],requests:any[]=[];let checks=0;
 const operation=options.apply?'record_apply_change':'record_prepare_change',input=options.apply?{...f.input,prepared_id:prepared.prepared_id,prepared_digest:prepared.prepared_digest}:f.input;
 const request={schema_version:'deft.app_data_request.v1' as const,request_id:uuid(),operation:operation as any,input};
 const ports={current:async(key:string)=>{events.push(['current',key]);if(++checks>= (options.revokeAt??Infinity))throw Error('revoked');return (key==='drafts'?f.destination:f.source) as any;},
 begin:async(runtime:any,context:any,inputDigest:string)=>{events.push(['begin']);requests.push(runtime);assert.equal(runtime.schema_version,'deft.app_data_runtime.v2');assert.equal(context.schema_version,'deft.app_data_authority.v2');assert.equal(context.record_authorities.length,2);assert.equal('input' in context,false);assert.equal(inputDigest,digest({operation,input}));return !options.duplicate;},
 finish:async(id:string,state:string,value:any)=>{finished.push({id,state,value});return true;},
 dispatch:async(_authority:any,runtime:any)=>{events.push(['dispatch']);return {result:{schema_version:'deft.app_data_result.v1',request_id:runtime.request_id,operation,input_digest:digest({operation,input}),outcome:'completed',
 ...(options.apply?{record:{...f.row,record_id:options.foreign?uuid():f.row.record_id,revision:2,value:prepared.value}}:{prepared_change:prepared})}};}};
 return {f,prepared,request,ports,events,finished,requests};}
test('actual host operation helper rechecks both authorities, dispatches v2, and journals no full preview',async()=>{for(const apply of [false,true]){const h=harness({apply});const result=await invokeRecordChange(h.request,undefined,h.ports);assert.equal(result.result.operation,h.request.operation);
 assert.equal(h.events.filter(row=>row[0]==='dispatch').length,1);assert.equal(h.events.filter(row=>row[0]==='current').length,8);assert.equal(JSON.stringify(h.finished).includes('Preview subject'),false);assert.equal(JSON.stringify(h.finished).includes('preserved'),false);}});
test('duplicate original identity and revoked source deny without repeat dispatch; foreign mutation result denies',async()=>{
 const duplicate=harness({duplicate:true});await assert.rejects(invokeRecordChange(duplicate.request,undefined,duplicate.ports),{code:'APP_STATE_CONFLICT'});assert.equal(duplicate.events.some(row=>row[0]==='dispatch'),false);
 for(const revokeAt of [2,4,6]){const h=harness({revokeAt});await assert.rejects(invokeRecordChange(h.request,undefined,h.ports));assert.equal(h.events.filter(row=>row[0]==='dispatch').length,revokeAt===6?1:0);}
 const h=harness({apply:true,foreign:true});await assert.rejects(invokeRecordChange(h.request,undefined,h.ports));assert.equal(h.finished.at(-1).state,'indeterminate');
});
test('same account/full scope, both consent and declared operation pair are mandatory; prepared authority/value hashes deny changes',()=>{const f=fixture();
 for(const source of [{...f.source,connection:{...f.source.connection,account_ref:uuid()}},{...f.source,scope:{...f.scope,owner_user_id:uuid()}},{...f.source,consent:null},{...f.source,expires_at:0}])assert.throws(()=>recordChangeAuthorities(f.destination as any,source as any,f.input));
 assert.throws(()=>recordChangeAuthorities({...f.destination,store:{...f.destination.store,record_changes:[]}} as any,f.source as any,f.input));
 const good=f.prepare();assert.ok(verifyPreparedRecordChange(good,f.destination as any,f.source as any,f.input));
 assert.throws(()=>verifyPreparedRecordChange({...good,value:{...good.value,body:'tampered'}},f.destination as any,f.source as any,f.input));
 for(const patch of [{source:{...good.source,record_id:uuid()}},{authorization_digest:hash},{account_ref:uuid()},{expires_at:new Date(Date.now()+3600000).toISOString()}]){const altered={...good,...patch};const {prepared_digest,...snap}=altered;assert.throws(()=>verifyPreparedRecordChange({...altered,prepared_digest:digest(snap)},f.destination as any,f.source as any,f.input));}
});

test('honest CAS conflict is settled without content; indeterminate or smuggled previews stay fenced',async()=>{for(const outcome of ['conflict','not_found','indeterminate']){const h=harness({apply:true});h.ports.dispatch=async(_authority:any,runtime:any)=>({result:{schema_version:'deft.app_data_result.v1',request_id:runtime.request_id,operation:runtime.operation,input_digest:digest({operation:h.request.operation,input:h.request.input}),outcome}}) as any;if(outcome==='indeterminate'){await assert.rejects(invokeRecordChange(h.request,undefined,h.ports));assert.equal(h.finished.at(-1).state,'indeterminate');}else{const result=await invokeRecordChange(h.request,undefined,h.ports);assert.equal(result.result.outcome,outcome);assert.equal(h.finished.at(-1).state,'completed');}}});

test('closed operation results deny extra content on settled conflict and completed prepare/apply',async()=>{
 for(const apply of [false,true])for(const outcome of ['completed','conflict']){
  const h=harness({apply}),dispatch=h.ports.dispatch;
  h.ports.dispatch=async(authority:any,runtime:any)=>{const result=await dispatch(authority,runtime);return {result:{...result.result,outcome,items:[]}} as any;};
  await assert.rejects(invokeRecordChange(h.request,undefined,h.ports));assert.equal(h.finished.at(-1).state,'indeterminate');
 }
});