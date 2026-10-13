import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {NativeEmailOutboxDetails} from './native-email-outbox';
import {NativeEmailSchedule} from './native-email-schedule';
import type {NativeOutboxRow} from '@/lib/email-native-outbox';
const row:NativeOutboxRow={outbox_id:'22222222-2222-4222-8222-222222222222',operation_id:'33333333-3333-4333-8333-333333333333',draft_id:'11111111-1111-4111-8111-111111111111',draft_revision:4,revision:1,state:'queued',account_id:'private-account',from_address:'owner@example.com',subject:'<private>',to:'friend@example.com',cc:'',bcc:'',earliest_dispatch_at:'2026-10-04T00:00:10.000Z',undo_until:'2026-10-04T00:00:10.000Z',schedule:null,reason:null,delivery_status:'unknown',created_at:'2026-10-04T00:00:00.000Z',updated_at:'2026-10-04T00:00:00.000Z'};
const render=(state:NativeOutboxRow['state'],uncertain=false)=>renderToStaticMarkup(createElement(NativeEmailOutboxDetails,{row:{...row,state},busy:false,uncertain,canSend:true,onCheck:()=>{},onCancel:()=>{},onSchedule:()=>{},onOpenDraft:()=>{}}));
test('Outbox details show explicit From, recipients and honest delivery; irreversible states have no Cancel',()=>{
 const html=render('queued');assert.match(html,/owner@example.com/);assert.match(html,/friend@example.com/);assert.doesNotMatch(html,/delivery is not confirmed/);assert.match(html,/Cancel sending/);assert.match(html,/Reschedule/);assert.doesNotMatch(html,/private-account|11111111|33333333|border-b|Delivered/);
 for(const state of ['accepted','uncertain','submitting'] as const){assert.doesNotMatch(render(state),/Cancel sending|Reschedule/);assert.match(render(state),/Recipient delivery is not confirmed/);}assert.match(render('queued',true),/disabled=""/);assert.match(render('cancelled'),/Open returned draft/);assert.match(render('cancelled'),/This message was not sent/);assert.doesNotMatch(render('cancelled'),/Recipient delivery is not confirmed/);
});
test('schedule picker requests timezone and DST choice; it never silently resolves a local time',()=>{
 const html=renderToStaticMarkup(createElement(NativeEmailSchedule,{busy:false,onSubmit:()=>{},onClose:()=>{}}));assert.match(html,/datetime-local/);assert.match(html,/Timezone/);assert.match(html,/Ask me to choose/);assert.match(html,/earlier occurrence/);assert.match(html,/later occurrence/);assert.match(html,/Pause if more than five minutes late/);assert.match(html,/skipped by a clock change/);
});
test('unconfirmed provider preparation permits status and cancel without reschedule or acceptance claim',()=>{
 const html=renderToStaticMarkup(createElement(NativeEmailOutboxDetails,{row:{...row,state:'paused',reason:'preparation_unknown'},busy:false,uncertain:false,canSend:true,onCheck:()=>{},onCancel:()=>{},onSchedule:()=>{},onOpenDraft:()=>{}}));assert.match(html,/Check status/);assert.match(html,/Cancel sending/);assert.match(html,/could not be confirmed/);assert.doesNotMatch(html,/Reschedule|Accepted by/);
});
test('Sent-copy details are additive only to an accepted Send, with no mutation of queued/cancelled sending',()=>{const props={row:{...row,state:'accepted' as const},busy:false,uncertain:false,canSend:true,onCheck:()=>{},onCancel:()=>{},onSchedule:()=>{},onOpenDraft:()=>{},sentCopy:createElement('p',null,'Separate SMTP copy status')};assert.match(renderToStaticMarkup(createElement(NativeEmailOutboxDetails,props)),/Separate SMTP copy status/);for(const state of ['queued','paused','submitting','uncertain','cancelled'] as const)assert.doesNotMatch(renderToStaticMarkup(createElement(NativeEmailOutboxDetails,{...props,row:{...row,state}})),/Separate SMTP copy status/);});
