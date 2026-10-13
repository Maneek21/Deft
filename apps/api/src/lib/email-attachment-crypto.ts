import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {canonicalCapabilityJson} from '@deft/shared';
import type {AppRunKeyProvider} from './app-run-keyrings.js';
import type {EmailScope} from './email-mailbox-service.js';
export type EmailAttachmentContext=EmailScope&{draft_id:string;file_id:string};
export type EmailAttachmentCiphertext={ciphertext:Buffer;key_version:string;nonce_b64:string;auth_tag_b64:string};
export const EMAIL_ATTACHMENT_MAX_BYTES=25*1024*1024;
const aad=(context:EmailAttachmentContext)=>Buffer.from(canonicalCapabilityJson(['deft.email.attachment.bytes.v1',context]));
/** Binary file encryption is separate from the bounded metadata JSON envelope. */
export class EmailAttachmentCrypto{
 constructor(private readonly keys:AppRunKeyProvider){}
 seal(context:EmailAttachmentContext,bytes:Uint8Array):EmailAttachmentCiphertext{
  if(bytes.byteLength>EMAIL_ATTACHMENT_MAX_BYTES)throw Error('EMAIL_ATTACHMENT_TOO_LARGE');
  const key=this.keys.current('run_encryption'),nonce=randomBytes(12),associated=aad(context);
  try{const cipher=createCipheriv('aes-256-gcm',key.key,nonce);cipher.setAAD(associated);
   return {ciphertext:Buffer.concat([cipher.update(bytes),cipher.final()]),key_version:key.key_id,nonce_b64:nonce.toString('base64'),auth_tag_b64:cipher.getAuthTag().toString('base64')};
  }finally{key.key.fill(0);nonce.fill(0);associated.fill(0);}
 }
 open(context:EmailAttachmentContext,envelope:EmailAttachmentCiphertext):Buffer{
  if(envelope.ciphertext.byteLength>EMAIL_ATTACHMENT_MAX_BYTES)throw Error('EMAIL_ATTACHMENT_UNAVAILABLE');
  const key=this.keys.read('run_encryption',envelope.key_version);if(!key)throw Error('EMAIL_ATTACHMENT_UNAVAILABLE');
  const nonce=Buffer.from(envelope.nonce_b64,'base64'),tag=Buffer.from(envelope.auth_tag_b64,'base64'),associated=aad(context);let partial:Buffer|undefined;
  try{if(nonce.length!==12||tag.length!==16||nonce.toString('base64')!==envelope.nonce_b64||tag.toString('base64')!==envelope.auth_tag_b64)throw Error('EMAIL_ATTACHMENT_UNAVAILABLE');
   const decipher=createDecipheriv('aes-256-gcm',key.key,nonce);decipher.setAAD(associated);decipher.setAuthTag(tag);partial=decipher.update(envelope.ciphertext);
   return Buffer.concat([partial,decipher.final()]);
  }finally{key.key.fill(0);nonce.fill(0);tag.fill(0);associated.fill(0);partial?.fill(0);}
 }
}
