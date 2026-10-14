import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {createEmailImapHost,type EmailImapHostAccount,type EmailImapFlowConstructor} from '../src/lib/email-imap-host.js';
import {createEmailSmtpHost} from '../src/lib/email-smtp-host.js';
import {EmailImapCredentialCustody,type EmailImapCredentialRecord} from '../src/lib/email-imap-custody.js';
// @ts-ignore -- registered provider bundle is JavaScript.
import {createNativeImapBridge} from '../../../examples/apps/email/providers/native-imap.mjs';
// @ts-ignore -- registered provider bundle is JavaScript.
import {createNativeImapEffectsBridge} from '../../../examples/apps/email/providers/native-imap-effects.mjs';
// @ts-ignore -- registered provider bundle is JavaScript.
import {LogicalMailIndex} from '../../../examples/apps/email/logical-mail-index.mjs';
// @ts-ignore -- registered provider bundle is JavaScript.
import {providerSourceForParent} from '../../../examples/apps/email/providers/provider-browser.mjs';
import {NativeEmailPresentationSchema, NativeEmailFileSchema} from '../src/lib/email-native-adapter-contract.js';
const readerMime=Buffer.from('From: sender@example.test\r\nTo: owner@example.test\r\nSubject: Real host reader fixture\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=reader\r\n\r\n--reader\r\nContent-Type: text/plain\r\n\r\nVisible body\r\n--reader\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=proof.txt\r\nContent-Transfer-Encoding: base64\r\n\r\n'+Buffer.from('Exact decoded proof').toString('base64')+'\r\n--reader--\r\n');
async function fixture(){
 const scope={org_id:'org-host-bridge',owner_user_id:'owner-host-bridge',account_id:'account-host-bridge'};let stored:EmailImapCredentialRecord|null=null,connects=0,logouts=0,closes=0,afterList=()=>{};
 const custody=new EmailImapCredentialCustody({current:()=>({key_id:'fixture',key:Buffer.alloc(32,41)}),read:(_purpose,id)=>id==='fixture'?{key_id:id,key:Buffer.alloc(32,41)}:null,keyIds:()=>['fixture']},{read:async()=>structuredClone(stored),compareAndSwap:async value=>{if((stored?.connection_revision??0)!==value.expected_revision)return false;stored=structuredClone(value.record);return true;}});
 const identity=await custody.saveProfile(scope,0,{host:'imap.example.test',port:993,transport:'implicit_tls',username:'owner@example.test',password:'synthetic-fixture-only',smtp:{host:'smtp.example.test',port:465,transport:'implicit_tls',username:'owner@example.test',password:'synthetic-smtp-fixture-only'}},async()=>{});
 const account:EmailImapHostAccount={...scope,installation_id:'installation-host-bridge',resource_binding_id:'binding-host-bridge',provider:'imap_smtp',authority_epoch:1,...identity,health:'connected',capabilities:['read','modify','send'],primary_address:'owner@example.test',display_label:'Native real host fixture',connection_target:'host-target',action_binding_id:'action-binding',verified_sender_identities:['owner@example.test']};
 let clientOptions:any;
 class Client{authenticated=true;secureConnection=true;tls={authorized:true};enabled=new Set(['CONDSTORE']);mailbox:any;options:any;
  constructor(options:any){this.options=options;clientOptions=options;}
  async connect(){connects++;}async logout(){logouts++;}close(){closes++;}
  async list(){afterList();return [{path:'INBOX',flags:new Set()}];}
  async getMailboxLock(path:string,options:any){assert.equal(path,'INBOX');assert.deepEqual(options,{readOnly:true});this.mailbox={path,uidValidity:100n,uidNext:1,exists:0,highestModseq:1n,readOnly:true};return {release(){}};}
  async fetchOne(uid:number,query:any,options:any){assert.equal(uid,7);assert.deepEqual(query,{uid:true,size:true});assert.deepEqual(options,{uid:true});return {uid:7,size:readerMime.length};}
  async download(uid:number,part:any,options:any){assert.equal(uid,7);assert.equal(part,undefined);assert.equal(options.uid,true);return {meta:{expectedSize:readerMime.length},content:Readable.from([readerMime])};}
 }
 const host=createEmailImapHost({custody,current:async()=>structuredClone(account),ImapFlow:Client as unknown as EmailImapFlowConstructor,lookup:async()=>[{address:'8.8.8.8',family:4}]});
 const context={...scope,installation_id:account.installation_id,resource_binding_id:account.resource_binding_id,authority_version:'current',expires_at:Date.now()+60000,recheck:async()=>{},provider_state:{read:async()=>null,stale:async()=>[]}};
 return {bridge:createNativeImapBridge({host}),custody,host,account,context,get counts(){return {connects,logouts,closes};},get options(){return clientOptions;},set afterList(value:()=>void){afterList=value;}};
}
test('native read bridge composes real TS host and encrypted profile using stripped expected native descriptor',async()=>{
 const f=await fixture(),status=await f.bridge.nativeEmailAccount(f.context);assert.equal(status.provider,'imap_smtp');assert.equal(Object.hasOwn(status,'org_id'),false);assert.equal(Object.hasOwn(status,'action_binding_id'),false);assert.equal(f.counts.connects,0);
 const page=await f.bridge.nativeEmailPage({cursor:null,limit:10},f.context);assert.equal(page.account_id,f.account.account_id);assert.deepEqual(page.items,[]);assert.equal(page.complete,false);assert.equal(page.state_updates.length,2);assert.equal(f.counts.connects,1);assert.equal(f.counts.logouts,1);assert.equal(f.counts.closes,1);
 assert.equal(f.options.tls.rejectUnauthorized,true);assert.equal(f.options.auth.pass,'');
});
test('real TS IMAP host rejects held principal change and releases connection before any page can commit',async()=>{
 const f=await fixture();f.afterList=()=>{(f.account as any).principal_digest='b'.repeat(64);};await assert.rejects(f.bridge.nativeEmailPage({cursor:null,limit:10},f.context));assert.equal(f.counts.connects,1);assert.equal(f.counts.logouts,1);assert.equal(f.counts.closes,1);assert.equal(f.options.auth.pass,'');
});
test('native IMAP source/presentation/file compose real encrypted custody host and shared public result validators',async()=>{
 const f=await fixture(),scope={org_id:f.account.org_id,owner_id:f.account.owner_user_id,installation_id:f.account.installation_id};
 const parent=new LogicalMailIndex(scope).upsert(scope,{account_id:f.account.account_id,provider:'imap_smtp',locator:{kind:'imap_smtp',mailbox:'INBOX',uidvalidity:'100',uid:7}}),source=providerSourceForParent(f.account,parent);
 const original=await f.bridge.nativeEmailSource({source},f.context);assert.deepEqual(Buffer.from(original.mime_bytes),readerMime);assert.equal(original.digest,createHash('sha256').update(readerMime).digest('hex'));
 const presentation=NativeEmailPresentationSchema.parse(await f.bridge.nativeEmailPresentation({source},f.context));assert.equal(presentation.provider,'imap_smtp');assert.equal(presentation.content_trust,'unsanitized');assert.equal(presentation.presentation.metadata.primary_address,'owner@example.test');assert.equal(presentation.files.length,1);
 const file=NativeEmailFileSchema.parse(await f.bridge.nativeEmailFile({source,source_digest:presentation.source_digest,file_ref:presentation.files[0]!.file_ref},f.context));assert.equal(Buffer.from(file.bytes).toString(),'Exact decoded proof');assert.equal(file.byte_length,19);
 assert.equal(f.counts.connects,3);assert.equal(f.counts.logouts,3);assert.equal(f.counts.closes,3);assert.equal(f.options.auth.pass,'');
});
test('native SMTP effects compose real TS encrypted custody/TLS host, including immutable Bcc envelope and cleanup',async()=>{
 const f=await fixture();let options:any,sent=0,closed=0,reserved=0,raw:Uint8Array|undefined;
 const envelope={from:'owner@example.test',to:['to@example.test','cc@example.test','blind@example.test']};
 const smtp=createEmailSmtpHost({custody:f.custody,current:async()=>structuredClone(f.account),lookup:async()=>[{address:'8.8.8.8',family:4}],createTransport:value=>{options=value;return {async sendMail(packet){sent++;raw=packet.raw;assert.deepEqual(packet.envelope,envelope);assert.equal(packet.disableFileAccess,true);assert.equal(packet.disableUrlAccess,true);assert.equal(reserved,1);assert.equal(/^Bcc:/mi.test(Buffer.from(packet.raw).toString()),false);return {accepted:envelope.to,rejected:[]};},close(){closed++;}};}});
 const bridge=createNativeImapEffectsBridge({host:{...f.host,...smtp}}),bytes=Buffer.from('From: owner@example.test\r\nTo: to@example.test\r\nCc: cc@example.test\r\nSubject: Synthetic SMTP\r\n\r\nExact bytes');
 const result=await bridge.nativeEmailSend({operation_id:randomUUID(),mime_bytes:bytes,mime_digest:createHash('sha256').update(bytes).digest('hex'),from_address:envelope.from,envelope},
  {...f.context,send_before_reserve:async()=>{reserved++;return true;}});
 assert.equal(result.provider,'imap_smtp');assert.equal(result.transport_outcome,'provider_accepted');assert.equal(result.sent_copy_outcome,'pending');assert.equal(sent,1);assert.equal(closed,1);
 assert.equal(options.host,'8.8.8.8');assert.equal(options.tls.servername,'smtp.example.test');assert.equal(options.tls.rejectUnauthorized,true);assert.equal(options.requireTLS,true);assert.equal(options.auth.pass,'');assert.ok(raw&&[...raw].every(byte=>byte===0));assert.ok(bytes.some(byte=>byte!==0));
});
