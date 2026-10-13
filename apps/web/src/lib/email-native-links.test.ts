import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {parseNativeSafeComposeHtml,parseSafeComposeHtml} from '../../../../packages/app-kit/src/safe-compose-html';
import {nativeRichEditorView} from './email-native-rich-mode';
import {emptyNativeDraft,parseNativeDraftContent,createNativeDraftWriter,type NativeDraft} from './email-native-drafts';
import {parseNativeTemplateContent,renderNativeTemplate,insertNativeTemplate} from './email-native-templates';
import {nativeSignatureRegionIntact,selectNativeSignature,reconcileNativeSignatureEdit} from './email-native-signature-region';
import {parseNativeSignaturePreferences,type NativeSignaturePreferences} from './email-native-signatures';
import {parseEmailSendReview} from './email-native-send-review';
const html='<p>Read the <a href="https://example.test/notes">release notes</a>.</p>',body='Read the release notes (https://example.test/notes).';
test('native linked saved drafts reopen without repair and exact writer save preserves both parts',async()=>{
 const content={...emptyNativeDraft(),from_identity:{address:'owner@example.test'},to:'reader@example.test',body,body_html:html};assert.deepEqual(nativeRichEditorView({html,plainText:body}),{html,plainText:body});assert.equal(nativeRichEditorView({html,plainText:'Read the release notes.'}),null);assert.throws(()=>parseSafeComposeHtml(html));assert.deepEqual(parseNativeDraftContent(content),content);
 let saved:NativeDraft|undefined;const writer=createNativeDraftWriter({accountId:'a',draftId:'11111111-1111-4111-8111-111111111111',initialContent:content,current:()=>true,change:()=>{},api:{read:async()=>saved!,save:async(_a,id,rev,value)=>saved={draft_id:id,revision:rev+1,status:'draft',content:structuredClone(value),origin:{kind:'human',created_by_user_id:'u',originating_run_id:null},last_edited_by_user_id:'u',created_at:'2026-10-08T00:00:00Z',updated_at:'2026-10-08T00:00:00Z'}}});assert.equal(await writer.save(),true);assert.deepEqual(saved!.content,content);writer.dispose();
});
test('native templates derive rendered projection after label becomes URL-only and never substitute href',()=>{
 const linked='<p><a href="https://example.test/notes">{{label}}</a></p>',content={title:'Link',subject:'Hi',body:'{{label}} (https://example.test/notes)',body_html:linked};assert.deepEqual(parseNativeTemplateContent(content),content);
 for(const label of ['release notes','https://example.test/notes','<b>& quoted']){const rendered=renderNativeTemplate(content,{label});assert.equal(parseNativeSafeComposeHtml(rendered.body_html).plainText,rendered.body);assert.equal(rendered.body,label==='https://example.test/notes'?label:`${label} (https://example.test/notes)`);assert.match(rendered.body_html,/href="https:\/\/example.test\/notes"/);const appended=insertNativeTemplate({...emptyNativeDraft(),body,body_html:html},rendered,'append');assert.equal(parseNativeSafeComposeHtml(appended.body_html).plainText,appended.body);assert.equal(appended.body,body+'\n\n'+rendered.body);}
 assert.throws(()=>renderNativeTemplate({...content,body_html:'<p><a href="https://example.test/{{label}}">notes</a></p>'},{label:'replacement'}));assert.throws(()=>parseNativeTemplateContent({...content,body:'wrong paired projection'}));
});
test('native linked signatures retain exact terminal ownership through replacement and user edits',()=>{
 const address='owner@example.test',identity_key=createHash('sha256').update(address).digest('hex'),preferences:NativeSignaturePreferences={account_id:'a',revision:2,preferences:{identities:[{address,plain:'Contact (mailto:owner@example.test)',html:'<p><a href="mailto:owner@example.test">Contact</a></p>',placement:'both'}]},identity_availability:{available:[{address,identity_key}],saved:[{address,identity_key,current:true}]}};
 assert.deepEqual(parseNativeSignaturePreferences(preferences,'a'),preferences);
 const initial={...emptyNativeDraft(),from_identity:{address},body,body_html:html},signed=selectNativeSignature(initial,preferences,address).content;assert.equal(nativeSignatureRegionIntact(signed),true);assert.equal(parseNativeSafeComposeHtml(signed.body_html).plainText,signed.body);assert.equal(signed.managed_signature!.plain.start,body.length);const replaced=selectNativeSignature(signed,preferences,address).content;assert.deepEqual(replaced,signed);
 const edit={...signed,body:'Intro '+signed.body,body_html:signed.body_html.replace('Read','Intro Read')};assert.equal(nativeSignatureRegionIntact(reconcileNativeSignatureEdit(edit,signed)),true);const altered={...signed,body:signed.body.replace('Contact','My contact'),body_html:signed.body_html.replace('Contact','My contact')};assert.equal(reconcileNativeSignatureEdit(altered,signed).managed_signature,undefined);
});
test('send review accepts native links only with the exact projected plain part and current source binding',()=>{
 const target={actionId:'action',accountId:'a',draftId:'11111111-1111-4111-8111-111111111111',draftRevision:2,contentDigest:'a'.repeat(64)},content={...emptyNativeDraft(),from_identity:{address:'owner@example.test'},to:'reader@example.test',body,body_html:html},raw={valid:true,action_id:target.actionId,account_id:target.accountId,draft_id:target.draftId,draft_revision:2,content_digest:target.contentDigest,content};assert.deepEqual(parseEmailSendReview(raw,target).content,content);
 for(const next of [{...raw,account_id:'b'},{...raw,content:{...content,body:'Read the release notes.'}},{...raw,content:{...content,body_html:html.replace('https://example.test/notes','javascript:alert(1)')}}])assert.throws(()=>parseEmailSendReview(next,target));
});
