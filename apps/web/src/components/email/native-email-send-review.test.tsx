import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {parseEmailSendReview} from '@/lib/email-native-send-review';
import {emptyNativeDraft} from '@/lib/email-native-drafts';
import {NativeEmailSendReviewView} from './native-email-send-review';
import {parseNativeDraftLink} from './native-email-draft-link';
const target={actionId:'action-a',accountId:'account-a',draftId:'be76a7f8-5d2b-4d8b-8890-a508a5afdfc7',draftRevision:2,contentDigest:'a'.repeat(64)};
const preview={valid:true,action_id:target.actionId,account_id:target.accountId,draft_id:target.draftId,draft_revision:target.draftRevision,content_digest:target.contentDigest,content:{...emptyNativeDraft(),from_identity:{address:'owner@example.test'},to:'recipient@example.test',cc:'copy@example.test',bcc:'hidden@example.test',subject:'Approved scope',body:'Full exact body',body_html:'<p>Full <strong>exact</strong> body</p>',attachments:[{file_id:'file',filename:'Scope.pdf',media_type:'application/pdf',size_bytes:1024,sha256:'b'.repeat(64)}]}};
test('exact send preview exposes full sender, all recipients, safe body and named attachments',()=>{
  const review=parseEmailSendReview(preview,target),html=renderToStaticMarkup(createElement(NativeEmailSendReviewView,{review,busy:false,available:true,notice:'',onLoad:()=>{}}));
  for(const text of ['owner@example.test','recipient@example.test','copy@example.test','hidden@example.test','Scope.pdf','Full <strong>exact</strong> body','Open saved draft'])assert.ok(html.includes(text));
  assert.match(html,/draft=be76a7f8/);
});
test('stale, cross-account, missing-sender and unsafe HTML review cannot enable approval',()=>{
  for(const change of [{draft_revision:3},{account_id:'account-b'},{content_digest:'different'},{valid:false},{content:{...preview.content,from_identity:undefined}},{content:{...preview.content,body_html:'<img src="https://external.test/tracker">'}}])assert.throws(()=>parseEmailSendReview({...preview,...change},target));
});
test('saved draft deep links require exactly one account and valid native draft ID',()=>{
  assert.deepEqual(parseNativeDraftLink('account=account-a&draft='+target.draftId),{accountId:'account-a',draftId:target.draftId});
  assert.equal(parseNativeDraftLink('account=account-a&message=mail_abc'),null);
  for(const query of ['account=account-a&draft=bad','draft='+target.draftId,'account=a&account=b&draft='+target.draftId,'account=a&message=mail_a&draft='+target.draftId])assert.throws(()=>parseNativeDraftLink(query));
});
test('both compact and full approval paths require exact current email review',()=>{
  const code=readFileSync(new URL('../agent-action-card.tsx',import.meta.url),'utf8');
  assert.equal((code.match(/needsEmailReview && !emailReviewReady/g)??[]).length,2);
  assert.match(code,/emailReviewed\.scope!==getActiveSessionCacheScope\(\)/);
  assert.match(code,/Date\.now\(\)>=emailReviewed\.expiresAt/);
});
