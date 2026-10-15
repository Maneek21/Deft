import test from 'node:test';
import assert from 'node:assert/strict';
import {assertAppDataConsentRepairSource} from '../src/lib/app-data-consent-repair.js';
import type {AppConnectionSessionRecord} from '../src/lib/app-connection-session-service.js';

// This seam tests the exact production chain predicate; full schema/digest and
// current authority are exercised separately by the real PostgreSQL HTTP test.
function fixture(){
 const scope={org_id:'org',owner_user_id:'owner',resource_binding_id:'binding',consent_expires_at:null as string|null,consent_lifetime:'until_revoked' as 'until_revoked'|undefined};
 const profile={provider_id:'provider',credential_custody:'runtime',runtime_requirement_key:'runtime'};
 const source={session_id:'source',revision:5,state:'connected' as string,runtime_session_ref:'oldref',account:{account_ref:'account'},scope,profile,action_consents:[] as unknown[]|undefined};
 const repaired={session_id:'repaired',revision:7,state:'connected' as string,runtime_session_ref:'newref',account:{account_ref:'account'},scope,profile,action_consents:[] as unknown[]|undefined,callback_consumed:true,
  credential_repair:{reservation_closed:true,begin_consumed:true,source:{session_id:'source',session_revision:5,runtime_session_ref:'oldref',account_ref:'account',scope},review:{custody_generation:1} as {custody_generation:number}|null,receipt:{custody_generation:2} as {custody_generation:number}|null}};
 return {source,repaired};
}
const check=(current:ReturnType<typeof fixture>['repaired'],record:ReturnType<typeof fixture>['repaired'],source:ReturnType<typeof fixture>['source'])=>assertAppDataConsentRepairSource(current as unknown as AppConnectionSessionRecord,record as unknown as AppConnectionSessionRecord,source as unknown as AppConnectionSessionRecord);
test('acknowledged same-authority repair accepts historical finite or persistent data identity',()=>{
 const {source,repaired}=fixture();assert.doesNotThrow(()=>check(repaired,repaired,source));
 const finite=structuredClone({source,repaired});for(const row of [finite.source,finite.repaired]){row.scope.consent_expires_at='2026-10-16T23:59:00Z';row.scope.consent_lifetime=undefined;}
 finite.repaired.credential_repair!.source.scope=finite.source.scope;
 assert.doesNotThrow(()=>check(finite.repaired,finite.repaired,finite.source));
});
test('unacknowledged, revoked, foreign or changed repair chains never inherit a data grant',()=>{
 const changes:Array<(value:ReturnType<typeof fixture>)=>void>=[
  v=>{v.repaired.credential_repair!.reservation_closed=false;},v=>{v.repaired.credential_repair!.receipt=null;},
  v=>{v.repaired.credential_repair!.review=null;},v=>{v.repaired.credential_repair!.begin_consumed=false;},v=>{v.repaired.callback_consumed=false;},
  v=>{v.repaired.credential_repair!.receipt!.custody_generation=3;},v=>{v.source.state='disconnected';},
  v=>{v.source.session_id='foreign';},v=>{v.source.revision++;},v=>{v.source.runtime_session_ref='foreign';},
  v=>{v.source.account={...v.source.account!,account_ref:'foreign'};},
  v=>{v.source.scope={...v.source.scope,org_id:'foreign'};},v=>{v.source.scope={...v.source.scope,owner_user_id:'foreign'};},
  v=>{v.source.scope={...v.source.scope,resource_binding_id:'foreign'};},v=>{v.source.profile={...v.source.profile,provider_id:'foreign'};},
  v=>{v.source.action_consents=undefined;},v=>{v.source.scope={...v.source.scope,consent_expires_at:'2026-10-16T23:59:00Z',consent_lifetime:undefined};},
 ];
 for(const change of changes){const v=structuredClone(fixture());change(v);assert.throws(()=>check(v.repaired,v.repaired,v.source),/App data access ended/);}
});
