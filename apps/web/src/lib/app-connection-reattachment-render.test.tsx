import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExperienceExistingAccountReview } from '../components/apps/experience-existing-account-review';
import type { ExistingAccountReview } from './app-connection-reattachment';
const now=Date.now(),review={account:{account_ref:'opaque',label:'Synthetic existing account'},expires_at:new Date(now+1000).toISOString(),scope:{consent_expires_at:new Date(now+100000).toISOString()}} as ExistingAccountReview;
const base={disabled:false,onAllow:()=>{},onCheck:()=>{},onClose:()=>{}};
test('actual current review renders account and explicit allow; expired review renders status only',()=>{
 const live=renderToStaticMarkup(<ExperienceExistingAccountReview {...base} review={review} uncertain={false} now={now}/>);
 assert.match(live,/Synthetic existing account/);assert.match(live,/Allow and continue/);assert.match(live,/Closing leaves this review pending/);assert.doesNotMatch(live,/custody_generation|source_session_id|opaque/);
 const expired=renderToStaticMarkup(<ExperienceExistingAccountReview {...base} review={review} uncertain={false} now={now+1001}/>);
 assert.match(expired,/review expired/);assert.match(expired,/Check status/);assert.doesNotMatch(expired,/Allow and continue/);
});
test('actual uncertain recovery renders no activation even when supplied a previous review',()=>{
 const rendered=renderToStaticMarkup(<ExperienceExistingAccountReview {...base} review={review} uncertain={true} now={now}/>);
 assert.match(rendered,/status is unconfirmed/);assert.match(rendered,/Check status/);assert.doesNotMatch(rendered,/Allow and continue|Synthetic existing account/);
});

test('v2 account reuse lists independent reviewed purposes and their expiries without OAuth navigation',()=>{
 const v2={...review,schema_version:'deft.app_connection_reattach_review.v2',action_consents:[{action_key:'mirror_drafts',expires_at:new Date(now+50000).toISOString()},{action_key:'send_message',expires_at:new Date(now+80000).toISOString()}]} as ExistingAccountReview;
 const markup=renderToStaticMarkup(<ExperienceExistingAccountReview {...base} review={v2} uncertain={false} now={now}/>);
 assert.match(markup,/mirror drafts/);assert.match(markup,/send message/);assert.equal((markup.match(/Separately reviewed until/g)??[]).length,2);assert.match(markup,/Allow and continue/);assert.doesNotMatch(markup,/provider|authorization_url|runtime_session_ref|custody_generation/);
});
