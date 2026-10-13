import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {NativeEmailKnowledgeSettingsView,emailCaptureRecovery} from './native-email-knowledge-settings';
import {NativeEmailRelatedKnowledgeView} from './native-email-related-knowledge';
import {NativeEmailAgentAccessView} from './native-email-agent-access';
import type {EmailKnowledgeSettings} from '@/lib/email-native-connected';
const noop=()=>{};
const saved:EmailKnowledgeSettings={enabled:true,destination:{scope:'user',space_id:null},history_days:30,include_bulk:false,excluded_senders:[],excluded_folders:[],revision:1,progress:{processed:4,captured:2,skipped:2,last_error_code:null}};
test('one account setting enables automatic capture with explicit personal or space destination',()=>{
  const html=renderToStaticMarkup(createElement(NativeEmailKnowledgeSettingsView,{saved,choice:saved,spaces:[],busy:false,uncertain:false,notice:'',spaceNotice:'',onChange:noop,onSave:noop,onPause:noop,onReload:noop,onReloadSpaces:noop}));
  assert.match(html,/new eligible mail is captured automatically/);assert.match(html,/Personal Knowledge/);assert.match(html,/Pause learning/);assert.match(html,/4 processed · 2 captured · 2 skipped/);assert.doesNotMatch(html,/border-b|Save to Knowledge|Review destination/);
});
test('reader shows compact captured Knowledge and supported thread control',()=>{
  const html=renderToStaticMarkup(createElement(NativeEmailRelatedKnowledgeView,{value:{items:[{id:'capture',page_id:'page',title:'Client decision',url:'/knowledge?slug=decision',status:'updated'}],suppressed:false},busy:false,uncertain:false,notice:'',onToggleLearning:noop,onReload:noop}));
  assert.match(html,/Knowledge updated/);assert.match(html,/href="\/knowledge\?slug=decision"/);assert.match(html,/Stop learning from thread/);assert.doesNotMatch(html,/Correct|Forget|destination|border-b/);
});
test('first-time account capture stays off and useful recovery distinguishes provider and budget',()=>{
  const initial={...saved,enabled:false,revision:0};
  const html=renderToStaticMarkup(createElement(NativeEmailKnowledgeSettingsView,{saved:initial,choice:initial,spaces:[],busy:false,uncertain:false,notice:'',spaceNotice:'',onChange:noop,onSave:noop,onPause:noop,onReload:noop,onReloadSpaces:noop}));
  assert.match(html,/>Off</);assert.match(html,/Enable learning/);assert.doesNotMatch(html,/Resume learning|folder ID/);
  assert.match(emailCaptureRecovery('EMAIL_KNOWLEDGE_BUDGET_EXCEEDED'),/budget resets/);assert.match(emailCaptureRecovery('LLM_PROVIDER_UNAVAILABLE'),/Configure one in Settings/);
});
test('unknown mutations disable further grants and capture controls until saved-state reload',()=>{
  const html=renderToStaticMarkup(createElement(NativeEmailAgentAccessView,{value:{defty_principal_id:'owner',grants:[{id:'grant',principal_kind:'defty',principal_id:'owner',operations:['read','send'],revision:1,revoked_at:null}],personal_tokens:[{id:'token',name:'Claude'}]},principal:'defty',choice:['read'],busy:false,uncertain:true,notice:'Reload before changing access.',onPrincipal:noop,onChoice:noop,onSave:noop,onRevoke:noop,onReload:noop}));
  assert.match(html,/MCP · Claude/);assert.match(html,/exact saved draft review/);assert.match(html,/disabled=""[^>]*>Revoke access/);assert.match(html,/Reload saved access/);
});
test('new account settings stay in preferences and related Knowledge appears only with loaded reader',()=>{
  const page=readFileSync(new URL('../../app/(app)/email/page.tsx',import.meta.url),'utf8'),reader=readFileSync(new URL('./native-email-reader.tsx',import.meta.url),'utf8');
  assert.ok(page.indexOf('<NativeEmailKnowledgeSettings')>page.indexOf('Account preferences'));
  assert.ok(page.indexOf('<NativeEmailAgentAccess')>page.indexOf('Account preferences'));
  assert.match(reader,/state\?\.value&&<NativeEmailRelatedKnowledge/);
});
