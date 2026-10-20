import assert from 'node:assert/strict';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {parseSafeComposeHtml,parseNativeSafeComposeHtml} from '@deft/app-kit/experience';

// The saved-source probe selects exact pre-change consumers without overwriting
// authoring files. Normal repository runs always import the current consumers.
const consumer=(name:string)=>process.env.EMAIL_LINK_BASELINE
  ?pathToFileURL(`${process.env.EMAIL_LINK_BASELINE}/${name}.ts`).href
  :new URL(`../src/lib/${name}.js`,import.meta.url).href;
const {EmailDraftContentSchema,EmailDraftService,detachInvalidManagedSignature}=await import(consumer('email-draft-service'));
const {SignaturePreferencesSchema,signatureIdentityKey}=await import(consumer('email-signature-types'));
const {EmailTemplateContentSchema}=await import(consumer('email-template-store'));
const html='<p>Read <a href="https://intranet.test/guide?x=1&amp;y=2"><strong>the guide</strong></a>.</p>';
const body='Read the guide (https://intranet.test/guide?x=1&y=2).';
const content=(patch:Record<string,unknown>={})=>({mode:'compose',to:'person@example.test',cc:'',bcc:'',subject:'Links',body,body_html:html,reply_record_id:'',attachments:[],...patch});

test('native draft save keeps exact linked body and managed signature projection offsets',()=>{
 const signatureHtml='<p><a href="mailto:team@example.test">Contact the team</a></p>';
 const signaturePlain='Contact the team (mailto:team@example.test)';
 const fullHtml=html+signatureHtml,fullBody=body+'\n'+signaturePlain;
 const saved=EmailDraftContentSchema.parse(content({body:fullBody,body_html:fullHtml,from_identity:{address:'owner@example.test'},managed_signature:{
  schema_version:'deft.email_signature_region.v1',identity_key:signatureIdentityKey('owner@example.test'),preference_revision:1,
  plain:{start:body.length,text:'\n'+signaturePlain},rich:{start:html.length,html:signatureHtml}}}));
 assert.equal(detachInvalidManagedSignature(saved).managed_signature,saved.managed_signature);
 assert.equal(saved.body_html,fullHtml);assert.equal(saved.body,fullBody);
 const mismatched={...saved,body:fullBody+' changed'};
 const detached=detachInvalidManagedSignature(mismatched);assert.equal(detached.managed_signature,undefined);
 assert.equal(detached.body,mismatched.body);assert.equal(detached.body_html,fullHtml);
 const raw='<p><a href="javascript:bad">retained raw draft</a></p>';
 assert.equal(EmailDraftContentSchema.parse(content({body:'retained raw draft',body_html:raw})).body_html,raw);
});

test('native signature preferences use destination-aware plain text without widening legacy grammar',()=>{
 const preferences={identities:[{address:'owner@example.test',plain:body,html,placement:'both'}]};
 assert.deepEqual(SignaturePreferencesSchema.parse(preferences),preferences);
 assert.equal(SignaturePreferencesSchema.safeParse({identities:[{...preferences.identities[0],plain:'Read the guide.'}]}).success,false);
 assert.equal(SignaturePreferencesSchema.safeParse({identities:[{...preferences.identities[0],html:'<p><a href="https://user:pass@example.test/">unsafe</a></p>'}]}).success,false);
 assert.throws(()=>parseSafeComposeHtml(html));assert.equal(parseNativeSafeComposeHtml(html).plainText,body);
});

test('actual native draft create and reopen preserve linked managed content under current draft authority',async()=>{
 const scope={org_id:'org',owner_user_id:'owner',account_id:'account'},actor={user_id:'owner',web_session_id:'session',access_expires_at:Date.now()+60_000};
 const cap={scope,resource_binding_id:'binding',authority_version:'version',expires_at:Date.now()+60_000};
 const draftId='c0aeb341-0108-483e-b003-d1aa33800123';let retained:any,checks=0;
 const service=new EmailDraftService({current:async()=>{checks++;return cap;}} as any,{
  create:async(_scope:unknown,_id:unknown,value:unknown,_origin:unknown,guard:(tx:unknown)=>Promise<void>)=>{await guard({});retained={draft_id:draftId,content:value};return retained;},
  read:async(_scope:unknown,_id:unknown,guard:(tx:unknown)=>Promise<void>)=>{await guard({});return retained;},
 } as any);
 const prefix='<p>Intro</p>',signature='<p><a href="mailto:team@example.test">Team</a></p>',plain='Intro\nTeam (mailto:team@example.test)';
 const value=content({body:plain,body_html:prefix+signature,from_identity:{address:'owner@example.test'},managed_signature:{schema_version:'deft.email_signature_region.v1',identity_key:signatureIdentityKey('owner@example.test'),preference_revision:1,plain:{start:5,text:'\nTeam (mailto:team@example.test)'},rich:{start:prefix.length,html:signature}}});
 await service.create(actor,scope,draftId,value);const reopened=await service.read(actor,scope,draftId);
 assert.deepEqual(reopened.content,value);assert.equal(checks,4);
});

test('native template href placeholders, unsafe links, projection mismatch and rich overflow fail closed',()=>{
 const base={title:'Guide',subject:'',body,body_html:html};
 assert.deepEqual(EmailTemplateContentSchema.parse(base),base);
 for(const bad of [
  {...base,body:'Read the guide.'},
  {...base,body:'Guide',body_html:'<p><a href="https://example.test/{{target}}">Guide</a></p>'},
  {...base,body:'Guide',body_html:'<p><a href="file:///secret">Guide</a></p>'},
  {...base,body:'x'.repeat(262_144),body_html:'<p>'+'x'.repeat(262_144)+'</p>'},
 ])assert.equal(EmailTemplateContentSchema.safeParse(bad).success,false);
});


test('native long formatted body and template retain exact pair while whole JSON and signature entries remain independently bounded',()=>{
 for(const size of [20,96,220]){const text='x'.repeat(size*1024),rich='<p><strong>'+text+'</strong></p>';
  const draft=EmailDraftContentSchema.parse(content({body:text,body_html:rich}));assert.equal(draft.body_html,rich);
  const template={title:'Long',subject:'',body:text,body_html:rich};assert.deepEqual(EmailTemplateContentSchema.parse(template),template);
  assert.throws(()=>parseSafeComposeHtml(rich));assert.equal(parseNativeSafeComposeHtml(rich).plainText,text);
 }
 const text='😀'.repeat(100000),rich='<p>'+text+'</p>';assert.equal(parseNativeSafeComposeHtml(rich).plainText,text);
 assert.equal(EmailDraftContentSchema.safeParse(content({body:text,body_html:rich})).success,false);
 assert.equal(EmailTemplateContentSchema.safeParse({title:'Large pair',subject:'',body:text,body_html:rich}).success,false);
 assert.equal(SignaturePreferencesSchema.safeParse({identities:[{address:'owner@example.test',plain:'x'.repeat(2049),html:'<p>'+ 'x'.repeat(2049)+'</p>',placement:'both'}]}).success,false);
 const prefix='x'.repeat(96*1024),signature='<p>Team</p>',fullHtml='<p>'+prefix+'</p>'+signature,fullBody=prefix+'\nTeam';
 const saved=EmailDraftContentSchema.parse(content({body:fullBody,body_html:fullHtml,from_identity:{address:'owner@example.test'},managed_signature:{schema_version:'deft.email_signature_region.v1',identity_key:signatureIdentityKey('owner@example.test'),preference_revision:1,plain:{start:prefix.length,text:'\nTeam'},rich:{start:prefix.length+7,html:signature}}}));
 assert.equal(detachInvalidManagedSignature(saved).managed_signature,saved.managed_signature);
});
