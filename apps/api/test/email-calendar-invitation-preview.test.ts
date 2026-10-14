import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {EmailInvitationPreviewService,EmailInvitationPreviewError} from '../src/lib/email-calendar-invitation-preview.js';
import {EmailMessageContentService} from '../src/lib/email-message-content.js';
import {NativeEmailCalendarPartsSchema} from '../src/lib/email-native-adapter-contract.js';
import {EmailMailboxCrypto} from '../src/lib/email-mailbox-crypto.js';
import {parseEnvironmentAppRunKeyrings} from '../src/lib/app-run-keyrings.js';
import type {EmailCapability,EmailMessageRecord} from '../src/lib/email-mailbox-service.js';
const scope={org_id:'org',owner_user_id:'owner',account_id:'account'},actor={user_id:'owner',web_session_id:'sid',access_expires_at:Date.parse('2026-10-04T12:10:00Z')},logical='mail_'+'a'.repeat(64);
const ics=(method='REQUEST',extra='')=>'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:'+method+'\r\nBEGIN:VEVENT\r\nUID:exact-invitation\r\nDTSTAMP:20261004T120000Z\r\nSEQUENCE:3\r\nDTSTART:20261005T120000Z\r\nDTEND:20261005T130000Z\r\nSUMMARY:Réunion 東京\r\nORGANIZER;CN=Organizer:mailto:organizer@example.test\r\nATTENDEE;RSVP=TRUE:mailto:owner@example.test\r\n'+extra+'END:VEVENT\r\nEND:VCALENDAR\r\n';
let PreviewConstructor=EmailInvitationPreviewService;
if(process.env.M7_BASELINE_PREVIEW){const require=createRequire(new URL('../src/lib/email-calendar-invitation-preview.ts',import.meta.url)),ts=require('typescript'),exports:any={},module={exports};
 new Function('exports','module','require',ts.transpileModule(readFileSync(process.env.M7_BASELINE_PREVIEW,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports,module,require);PreviewConstructor=module.exports.EmailInvitationPreviewService;}
function fixture(){
 let now=Date.parse('2026-10-04T12:00:00Z'),allowed=true,version='current-v1',sourceDigest='b'.repeat(64),body=ics(),address='owner@example.test',reads=0,extra:string[]=[],held:()=>Promise<void>=async()=>{};
 const cap=():EmailCapability=>({scope,resource_binding_id:'binding',authority_version:version,expires_at:actor.access_expires_at});
 const operations:string[]=[];const authority={async current(_actor:unknown,_scope:unknown,operation:string){operations.push(operation);if(!allowed)throw Error('EMAIL_ACCESS_DENIED');return structuredClone(cap());}};
 const keys=parseEnvironmentAppRunKeyrings(JSON.stringify({schema_version:'deft.app_run_keyring.v1',run_encryption:{current:'enc',keys:{enc:Buffer.alloc(32,12).toString('base64')}},receipt_signing:{current:'sig',keys:{sig:Buffer.alloc(32,13).toString('base64')}},fingerprint:{current:'fp',keys:{fp:Buffer.alloc(32,14).toString('base64')}}}));
 const cipher=new EmailMailboxCrypto(keys),content={async readCalendarParts(){reads++;await held();return NativeEmailCalendarPartsSchema.parse({schema_version:'deft.email_calendar_parts.v1',account_id:scope.account_id,logical_message_id:logical,provider:'gmail',source_digest:sourceDigest,receiving_identity:{primary_address:address,display_label:'Owner'},status:'available',parts:[body,...extra].map((text,i)=>({part_ref:(i+12).toString(16).repeat(64),ics_text:text,media_type_method:text.includes('METHOD:CANCEL')?'CANCEL':text.includes('METHOD:REPLY')?'REPLY':'REQUEST'}))});}};
 return {service:new PreviewConstructor(authority,content,cipher,()=>now),operations,keys,get reads(){return reads;},deny(){allowed=false;},set extra(v:string[]){extra=v;},set version(v:string){version=v;},set digest(v:string){sourceDigest=v;},set body(v:string){body=v;},set address(v:string){address=v;},set now(v:number){now=v;},set held(v:()=>Promise<void>){held=v;}};
}
test('duplicate MIME invitation representations collapse only exact identity/content and retain first scoped token',async t=>{
 const f=fixture();t.after(()=>f.keys.destroy());f.extra=[ics(),ics().replace('UID:exact-invitation','UID:another-invitation')];
 const result=await f.service.preview(actor,scope,logical);assert.equal(result.status,'available');assert.equal(result.parts.length,3);assert.equal(result.invitations.length,2);assert.equal(result.invitations[0]!.part_ref,'c'.repeat(64));
 const resolved=await f.service.resolve(actor,scope,result.invitations[0]!.preview_token!);assert.equal(resolved.token.part_ref,'c'.repeat(64));assert.equal(resolved.invitation.uid,'exact-invitation');
});
test('same identity conflicting content/version yields unsupported without any nomination',async t=>{
 for(const other of [ics().replace('Réunion 東京','Changed content'),ics().replace('SEQUENCE:3','SEQUENCE:4'),ics().replace('DTSTAMP:20261004T120000Z','DTSTAMP:20261004T130000Z')]){const f=fixture();t.after(()=>f.keys.destroy());f.extra=[other];
  const result=await f.service.preview(actor,scope,logical);assert.equal(result.status,'unsupported');assert.equal(result.reason,'INVITATION_IDENTITY_CONFLICT');assert.deepEqual(result.invitations,[]);}
});
test('held current source introducing conflicting part rejects old token and preserves late source authority checks',async t=>{
 for(const change of ['conflict','authority','source']){const f=fixture();t.after(()=>f.keys.destroy());const token=(await f.service.preview(actor,scope,logical)).invitations[0]!.preview_token!;
  let release!:()=>void,entered!:()=>void;const wait=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);f.held=async()=>{entered();await wait;};const pending=f.service.resolve(actor,scope,token);await ready;
  if(change==='conflict')f.extra=[ics().replace('SEQUENCE:3','SEQUENCE:4')];if(change==='authority')f.deny();if(change==='source')f.digest='e'.repeat(64);release();await assert.rejects(pending,/PREVIEW_STALE|ACCESS_DENIED/);
 }
});
test('authority availability failures are preserved rather than misclassified as revoked mailbox access',async t=>{
 const f=fixture();t.after(()=>f.keys.destroy());let reads=0;
 const service=new EmailInvitationPreviewService({async current(){throw Error('SQL_DEADLINE');}},{async readCalendarParts(){reads++;throw Error('must not fetch');}},new EmailMailboxCrypto(f.keys),()=>Date.parse('2026-10-04T12:00:00Z'));
 await assert.rejects(service.preview(actor,scope,logical),/SQL_DEADLINE/);assert.equal(reads,0);
});
test('read-only preview uses actual parser and receiving attendee, preserving recurring identity and unverified organizer boundary',async t=>{
 const f=fixture();t.after(()=>f.keys.destroy());f.body=ics('REQUEST','RRULE:FREQ=WEEKLY;COUNT=4\r\nEXDATE:20261012T120000Z\r\n');
 const result=await f.service.preview(actor,scope,logical);assert.equal(result.invitations.length,1);const invitation=result.invitations[0]!;
 assert.equal(invitation.summary,'Réunion 東京');assert.equal(invitation.recurring,true);assert.equal(invitation.rsvp_available,true);assert.equal(invitation.organizer_trust,'unverified_mail_data');assert.equal(invitation.receiving_attendee,'owner@example.test');
 assert.deepEqual(new Set(f.operations),new Set(['human_read']));assert.ok(invitation.preview_token);assert.ok(!invitation.preview_token.includes('organizer'));
 const resolved=await f.service.resolve(actor,scope,invitation.preview_token!);assert.equal(resolved.invitation.uid,'exact-invitation');assert.equal(resolved.invitation.rrule,'FREQ=WEEKLY;COUNT=4');assert.equal(resolved.invitation.exdates.length,1);assert.equal(f.reads,2);
});
test('tokens bind current owner/account/SID/source/authority/expiry and cannot nominate modified ICS',async t=>{
 for(const kind of ['owner','account','sid','source','version','body','expiry','tamper']){const f=fixture();t.after(()=>f.keys.destroy());const token=(await f.service.preview(actor,scope,logical)).invitations[0]!.preview_token!;
  let nextActor=actor,nextScope=scope,nextToken=token;
  if(kind==='owner')nextActor={...actor,user_id:'another'};if(kind==='account')nextScope={...scope,account_id:'another'};if(kind==='sid')nextActor={...actor,web_session_id:'other-sid'};
  if(kind==='source')f.digest='d'.repeat(64);if(kind==='version')f.version='current-v2';if(kind==='body')f.body=ics().replace('Réunion 東京','External edit');if(kind==='expiry')f.now=Date.parse('2026-10-04T12:05:01Z');if(kind==='tamper')nextToken=token.slice(0,-5)+'abcde';
  await assert.rejects(f.service.resolve(nextActor,nextScope,nextToken),error=>error instanceof EmailInvitationPreviewError);
 }
});
test('unrelated attendee, reply, delegated attendee and malformed ICS remain non-actionable without send authority',async t=>{
 const f=fixture();t.after(()=>f.keys.destroy());f.address='unrelated@example.test';let result=await f.service.preview(actor,scope,logical);assert.equal(result.invitations[0]!.rsvp_available,false);assert.equal(result.invitations[0]!.preview_token,null);
 f.address='owner@example.test';f.body=ics('REPLY');result=await f.service.preview(actor,scope,logical);assert.equal(result.invitations[0]!.preview_token,null);
 f.body=ics().replace('RSVP=TRUE','RSVP=TRUE;DELEGATED-TO="mailto:other@example.test"');result=await f.service.preview(actor,scope,logical);assert.equal(result.invitations[0]!.rsvp_available,false);
 f.body='BEGIN:VCALENDAR\r\nEND:VCALENDAR';result=await f.service.preview(actor,scope,logical);assert.equal(result.parts[0]!.status,'malformed');assert.deepEqual(result.invitations,[]);
 assert.ok(f.operations.every(operation=>operation==='human_read'));
});
test('held preview and apply nomination deny fresh revocation without emitting a token/model',async t=>{
 const f=fixture();t.after(()=>f.keys.destroy());let release!:()=>void,entered!:()=>void;const wait=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);f.held=async()=>{entered();await wait;};
 const pending=f.service.preview(actor,scope,logical);await ready;f.deny();release();await assert.rejects(pending,/EMAIL_INVITATION_ACCESS_DENIED/);
});
test('public content port fences source fingerprint and does not require send or modify for ICS extraction',async()=>{
 let reads=0,changed=false;const operations:string[]=[],cap={scope,resource_binding_id:'binding',authority_version:'current',expires_at:actor.access_expires_at};
 const record=():EmailMessageRecord=>({account_id:scope.account_id,logical_message_id:logical,revision:'1',received_at:'2026-10-04T12:00:00Z',folders:['inbox'],flags:{seen:false,flagged:false,answered:false},data:{},provider_source:{schema_version:'deft.email_provider_source.v1',account_id:scope.account_id,logical_message_id:logical,provider:'gmail',locator:{message_id:changed?'other':'message'}}});
 const service=new EmailMessageContentService({async current(_actor,_scope,operation){operations.push(operation);return cap;}},{async readMessage(){reads++;return record();}},
  {async readSource(){throw Error('not used');},async readCalendarParts(){return NativeEmailCalendarPartsSchema.parse({schema_version:'deft.email_calendar_parts.v1',account_id:scope.account_id,logical_message_id:logical,provider:'gmail',source_digest:'b'.repeat(64),receiving_identity:{primary_address:'owner@example.test',display_label:''},status:'available',parts:[{part_ref:'c'.repeat(64),ics_text:ics()}]});}},()=>Date.parse('2026-10-04T12:00:00Z'));
 assert.equal((await service.readCalendarParts(actor,scope,logical)).parts.length,1);assert.equal(reads,2);assert.ok(operations.every(operation=>operation==='human_read'));
 const changing=new EmailMessageContentService({async current(){return cap;}},{async readMessage(){return record();}},{async readSource(){throw Error();},async readCalendarParts(){changed=true;return {schema_version:'deft.email_calendar_parts.v1',account_id:scope.account_id,logical_message_id:logical,provider:'gmail',source_digest:'b'.repeat(64),receiving_identity:{primary_address:'owner@example.test',display_label:''},status:'available',parts:[]};}},()=>Date.parse('2026-10-04T12:00:00Z'));
 await assert.rejects(changing.readCalendarParts(actor,scope,logical),/EMAIL_ACCESS_DENIED/);
});
test('adapter DTO aggregate bound and unsupported completeness cannot be bypassed',()=>{
 const value={schema_version:'deft.email_calendar_parts.v1',account_id:'account',logical_message_id:logical,provider:'gmail',source_digest:'a'.repeat(64),receiving_identity:{primary_address:'owner@example.test',display_label:''},status:'available',parts:[{part_ref:'b'.repeat(64),ics_text:'a'.repeat(140000)},{part_ref:'c'.repeat(64),ics_text:'b'.repeat(140000)}]};
 assert.equal(NativeEmailCalendarPartsSchema.safeParse(value).success,false);assert.equal(NativeEmailCalendarPartsSchema.safeParse({...value,status:'unsupported',parts:[]}).success,false);
});
