import assert from 'node:assert/strict';
import test from 'node:test';
import {assertRecordMirrorReadDeadline,discloseRecordMirrorRead} from '../src/lib/app-record-mirror-read-deadline.js';
const base=Date.parse('2026-10-10T12:00:00Z');
const pins=(data=base+1000,scope=base+2000)=>({data_consent_expires_at:new Date(data).toISOString(),scope:{consent_expires_at:new Date(scope).toISOString()}});
for(const phase of ['consent lookup','status query','retained output and budget','original UUID Run lookup'])test(`read expires across awaited ${phase}`,async()=>{
 let time=base,reads=0;
 await assert.rejects(discloseRecordMirrorRead(pins(),async()=>{reads++;await Promise.resolve();time=base+1000;return {private:'synthetic'};},()=>new Date(time)));
 assert.equal(reads,1);
});
test('both scope and data expiry bound disclosure, including equality',async()=>{
 for(const bounds of [[base+1000,base+2000],[base+2000,base+1000]]){
  const value=pins(...bounds);assertRecordMirrorReadDeadline(value,()=>new Date(base+999));
  assert.throws(()=>assertRecordMirrorReadDeadline(value,()=>new Date(base+1000)));
 }
});
test('invalid clock and malformed deadline fail closed before read',async()=>{
 for(const [value,clock] of [[pins(),()=>new Date(NaN)],[{...pins(),data_consent_expires_at:'invalid'},()=>new Date(base)],[{...pins(),scope:{consent_expires_at:'invalid'}},()=>new Date(base)]] as const){
  let reads=0;await assert.rejects(discloseRecordMirrorRead(value,async()=>{reads++;return 'private';},clock));assert.equal(reads,0);
 }
});
test('pause and expired Modify do not remove current read-only original recovery',async()=>{
 const value={...pins(),state:'paused',authority_expires_at:new Date(base-1).toISOString(),action_consents:[{expires_at:new Date(base-1).toISOString()}]};
 const original={run_id:'11111111-1111-4111-8111-111111111111',recovered:true};
 assert.deepEqual(await discloseRecordMirrorRead(value,async()=>{await Promise.resolve();return original;},()=>new Date(base)),original);
});
test('read failure propagates and never returns a fabricated status',async()=>{
 const failure=Error('synthetic source revoked');await assert.rejects(discloseRecordMirrorRead(pins(),async()=>{await Promise.resolve();throw failure;},()=>new Date(base)),error=>error===failure);
});
