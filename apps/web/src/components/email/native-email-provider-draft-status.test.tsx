import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {NativeEmailProviderDraftStatusView} from './native-email-provider-draft-status';
import type {ProviderDraftStatus} from '@/lib/email-provider-draft-status';
const status:ProviderDraftStatus={account_id:'private-account',draft_id:'11111111-1111-4111-8111-111111111111',enabled:true,draft_revision:4,state:'unknown',generation:2,desired_revision:4,synced_revision:3,updated_at:'2026-10-04T00:00:00.000Z',recovery_available:true,recovery_pending:false};
const render=(value:ProviderDraftStatus,editable=true,pending=false)=>renderToStaticMarkup(createElement(NativeEmailProviderDraftStatusView,{view:{value,busy:false,notice:'',recoveryPending:pending},editable,onCheck:()=>{},onReconcile:()=>{},onSettings:()=>{}}));
test('eligible recovery explains interrupted update, retains local copy and has no blind retry or private IDs',()=>{
 const html=render(status);assert.match(html,/Reconcile provider draft/);assert.match(html,/does not create another copy/);assert.match(html,/Check provider draft status/);assert.doesNotMatch(html,/private-account|11111111|border-b|Overwrite|Retry sync/);
 assert.match(render(status,false),/disabled=""/);assert.match(render(status,false),/Save your current edits first/);
 assert.match(render(status,true,true),/disabled=""/);
});
test('conflict and paused statuses have honest compact controls; unknown create has no reconcile action',()=>{
 const conflict=render({...status,state:'conflict',recovery_available:false});assert.match(conflict,/will not overwrite/);assert.doesNotMatch(conflict,/Reconcile provider draft/);
 assert.match(render({...status,state:'paused',enabled:false,recovery_available:false}),/Draft sync settings/);
 assert.doesNotMatch(render({...status,recovery_available:false}),/Reconcile provider draft/);
});
