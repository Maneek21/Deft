import {readFileSync,openSync,writeSync,fsyncSync,closeSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ImapFlow} from 'imapflow';
import nodemailer from 'nodemailer';
import {simpleParser} from 'mailparser';
import {validateAccountConfig,loadAccountConfig,tlsOptions,singleAddress} from './account-config.mjs';
import {loadMessageByLocator} from './mailbox-sync.mjs';
import {readMailboxLifecyclePage} from './mailbox-lifecycle.mjs';
import {canonicalMail,appendSentCopy} from './sent-copy.mjs';
import {withTransportIdentity,withReplyParent} from './transport-identity.mjs';
import {MailPreEffectValidationError} from './runtime-effect.mjs';

export class Journal {
 constructor(path){this.path=path;}
 rows(){return existsSync(this.path)?readFileSync(this.path,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];}
 append(row){const fd=openSync(this.path,'a',0o600);try{writeSync(fd,JSON.stringify({...row,at:new Date().toISOString()})+'\n');fsyncSync(fd);}finally{closeSync(fd);}}
 latest(run){return this.rows().filter(r=>r.run_id===run).at(-1);}
 reserve(run_id,digest,action){
  // A permanent exclusive reservation prevents another process from repeating
  // an effect whose result or journal append was lost. Manual reconciliation only.
  const key=createHash('sha256').update(run_id).digest('hex');let fd;
  try{fd=openSync(`${this.path}.reservation-${key}`,'wx',0o600);}catch{throw Error('TRANSPORT_OUTCOME_UNCERTAIN_NO_AUTOMATIC_RESEND');}
  try{writeSync(fd,JSON.stringify({run_id,digest,action}));fsyncSync(fd);}finally{closeSync(fd);}
 }
 reserveCopy(run_id,digest){const key=createHash('sha256').update(run_id).digest('hex'),fd=openSync(`${this.path}.copy-reservation-${key}`,'wx',0o600);try{writeSync(fd,JSON.stringify({run_id,digest}));fsyncSync(fd);}finally{closeSync(fd);}}
}
const clean=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\r\n\0]/.test(v);

export function createMailProvider(raw,{allowLoopbackFixture=false,legacySchema=false}={}) {
 const account=validateAccountConfig(raw,{allowLoopbackFixture});
 if(legacySchema&&account.mode!=='loopback_fixture')throw Error('EMAIL_ACCOUNT_CONFIG_INVALID');
 const imap=async(user=account.imap.auth.user)=>{
  if(user!==account.imap.auth.user&&!(account.mode==='loopback_fixture'&&user===account.fixture_recipient))throw Error('EMAIL_ACCOUNT_AUTHORITY_INVALID');
  const endpoint=account.imap;
  const client=new ImapFlow({host:endpoint.host,port:endpoint.port,secure:endpoint.tls==='implicit',doSTARTTLS:endpoint.tls==='starttls',tls:tlsOptions(endpoint),auth:{user,pass:endpoint.auth.password},logger:false,connectionTimeout:5000,socketTimeout:10000});
  try{await client.connect();return client;}catch{client.close();throw Error('EMAIL_IMAP_CONNECTION_FAILED');}
 };
 const smtp=(port)=>{
  const endpoint=account.smtp;if(port!==undefined&&(account.mode!=='loopback_fixture'||!Number.isInteger(port)||port<1||port>65535))throw Error('EMAIL_ACCOUNT_AUTHORITY_INVALID');
  return nodemailer.createTransport({host:endpoint.host,port:port??endpoint.port,secure:endpoint.tls==='implicit',requireTLS:endpoint.tls==='starttls',ignoreTLS:endpoint.tls==='none',tls:tlsOptions(endpoint),auth:{user:endpoint.auth.user,pass:endpoint.auth.password},logger:false,debug:false,connectionTimeout:5000,greetingTimeout:5000,socketTimeout:10000,disableFileAccess:true,disableUrlAccess:true});
 };
 const messages=async(user=account.imap.auth.user,mailbox='INBOX')=>{
  const c=await imap(user),lock=await c.getMailboxLock(mailbox);const out=[];let rawBytes=0;
  try{if(c.mailbox.exists)for await(const row of c.fetch('1:*',{source:true,uid:true,flags:true})){
   rawBytes+=row.source.byteLength;if(row.source.byteLength>8388608||rawBytes>16777216||out.length>=100)throw Error('MIME_FIXTURE_BUDGET');
   const m=await simpleParser(row.source);out.push({attachments:(m.attachments||[]).map((part,index)=>({key:'part-'+index+'-'+createHash('sha256').update(String(part.contentId||'')).update(String(part.filename||'')).digest('hex').slice(0,16),filename:part.filename||'attachment.csv',media_type:part.contentType,bytes:part.content})),id:`${c.mailbox.uidValidity}:${row.uid}`,uid:row.uid,uidvalidity:String(c.mailbox.uidValidity),mailbox,subject:(m.subject||'(no subject)').slice(0,200),body:(m.text||'').slice(0,4096),body_truncated:(m.text||'').length>4096,sender:m.from?.text?.slice(0,200)||'',recipients:m.to?.text?.slice(0,200)||'',message_id:(m.messageId||'').slice(0,200),in_reply_to:(m.inReplyTo||'').slice(0,200),references:(Array.isArray(m.references)?m.references.join(' '):m.references||'').slice(0,1000),revision:createHash('sha256').update(row.source).update([...row.flags].sort().join(',')).digest('hex')});
  }}finally{lock.release();await c.logout();}return out;
 };
 const syncPage=async(request,inventoryPath,authorityScope,onProgress)=>{if(typeof authorityScope!=='string'||!authorityScope||authorityScope.length>256)throw Error('EMAIL_SYNC_CACHE_SCOPE_REQUIRED');const client=await imap(),cacheScope=createHash('sha256').update(JSON.stringify({authorityScope,owner:account.owner,host:account.imap.host,port:account.imap.port,tls:account.imap.tls,user:account.imap.auth.user,folders:account.folders})).digest('hex');let page;try{page=await readMailboxLifecyclePage(client,{request,inventoryPath,cacheScope,configuredFolders:account.folders,onProgress});await client.logout();return page;}catch(error){page?.close();client.close();throw error;}};
 const parentByLocator=async id=>{const client=await imap();try{return await loadMessageByLocator(client,id,account.folders);}finally{await client.logout();}};
 const effect=async(journal,run_id,action,input,options={})=>{
  input=withTransportIdentity(run_id,action,input);
  if(!clean(run_id,120)||!input||typeof input!=='object'||Array.isArray(input))throw Error('EXACT_MAIL_INPUT_INVALID');
  const digest=createHash('sha256').update(JSON.stringify({action,input:Object.fromEntries(Object.entries(input).sort(([a],[b])=>a.localeCompare(b)))})).digest('hex');
  const prior=journal.latest(run_id);if(prior&&prior.digest!==digest)throw Error('RUN_INPUT_CHANGED');
  if(prior?.state==='observed'||prior?.state==='reported')return prior.output;
  if(!legacySchema&&prior?.smtp_accepted)return prior.output;
  if(prior)throw Error('TRANSPORT_OUTCOME_UNCERTAIN_NO_AUTOMATIC_RESEND');
  if(action==='archive_message'){
   if(!clean(input.resource_id,200))throw Error('ARCHIVE_TARGET_INVALID');
   const fixture=legacySchema;
   const parent=fixture?(await messages()).find(r=>r.id===input.resource_id):await parentByLocator(input.resource_id);
   if(!parent||(fixture&&parent.uidvalidity!==input.expected_uidvalidity)||(!fixture&&input.expected_uidvalidity!==undefined&&parent.uidvalidity!==input.expected_uidvalidity))throw Error('STALE_MAIL_PARENT');
   const sourceMailbox=fixture?'INBOX':parent.mailbox,destinationMailbox=fixture?'Archive':parent.archive_path;
   if(!destinationMailbox||sourceMailbox===destinationMailbox||(fixture&&(input.source_mailbox!==sourceMailbox||input.destination_mailbox!==destinationMailbox))||(!fixture&&((input.source_mailbox!==undefined&&input.source_mailbox!==sourceMailbox)||(input.destination_mailbox!==undefined&&input.destination_mailbox!==destinationMailbox))))throw Error('ARCHIVE_TARGET_INVALID');
   journal.reserve(run_id,digest,action);journal.append({run_id,digest,action,state:'prepared'});
   const c=await imap(),lock=await c.getMailboxLock(sourceMailbox);try{
    if(String(c.mailbox.uidValidity)!==parent.uidvalidity)throw Error('STALE_MAIL_PARENT');
    if(fixture)await c.mailboxCreate('Archive').catch(error=>{if(!String(error.message).includes('exist'))throw Error('ARCHIVE_MAILBOX_UNAVAILABLE');});
    journal.append({run_id,digest,action,state:'sending'});await c.messageMove(parent.uid,destinationMailbox,{uid:true});journal.append({run_id,digest,action,state:'accepted'});
   }finally{lock.release();await c.logout();}
   if(fixture){const archived=await messages(account.imap.auth.user,'Archive');if(!archived.some(r=>r.message_id===parent.message_id))throw Error('ARCHIVE_NOT_OBSERVED');}
  }else{
   if(!['send_message','reply_message'].includes(action)||!singleAddress(input.to)||!clean(input.subject,200)||!clean(input.message_id,200)||!/^<[^<>\s@]+@[^<>\s@]+>$/.test(input.message_id)||typeof input.body!=='string'||input.body.length>4096)throw new MailPreEffectValidationError();
   if(account.mode==='loopback_fixture'&&input.to!==account.fixture_recipient)throw new MailPreEffectValidationError();
   if(legacySchema&&(!input.message_id.startsWith('<c11-')||!input.message_id.endsWith('@email-lite.test>')))throw Error('EXACT_MAIL_INPUT_INVALID');
   if(action==='reply_message'){const parent=await parentByLocator(input.parent_resource_id);input=withReplyParent(input,parent);}
   const mime=legacySchema?null:await canonicalMail(account.owner,action,input);
   const identity={run_id,digest,action,...(mime?{mime_digest:mime.digest,message_id:input.message_id}:{})};
   journal.reserve(run_id,digest,action);journal.append({...identity,state:'prepared'});journal.append({...identity,state:'sending'});
   const transport=smtp(options.smtpPort);try{
    const accepted=await transport.sendMail(mime?{envelope:{from:account.owner,to:[input.to]},raw:mime.bytes}:{from:account.owner,to:input.to,envelope:{from:account.owner,to:[input.to]},subject:input.subject,text:input.body,messageId:input.message_id,...(action==='reply_message'?{inReplyTo:input.in_reply_to,references:input.references}:{})});
    if(!Array.isArray(accepted.accepted)||accepted.accepted.length!==1||accepted.accepted[0]!==input.to||accepted.rejected?.length)throw Error('SMTP_ACCEPTANCE_UNCONFIRMED');
    journal.append(legacySchema?{run_id,digest,action,state:'accepted'}:{...identity,state:'smtp_accepted',smtp_accepted:true,sent_copy_outcome:'unknown',output:{operation_id:`mail-${run_id}`,transport_outcome:'smtp_accepted',sent_copy_outcome:'unknown'}});
   }catch{journal.append({run_id,digest,action,state:'uncertain',reason:'transport response unavailable or denied; no automatic resend'});throw Error('EMAIL_SMTP_OUTCOME_UNCONFIRMED');}finally{transport.close();}
   if(!legacySchema)return appendSentCopy({connect:imap,folders:account.folders,mime,journal,identity});
   if(account.mode==='loopback_fixture'&&!(await messages(account.fixture_recipient)).some(r=>r.message_id===input.message_id))throw Error('SMTP_DELIVERY_NOT_OBSERVED');
  }
  const output={operation_id:`mail-${run_id}`,transport_outcome:action==='archive_message'?(legacySchema?'observed':'imap_move_accepted'):account.mode==='loopback_fixture'?'observed':'smtp_accepted',...(!legacySchema?{sent_copy_outcome:'not_applicable'}:{})};
  journal.append({run_id,digest,action,state:'observed',output});return output;
 };
 return {account,imap,smtp,messages,effect,syncPage};
}

let defaultProvider;
const defaults=()=>{
 if(!defaultProvider){const fixture=process.env.DEFT_EMAIL_LOOPBACK_FIXTURE==='true';const config=loadAccountConfig(process.env.DEFT_EMAIL_ACCOUNT_FILE??new URL('../transport/private-accounts.json',import.meta.url),{allowLoopbackFixture:fixture,allowLegacyFixture:fixture});defaultProvider=createMailProvider(config,{allowLoopbackFixture:fixture,legacySchema:process.env.DEFT_EMAIL_LEGACY_SCHEMA==='true'});}
 return defaultProvider;
};
export const imap=(...args)=>defaults().imap(...args);
export const smtp=(...args)=>defaults().smtp(...args);
export const messages=(...args)=>defaults().messages(...args);
export const effect=(...args)=>defaults().effect(...args);
export const syncPage=(...args)=>defaults().syncPage(...args);
