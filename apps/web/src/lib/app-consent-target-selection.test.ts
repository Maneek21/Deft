import test from 'node:test';
import assert from 'node:assert/strict';
import {selectConsentTarget} from './app-consent-target-selection';
test('an unavailable current account never falls back to another account for renewal',()=>{
 const targets=[{target_key:'recipient'},{target_key:'archive'}];
 assert.equal(selectConsentTarget(targets,'sender','recipient'),'');
 assert.equal(selectConsentTarget(targets,'recipient','archive'),'recipient');
 assert.equal(selectConsentTarget(targets,undefined,'archive'),'archive');
 assert.equal(selectConsentTarget(targets,undefined,'missing'),'recipient');
 assert.equal(selectConsentTarget([],undefined,''),'');
});
