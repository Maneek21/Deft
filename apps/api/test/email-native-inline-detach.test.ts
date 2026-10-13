import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {emailDrafts,emailAttachments,emailAccounts} from '@deft/db/schema';
import {EmailMailboxCrypto} from '../src/lib/email-mailbox-crypto.js';
import {EmailAttachmentCrypto} from '../src/lib/email-attachment-crypto.js';
import {emailDraftContext} from '../src/lib/email-draft-store.js';
import {EmailDraftContentSchema,detachInvalidManagedSignature} from '../src/lib/email-draft-service.js';
import {signatureIdentityKey} from '../src/lib/email-signature-types.js';
const {EmailAttachmentStore}=await import(process.env.EMAIL_INLINE_STORE_BASELINE??new URL('../src/lib/email-attachment-store.js',import.meta.url).href);
const scope={org_id:'synthetic-org',owner_user_id:'synthetic-owner',account_id:'synthetic-account'},draftId=randomUUID(),fileId=randomUUID();
const keys={current:()=>({key_id:'fixture',key:Buffer.alloc(32,21)}),read:(_p:unknown,id:string)=>({key_id:id,key:Buffer.alloc(32,21)}),keyIds:()=>['fixture']};
function harness(html:string,denyFinal=false){
 const crypto=new EmailMailboxCrypto(keys),binary=new EmailAttachmentCrypto(keys),file={file_id:fileId,filename:'diagram.png',media_type:'image/png',size_bytes:68,sha256:'a'.repeat(64)};
 const content={mode:'compose',to:'recipient@example.test',cc:'',bcc:'',subject:'Owned image',body:'[Image: Diagram]',body_html:html,reply_record_id:'',attachments:[file]};
 let row:any={...scope,draft_id:draftId,revision:3,content_revision:3,status:'draft',content_envelope:crypto.seal(content,emailDraftContext(scope,draftId,3))},attachment:any={file_id:fileId,detached_at:null},writes=0,guards=0;
 const tx:any={select:()=>({from:(table:unknown)=>{const result=table===emailDrafts?[row]:table===emailAttachments?[attachment]:table===emailAccounts?[{enabled:false}]:[];
  const query:any={where:()=>query,for:()=>query,limit:()=>query,then:(accept:any,reject:any)=>Promise.resolve(result).then(accept,reject)};return query;}}),
  update:(table:unknown)=>({set:(values:unknown)=>({where:async()=>{writes++;if(table===emailDrafts)row={...row,...values as any};else attachment={...attachment,...values as any};}})})};
 const database={transaction:async(use:any)=>{const savedRow=row,savedFile=attachment;try{return await use(tx);}catch(error){row=savedRow;attachment=savedFile;throw error;}}};
 const guard=async()=>{if(++guards===2&&denyFinal)throw Error('REVOKED');};
 const store=new EmailAttachmentStore(database as any,crypto,binary);
 return {detach:()=>store.detach(scope,draftId,3,fileId,guard),read:()=>EmailDraftContentSchema.parse(crypto.open(row.content_envelope,emailDraftContext(scope,draftId,row.content_revision))),state:()=>({revision:row.revision,detached:attachment.detached_at,writes,guards})};
}
test('actual encrypted store refuses referenced or invalid CID body before any detach write',async()=>{
 for(const html of [`<p><img src="cid:deft-${fileId}@deft.invalid" alt="Diagram"></p>`,`<p><img src="cid:deft-${randomUUID()}@deft.invalid" alt="Diagram"></p>`,`<p><img src="cid:deft-${fileId}@deft.invalid" alt="Diagram" onerror="bad"></p>`]){
  const h=harness(html);await assert.rejects(h.detach(),/EMAIL_DRAFT_CONFLICT/);assert.equal(h.state().writes,0);assert.equal(h.state().revision,3);assert.equal(h.state().detached,null);
 }
});
test('full managed-signature body accepts owned inline prefix while entry metadata remains image-closed',()=>{
 const file={file_id:fileId,filename:'diagram.png',media_type:'image/png',size_bytes:68,sha256:'a'.repeat(64)},prefix=`<p><img src="cid:deft-${fileId}@deft.invalid" alt="Diagram"></p>`,suffix='<p>Owner</p>',plain='[Image: Diagram]';
 const content=EmailDraftContentSchema.parse({mode:'compose',to:'recipient@example.test',cc:'',bcc:'',subject:'Images',body:plain+'\nOwner',body_html:prefix+suffix,reply_record_id:'',attachments:[file],from_identity:{address:'owner@example.test'},
  managed_signature:{schema_version:'deft.email_signature_region.v1',identity_key:signatureIdentityKey('owner@example.test'),preference_revision:1,plain:{start:plain.length,text:'\nOwner'},rich:{start:prefix.length,html:suffix}}});
 assert.deepEqual(detachInvalidManagedSignature(content),content);
 const forged={...content,managed_signature:{...content.managed_signature!,plain:{start:0,text:content.body},rich:{start:0,html:content.body_html}}};
 const detached=detachInvalidManagedSignature(forged);assert.equal(detached.managed_signature,undefined);assert.equal(detached.body_html,content.body_html);assert.equal(detached.body,content.body);
});
test('actual store keeps acknowledged plain placeholder while detaching; late guard rolls back both envelopes',async()=>{
 const html='<p>[Image: Diagram]</p>',h=harness(html);assert.equal((await h.detach()).revision,4);assert.equal(h.state().writes,2);assert.ok(h.state().detached);assert.equal(h.read().body_html,html);assert.deepEqual(h.read().attachments,[]);
 const denied=harness(html,true);await assert.rejects(denied.detach(),/REVOKED/);assert.equal(denied.state().revision,3);assert.equal(denied.state().detached,null);assert.equal(denied.read().attachments.length,1);
});
