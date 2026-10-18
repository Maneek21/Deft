import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {RecordStoreDeclarationSchema} from '../src/app-data.js';
import {AppPreparedMirrorInputSchema} from '../src/record-mirror.js';

test('a notes App declares its own store and action through the generic mirror contract',()=>{
 const declaration=RecordStoreDeclarationSchema.parse({schema_version:'deft.app_record_store.v1',key:'notes',resource_key:'notebook',runtime_requirement_key:'notes_sync',max_record_bytes:4096,max_files:0,max_file_bytes:1,max_total_file_bytes:1,record_mirrors:[{schema_version:'deft.app_record_mirror.v1',key:'saved_notes',action_key:'publish_notes',max_authority_seconds:3600,max_attempts_per_day:20,max_mime_bytes:4096,operations:['create','update','inspect','delete'],cleanup:'matching_accepted_submission'}]});
 const input=AppPreparedMirrorInputSchema.parse({mirror_receipt_id:randomUUID(),mirror_receipt_revision:1,mirror_policy_digest:'sha256:'+'1'.repeat(64),record_store_key:declaration.key,record_id:randomUUID(),record_revision:2,content_digest:'sha256:'+'2'.repeat(64),snapshot_id:randomUUID(),snapshot_digest:'sha256:'+'3'.repeat(64),mirror_operation:'update',accepted_submission_id:'',accepted_snapshot_id:'',accepted_snapshot_digest:''});
 assert.equal(declaration.record_mirrors![0]!.action_key,'publish_notes');assert.equal(input.record_store_key,'notes');
 assert.equal(AppPreparedMirrorInputSchema.safeParse({...input,mirror_operation:'delete'}).success,false,'cleanup requires exact accepted submission and snapshot pins');
});
