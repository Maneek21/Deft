import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {NativeEmailInvitationCard,NativeEmailCalendarInvitationAction} from './native-email-calendar-invitation';
import type {NativeInvitation,NativeInvitationReceipt} from '@/lib/email-native-calendar-invitation';
const invitation:NativeInvitation={invitation_id:'c'.repeat(64),part_ref:'d'.repeat(64),method:'REQUEST',sequence:1,dtstamp:'2026-10-04T09:00:00.000Z',summary:'Controlled meeting',description:'<script>never execute</script>',location:'Controlled room',organizer:{address:'organizer@example.test',name:'Organizer'},organizer_trust:'unverified_mail_data',receiving_attendee:'owner@example.test',start:{value:'20261010',value_type:'date',time_zone:null,instant:null},end:{value:'20261011',value_type:'date',time_zone:null,instant:null},recurrence_id:null,recurring:false,limitations:[],rsvp_available:true,preview_token:'sealed_token'};
const props={invitation,sendResponse:true,recreateDeleted:false,allowRecreate:false,receipt:null,pending:false,disabled:false,onSendChange:()=>{},onRecreateChange:()=>{},onAction:()=>{},onCheck:()=>{}};
const render=(overrides:Partial<Parameters<typeof NativeEmailInvitationCard>[0]>={})=>renderToStaticMarkup(createElement(NativeEmailInvitationCard,{...props,...overrides}));
test('standard response visibly includes organizer reply by default; Calendar-only alternate is explicit',()=>{
 const html=render();for(const label of ['Accept &amp; send response','Tentative &amp; send response','Decline &amp; send response'])assert.ok(html.includes(label));assert.match(html,/type="checkbox" checked=""/);assert.match(html,/Send response to organizer/);assert.match(html,/owner@example.test/);assert.match(html,/2026-10-11 · all day \(exclusive\)/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|sealed_token|invitation_id/);
 const local=render({sendResponse:false});assert.match(local,/Accept in Calendar/);assert.doesNotMatch(local,/checked=""|Accept &amp; send/);
});
test('unknown action keeps GET check visible, and cannot offer another Accept or response',()=>{
 const html=render({pending:true});assert.match(html,/Check response status/);assert.match(html,/do not send another response/);assert.doesNotMatch(html,/Accept &amp;|Tentative &amp;|Decline &amp;|type="checkbox"/);
 const other=render({actionsDisabled:true});assert.equal((other.match(/disabled=""/g)??[]).length,4);
});
test('unsupported recurrence, REPLY and cancellation render honest distinct controls',()=>{
 const recurring=render({invitation:{...invitation,recurring:true,limitations:['calendar_recurrence_density_unsupported'],rsvp_available:false,preview_token:null}});assert.match(recurring,/Recurring event/);assert.match(recurring,/too frequent for Calendar/);assert.doesNotMatch(recurring,/Accept &amp;/);
 const reply=render({invitation:{...invitation,method:'REPLY',rsvp_available:false,preview_token:null}});assert.match(reply,/No Calendar action/);assert.doesNotMatch(reply,/Accept|Apply cancellation/);
 const cancel=render({invitation:{...invitation,method:'CANCEL',rsvp_available:false,receiving_attendee:null}});assert.match(cancel,/Apply cancellation in Calendar/);assert.doesNotMatch(cancel,/Send response to organizer|Accept &amp;/);
});
test('Calendar update and queued/provider response are displayed separately with no delivery or resend claim',()=>{
 const receipt:NativeInvitationReceipt={schema_version:'deft.email_invitation_receipt.v1',account_id:'account',request_id:'11111111-1111-4111-8111-111111111111',invitation_id:invitation.invitation_id,revision:1,calendar:{state:'applied',event_id:'event'},response:{state:'accepted',outbox_id:'outbox',delivery_status:'unknown'}};
 const html=render({receipt});assert.match(html,/Updated in Deft Calendar/);assert.match(html,/Response accepted by the provider/);assert.match(html,/Delivery is not confirmed/);assert.match(html,/href="\/calendar\?date=2026-10-10"/);assert.doesNotMatch(html,/Accept &amp;|Resend|Recreate/);
});
test('More action is lazy and displays no invitation body or ID before opening',()=>{
 const html=renderToStaticMarkup(createElement(NativeEmailCalendarInvitationAction,{target:{account_id:'account',logical_message_id:'mail_'+'a'.repeat(64)},sourceDigest:'b'.repeat(64),sessionScope:'scope'}));assert.match(html,/Check calendar invitation/);assert.doesNotMatch(html,/organizer@example|mail_aaaa|sourceDigest|aria-modal/);
});
