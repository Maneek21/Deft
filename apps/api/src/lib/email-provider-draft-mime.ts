import {createHash} from 'node:crypto';
import {canonicalCapabilityJson} from '@deft/shared';
import {parseNativeSafeComposeHtml} from '@deft/app-kit/experience';
import {parseNativeMailboxList} from '../../../../packages/app-kit/src/mailbox-list.js';
import {assertNativeReplyModeAvailable} from './email-native-reply-policy.js';
import {EmailDraftContentSchema,selectVerifiedDraftFromAddress} from './email-draft-service.js';
import {EmailAttachmentMetadataSchema,type EmailAttachmentMetadata} from './email-attachment-store.js';
import type {EmailDraftRow} from './email-draft-store.js';
import type {EmailScope,EmailCapability} from './email-mailbox-service.js';
import type {NativeEmailAccount,NativeEmailDraftMime} from './app-connection-contract.js';
import type {EmailNativeReplyContext} from './email-native-outgoing-snapshot.js';

export type EmailProviderDraftMimeInput=Readonly<{scope:EmailScope;draft:EmailDraftRow;capability:EmailCapability;recheck:()=>Promise<void>;signal?:AbortSignal}>;
type Ports={resolve(input:EmailProviderDraftMimeInput):Promise<{account:NativeEmailAccount;installation_id:string;serialize:NativeEmailDraftMime;
 verified_sender_identities?:readonly string[]}>;
 readFile(input:EmailProviderDraftMimeInput,file:EmailAttachmentMetadata):Promise<EmailAttachmentMetadata&{bytes:Uint8Array}>;
 readReply(input:EmailProviderDraftMimeInput,logicalId:string):Promise<EmailNativeReplyContext>};
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const fail=():never=>{throw Error('EMAIL_DRAFT_SYNC_CONTENT_INVALID');};

/** Queue-principal composition: no fabricated web session or Send reservation.
 * All identities, reply headers and attachment bytes come from trusted current
 * server ports. The account's primary sender is used; no From alias is inferred. */
export function createEmailProviderDraftMimeBuilder(ports:Ports){
 return async(input:EmailProviderDraftMimeInput)=>{
  const {scope,draft,recheck,signal}=input;await recheck();signal?.throwIfAborted();
  if(draft.status!=='draft'||draft.revision!==draft.content_revision)return fail();
  const content=EmailDraftContentSchema.parse(draft.content),selected=await ports.resolve(input),account=selected.account;
  if(content.body_html){try{if(parseNativeSafeComposeHtml(content.body_html,{inlineAttachments:content.attachments}).plainText!==content.body)return fail();}catch{return fail();}}
  if(!['gmail','microsoft'].includes(account.provider)||account.account_id!==scope.account_id||account.resource_binding_id!==input.capability.resource_binding_id
   ||account.health!=='connected'||!account.capabilities.includes('modify')||!account.capabilities.includes('read')||!selected.installation_id)return fail();
  const fromAddress=selectVerifiedDraftFromAddress(content,account.primary_address,selected.verified_sender_identities);
  if(!fromAddress)return fail();
  const parsed=(value:string)=>parseNativeMailboxList(value,{allowEmpty:true}).map(row=>({address:row.address,display_name:row.displayName}));
  const recipients={to:parsed(content.to),cc:parsed(content.cc),bcc:parsed(content.bcc)};
  if(recipients.to.length+recipients.cc.length+recipients.bcc.length>200)return fail();
  const readCurrentReply=async()=>{
   if(!content.reply_record_id)return null;
   const reply=await ports.readReply(input,content.reply_record_id);
   if(reply.account_id!==scope.account_id||reply.logical_message_id!==content.reply_record_id||reply.provider!==account.provider)return fail();
   assertNativeReplyModeAvailable(reply,content.mode,selected.verified_sender_identities??[account.primary_address]);return reply;
  };
  const reply=await readCurrentReply();if(['reply','reply_all'].includes(content.mode)&&!reply)return fail();
  const files:Array<EmailAttachmentMetadata&{bytes:Uint8Array}>=[];let mime:Uint8Array|undefined,body:Buffer|undefined,html:Buffer|undefined;
  try{
   for(const expected of content.attachments){
    signal?.throwIfAborted();const found=await ports.readFile(input,expected);
    files.push(found);
    const metadata=EmailAttachmentMetadataSchema.parse({file_id:found.file_id,filename:found.filename,media_type:found.media_type,size_bytes:found.size_bytes,sha256:found.sha256});
    if(!(found.bytes instanceof Uint8Array)||canonicalCapabilityJson(metadata)!==canonicalCapabilityJson(expected)||found.bytes.byteLength!==expected.size_bytes||hash(found.bytes)!==expected.sha256)return fail();
   }
   if(reply&&canonicalCapabilityJson(await readCurrentReply())!==canonicalCapabilityJson(reply))return fail();
   body=Buffer.from(content.body,'utf8');if(content.body_html)html=Buffer.from(content.body_html,'utf8');
   const limit=account.provider==='gmail'?35*1024*1024:3*1024*1024;
   // Stable per local draft revision makes raw comparisons/recovery meaningful.
   const stableId=hash(canonicalCapabilityJson([scope,draft.draft_id,draft.content_revision]));
   const value={scope:{org_id:scope.org_id,owner_id:scope.owner_user_id,installation_id:selected.installation_id},account_id:scope.account_id,
    authority_epoch:account.authority_epoch,provider:account.provider,verified_from:[{address:fromAddress,display_name:''}],
    captured_at:new Date(draft.updated_at).toISOString(),message_id:`<${stableId}@deft.invalid>`,
    limits:{max_recipients:200,max_body_bytes:1024*1024,max_files:32,max_file_bytes:25*1024*1024,max_total_file_bytes:25*1024*1024,max_mime_bytes:limit,
     allowed_media_types:files.length?[...new Set(files.map(file=>file.media_type))]:['application/octet-stream']},
    draft:{account_id:scope.account_id,draft_id:draft.draft_id,revision:draft.content_revision,mode:content.mode,from:{address:fromAddress,display_name:''},...recipients,
     subject:content.subject,body_format:html?'safe_html':'plain',body_bytes:body,...(html?{body_html_bytes:html}:{}),
     reply_parent:reply?{account_id:scope.account_id,org_id:scope.org_id,owner_id:scope.owner_user_id,logical_message_id:reply.logical_message_id,message_id:reply.message_id,
      references:[...reply.references],...(account.provider==='gmail'&&reply.thread_id?{thread_id:reply.thread_id}:{})}:null,
     files:files.map(file=>({file_id:file.file_id,account_id:scope.account_id,org_id:scope.org_id,owner_id:scope.owner_user_id,parent:{kind:'draft',id:draft.draft_id},availability:'ready',
      filename:file.filename,media_type:file.media_type,byte_count:file.size_bytes,digest:file.sha256,expires_at:'9999-12-31T23:59:59.999Z',bytes:file.bytes}))}};
   const result=await selected.serialize(value,{account_id:scope.account_id,draft_id:draft.draft_id,expected_revision:draft.content_revision});mime=result.mime_bytes;
   if(!(mime instanceof Uint8Array)||mime.byteLength>limit||hash(mime)!==result.mime_digest)return fail();
   await recheck();signal?.throwIfAborted();
   if(reply&&canonicalCapabilityJson(await readCurrentReply())!==canonicalCapabilityJson(reply))return fail();
   return {provider:account.provider as 'gmail'|'microsoft',authority_epoch:account.authority_epoch,mime_bytes:mime,mime_digest:result.mime_digest};
  }catch(error){mime?.fill(0);throw error;}
  finally{body?.fill(0);html?.fill(0);for(const file of files)file.bytes?.fill(0);}
 };
}
