import {createHash} from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import {resolveMailboxFolders} from './mailbox-sync.mjs';

export async function canonicalMail(owner,action,input,now=new Date()){
 const bytes=await new Promise((resolve,reject)=>new MailComposer({from:owner,to:input.to,subject:input.subject,text:input.body,messageId:input.message_id,date:now,newline:'windows',disableFileAccess:true,disableUrlAccess:true,...(action==='reply_message'?{inReplyTo:input.in_reply_to,references:input.references}:{})}).compile().build((error,buffer)=>error?reject(error):resolve(buffer)));
 if(!Buffer.isBuffer(bytes)||bytes.length>65536)throw Error('EMAIL_MIME_BUDGET');
 return {bytes,date:now,digest:createHash('sha256').update(bytes).digest('hex')};
}
export async function appendSentCopy({connect,folders,mime,journal,identity}){
 let client,issued=false;
 const record=(state,outcome)=>{const output={operation_id:`mail-${identity.run_id}`,transport_outcome:'smtp_accepted',sent_copy_outcome:outcome};journal.append({...identity,state,smtp_accepted:true,sent_copy_outcome:outcome,output});return output;};
 try{
  client=await connect();const sent=(await resolveMailboxFolders(client,folders)).find(folder=>folder.key==='sent')?.path;
  if(!sent)return record('append_failed','failed');
  journal.reserveCopy(identity.run_id,identity.digest);record('append_started','unknown');issued=true;
  const accepted=await client.append(sent,mime.bytes,['\\Seen'],mime.date);
  return accepted?record('append_accepted','accepted'):record('append_unknown','unknown');
 }catch(error){return record(issued&&!['NO','BAD'].includes(error?.responseStatus)?'append_unknown':'append_failed',issued&&!['NO','BAD'].includes(error?.responseStatus)?'unknown':'failed');}
 finally{if(client){try{await client.logout();}catch{client.close();}}}
}
