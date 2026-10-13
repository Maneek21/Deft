import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultEmailKnowledgePolicy,emailKnowledgeEligibility,normalizeEmailKnowledgeBody,emailKnowledgeThreadKey,validateEmailKnowledgeExtraction} from '../src/lib/email-knowledge.js';
const scope={org_id:'org',owner_user_id:'owner',account_id:'account'};
const record={account_id:'account',logical_message_id:'mail_'+'a'.repeat(64),revision:'1',received_at:null,folders:['inbox'],flags:{seen:false,flagged:false,answered:false},data:{subject:'Launch decision',from:'client@example.test'},provider_source:{provider:'gmail'}};
test('native email normalization removes quoted history and signatures',()=>{assert.equal(normalizeEmailKnowledgeBody('Approved launch for Friday.\n\n> Old date Monday\n\nOn Monday, client wrote:\nOld body'),'Approved launch for Friday.');assert.equal(normalizeEmailKnowledgeBody('Do the agreed migration.\n-- \nSignature'),'Do the agreed migration.');});
test('spam, drafts, secrets, bulk and routine acknowledgements skip before model',()=>{
 for(const folder of ['spam','trash','drafts'])assert.equal(emailKnowledgeEligibility({...record,folders:[folder]},defaultEmailKnowledgePolicy),'EXCLUDED_FOLDER');
 assert.equal(emailKnowledgeEligibility({...record,data:{subject:'Your verification code'}},defaultEmailKnowledgePolicy),'SENSITIVE');
 assert.equal(emailKnowledgeEligibility(record,defaultEmailKnowledgePolicy,'Our newsletter: unsubscribe now'),'BULK');
 assert.equal(emailKnowledgeEligibility(record,defaultEmailKnowledgePolicy,'Thanks!'),'LOW_SIGNAL');
 assert.equal(emailKnowledgeEligibility(record,defaultEmailKnowledgePolicy,'We confirmed launch for Friday and agreed the migration will finish Thursday.'),null);
});
test('thread identity uses scoped provider identity and never same subject',()=>{const other={...record,logical_message_id:'mail_'+'b'.repeat(64)};assert.notEqual(emailKnowledgeThreadKey(scope,record),emailKnowledgeThreadKey(scope,other));assert.equal(emailKnowledgeThreadKey(scope,record,'provider-thread'),emailKnowledgeThreadKey(scope,other,'provider-thread'));assert.notEqual(emailKnowledgeThreadKey({...scope,account_id:'other'},record,'provider-thread'),emailKnowledgeThreadKey(scope,record,'provider-thread'));});
test('extraction must retain exact source evidence',()=>{const body='We confirmed launch for Friday and approved the rollout plan.',output={capture:true,title:'Launch',type:'decision',content:'Client confirmed Friday launch.',excerpt:body};assert.deepEqual(validateEmailKnowledgeExtraction(output,body),output);assert.throws(()=>validateEmailKnowledgeExtraction({...output,excerpt:'Fabricated text that was never sent.'},body),/EVIDENCE_INVALID/);});
