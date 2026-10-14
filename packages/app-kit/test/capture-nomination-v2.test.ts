import assert from 'node:assert/strict';
import test from 'node:test';
import {AppIntegrationCaptureNominationV2Schema} from '../src/app-integration-source.js';
const hash='sha256:'+'a'.repeat(64);
test('a non-mail source nominates bounded untrusted body and scope metadata',()=>{
 const nomination={schema_version:'deft.app_capture_nomination.v2',eligible:true,body:'A warehouse observation nominates this exact durable inventory procedure.',body_digest:hash,thread_key:hash,sender:'warehouse-west',received_at:'2026-10-14T00:00:00.000Z',folders:['audited_inventory'],is_bulk:false,partial:true,attachments_processed:false};
 assert.deepEqual(AppIntegrationCaptureNominationV2Schema.parse(nomination),nomination);
 for(const patch of [{body:'x'.repeat(16001)},{body_digest:undefined},{thread_key:undefined},{sender:'foreign\nheader'},{folders:['same','same']},{folders:['bad\nfolder']},{attachments_processed:true},{partial:false}])assert.equal(AppIntegrationCaptureNominationV2Schema.safeParse({...nomination,...patch}).success,false);
});
