import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appCaptureAssociation, readAppCaptureAssociation } from '../src/lib/app-integration-capture-provenance.js';
const page='00000000-0000-4000-8000-000000000001',owner='00000000-0000-4000-8000-000000000002';
const base={page_id:page,page_version:1,owner_user_id:owner,body_digest:'sha256:'+'a'.repeat(64),captured_at:'2026-10-20T12:00:00Z'};

test('Host capture association records exact page revision and explicit private or space audience',()=>{
  const association=appCaptureAssociation({...base,destination:{scope:'user',space_id:null}});
  assert.deepEqual(association.audience,{scope:'user',user_id:owner,space_id:null});
  assert.deepEqual(readAppCaptureAssociation({...base,publication:{association}}),association);
  assert.deepEqual(appCaptureAssociation({...base,destination:{scope:'space',space_id:page}}).audience,{scope:'space',user_id:null,space_id:page});
});
test('unknown, incomplete, mismatched and widened association evidence fails closed',()=>{
  const association=appCaptureAssociation({...base,destination:{scope:'user',space_id:null}});
  for(const value of [undefined,{}, {...association,schema_version:'future'}, {...association,page_id:owner}, {...association,body_digest:'sha256:'+'b'.repeat(64)}, {...association,audience:{scope:'org'}}, {...association,page_version:0}]){
    assert.equal(readAppCaptureAssociation({...base,publication:{association:value}}),null);
  }
});
