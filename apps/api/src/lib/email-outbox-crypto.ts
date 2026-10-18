import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {canonicalCapabilityJson} from '@deft/shared';
import {z} from 'zod';
import type {AppRunKeyProvider} from './app-run-keyrings.js';
import {EmailOutboxScopeSchema} from './email-outbox-contract.js';
import type {EmailScope} from './email-mailbox-service.js';
export const EMAIL_OUTBOX_MIME_MAX_BYTES=35*1024*1024;
export type EmailOutboxMimeContext=EmailScope&{outbox_id:string;operation_id:string;mime_digest:string};
export type EmailOutboxMimeEnvelope={ciphertext:Buffer;key_version:string;nonce_b64:string;auth_tag_b64:string};
const Context=EmailOutboxScopeSchema.extend({outbox_id:z.string().uuid(),operation_id:z.string().uuid(),mime_digest:z.string().regex(/^[a-f0-9]{64}$/u)});
const aad=(c:EmailOutboxMimeContext)=>Buffer.from(canonicalCapabilityJson(['deft.email.outbox.mime.v1',Context.parse(c)]));
export class EmailOutboxCrypto{
 constructor(private readonly keys:AppRunKeyProvider){}
 seal(context:EmailOutboxMimeContext,bytes:Uint8Array):EmailOutboxMimeEnvelope{
  if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>EMAIL_OUTBOX_MIME_MAX_BYTES)throw Error('EMAIL_OUTBOX_LIMIT');
  const associated=aad(context),key=this.keys.current('run_encryption'),nonce=randomBytes(12);
  try{const cipher=createCipheriv('aes-256-gcm',key.key,nonce);cipher.setAAD(associated);return {ciphertext:Buffer.concat([cipher.update(bytes),cipher.final()]),key_version:key.key_id,nonce_b64:nonce.toString('base64'),auth_tag_b64:cipher.getAuthTag().toString('base64')};}
  finally{key.key.fill(0);nonce.fill(0);associated.fill(0);}
 }
 open(context:EmailOutboxMimeContext,envelope:EmailOutboxMimeEnvelope):Buffer{
  if(!envelope.ciphertext.length||envelope.ciphertext.length>EMAIL_OUTBOX_MIME_MAX_BYTES)throw Error('EMAIL_OUTBOX_UNAVAILABLE');
  const associated=aad(context),key=this.keys.read('run_encryption',envelope.key_version);if(!key){associated.fill(0);throw Error('EMAIL_OUTBOX_UNAVAILABLE');}
  const nonce=Buffer.from(envelope.nonce_b64,'base64'),tag=Buffer.from(envelope.auth_tag_b64,'base64');let partial:Buffer|undefined;
  try{if(nonce.length!==12||tag.length!==16||nonce.toString('base64')!==envelope.nonce_b64||tag.toString('base64')!==envelope.auth_tag_b64)throw Error('EMAIL_OUTBOX_UNAVAILABLE');
   const decipher=createDecipheriv('aes-256-gcm',key.key,nonce);decipher.setAAD(associated);decipher.setAuthTag(tag);partial=decipher.update(envelope.ciphertext);return Buffer.concat([partial,decipher.final()]);}
  finally{key.key.fill(0);associated.fill(0);nonce.fill(0);tag.fill(0);partial?.fill(0);}
 }
}
