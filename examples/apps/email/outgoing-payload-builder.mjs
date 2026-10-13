import {createHash} from 'node:crypto';
import {parseMailboxList,parseSafeComposeHtml} from '@deft/app-kit/experience';
import {createOutgoingSnapshotService,replyRecipients} from './outgoing-snapshot.mjs';
import {validateEmailAccount} from './account-registry.mjs';

const fail=()=>{throw Error('EMAIL_OUTGOING_PAYLOAD_UNAVAILABLE');};
const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;

/** Server-only MIME construction from host-loaded draft and verified custody.
 * The host retains this result before any reference is returned to the UI. */
export async function buildEmailActionPayload(request,verifiedAccount,trustedParent=null){
 const account=validateEmailAccount(verifiedAccount),binding=request.binding,draft=request.draft_value,input=request.input;
 const replying=['reply','reply_all'].includes(draft.mode);
 const keys=Object.keys(input??{}).sort().join(','),extended=['bcc,body,cc,parent_record_id,subject,to','bcc,body,cc,subject,to','bcc,body,body_html,cc,parent_record_id,subject,to','bcc,body,body_html,cc,subject,to'].includes(keys);
 const document=extended&&Object.hasOwn(input,'body_html'),hasParent=Object.hasOwn(input??{},'parent_record_id');
 const scalarKeys=extended?['to','cc','bcc','subject','body',...(document?['body_html']:[])]:['to','subject','body',...(Object.hasOwn(input??{},'cc')?['cc']:[])];
 if(binding.action_key!=='send_message'||!['compose','reply','reply_all','forward'].includes(draft.mode)||account.health!=='connected'
   ||!account.capabilities.includes('send')||account.connection_target!==binding.resource_target_key
   ||account.action_binding_id!==binding.runtime_binding_id||!['gmail','microsoft'].includes(account.provider)
   ||!Number.isSafeInteger(request.max_payload_bytes)||request.max_payload_bytes<1||request.max_payload_bytes>8388608
   ||!Array.isArray(request.files)||request.files.length>8||scalarKeys.some(key=>typeof input?.[key]!=='string'||input[key]!==draft[key])
   ||!(extended?(!replying||hasParent):(replying?keys==='body,cc,parent_record_id,subject,to':['body,subject,to','body,cc,parent_record_id,subject,to'].includes(keys)))
   ||!replying&&hasParent&&(input.parent_record_id!==''||draft.reply_record_id!=='')
   ||!replying&&!hasParent&&(!extended&&draft.cc!==undefined&&draft.cc!==''||draft.reply_record_id!==undefined&&draft.reply_record_id!=='')
   ||!extended&&draft.bcc!==undefined&&draft.bcc!==''||!document&&draft.body_html!==undefined&&draft.body_html!=='')fail();
 const rich=document&&input.body_html!=='';
 try{if(rich&&parseSafeComposeHtml(input.body_html).plainText!==input.body)fail();}catch{fail();}
 const scope={org_id:binding.org_id,owner_id:binding.owner_user_id,installation_id:binding.installation_id};
 const address=value=>({address:value,display_name:''});
 let selected;
 try{
  const mailboxes=(value,allowEmpty=false)=>parseMailboxList(value,{maxItems:32,allowEmpty}).map(row=>({address:row.address,display_name:row.displayName}));
  selected={to:mailboxes(input.to),cc:mailboxes(input.cc??'',true),bcc:mailboxes(input.bcc??'',true)};
  if(selected.to.length+selected.cc.length+selected.bcc.length>(extended?200:32))fail();
 }catch{fail();}
 if(replying){
  if(!trustedParent||trustedParent.account_id!==account.account_id||trustedParent.authority_epoch!==account.authority_epoch||trustedParent.org_id!==scope.org_id||trustedParent.owner_id!==scope.owner_id||trustedParent.record_id!==input.parent_record_id||input.parent_record_id!==draft.reply_record_id||typeof input.cc!=='string'||input.cc!==draft.cc)fail();
  const expected=replyRecipients(trustedParent,account.verified_sender_identities.map(address),{all:draft.mode==='reply_all',maxRecipients:extended?200:32});
  const addresses=rows=>JSON.stringify(rows.map(row=>row.address.toLowerCase()));
  if(addresses(selected.to)!==addresses(expected.to)||addresses(selected.cc)!==addresses(expected.cc))fail();
 }else if(trustedParent!==null)fail();

 // Date and Message-ID are stable for an unchanged saved draft/account. Repeat
 // capture therefore reuses exactly the same retained MIME instead of growing.
 const captured_at=new Date(request.draft_updated_at).toISOString();
 const message_id=`<${Buffer.from(hash(JSON.stringify(canonical({binding,account_id:account.account_id,epoch:account.authority_epoch}))), 'hex').toString('base64url')}@deft.invalid>`;
 let retained;
 const snapshots=createOutgoingSnapshotService({
  resolve:async()=>({scope,account_id:account.account_id,authority_epoch:account.authority_epoch,provider:account.provider,
   verified_from:account.verified_sender_identities.map(address),captured_at,message_id,
   limits:{max_recipients:extended?200:32,max_body_bytes:rich?65536:16384,max_files:request.files_policy?.max_files_per_record??1,
    max_file_bytes:request.files_policy?.max_file_bytes??2097152,max_total_file_bytes:request.files_policy?.max_total_bytes_per_record??2097152,
    max_mime_bytes:request.max_payload_bytes,allowed_media_types:request.files_policy?.allowed_media_types??['application/pdf']},
   draft:{account_id:account.account_id,draft_id:binding.draft_id,revision:binding.draft_revision,mode:draft.mode,
    from:address(account.primary_address),...selected,subject:input.subject,body_format:rich?'safe_html':'plain',
    body_bytes:Buffer.from(input.body,'utf8'),...(rich?{body_html_bytes:Buffer.from(input.body_html,'utf8')}:{}),reply_parent:trustedParent,files:request.files.map(({reference,bytes})=>({
     file_id:reference.file_id,account_id:account.account_id,org_id:scope.org_id,owner_id:scope.owner_id,
     parent:{kind:'draft',id:binding.draft_id},availability:'ready',filename:reference.filename,media_type:reference.media_type,
     byte_count:reference.byte_length,digest:reference.digest,expires_at:reference.expires_at,bytes,
    }))}}),
  seal:async value=>{retained=value;return {snapshot_id:'host-retains-after-build',sealed_contract:'host-retains-after-build'};},
  verify:async()=>false,reserve:async()=> 'unknown',
 });
 await snapshots.prepare({account_id:account.account_id,draft_id:binding.draft_id,expected_revision:binding.draft_revision});
 if(!retained)fail();
 return {bytes:retained.mime_bytes,metadata:{schema_version:'deft.email_action_payload.v1',
  account,body_text:input.body,...(rich?{body_html:input.body_html}:{}),payload:retained.payload,payload_digest:retained.payload_digest,
  preview:{items:[{key:'from',label:'From',value:account.primary_address},{key:'to',label:'To',value:input.to},
   ...(Object.hasOwn(input,'cc')?[{key:'cc',label:'Cc',value:input.cc}]:[]),...(extended?[{key:'bcc',label:'Bcc',value:input.bcc}]:[]),{key:'subject',label:'Subject',value:input.subject},{key:'body',label:'Message',value:input.body}],
   files:request.files.map(file=>file.reference)}}};
}
