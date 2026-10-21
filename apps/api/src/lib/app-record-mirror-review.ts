import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {AppRecordMirrorReviewRequestSchema} from '@deft/app-kit/core';
import type {AppRunKeyProvider} from './app-run-keyrings.js';
import {appDataDigest,appDataDenied} from './app-data-authority.js';
import {ReviewedRecordMirrorAuthoritySchema} from './app-record-mirror-authority.js';
const id=z.string().uuid();
export const RecordMirrorReviewTicketSchema=z.strictObject({schema_version:z.literal('deft.record_mirror_review_ticket.v1'),
 org_id:id,owner_user_id:id,web_session_id:id,experience_session_id:id,target_key:z.string(),
 receipt_id:id,previous_receipt_id:id.nullable(),request:AppRecordMirrorReviewRequestSchema,
 authority:ReviewedRecordMirrorAuthoritySchema,authority_digest:z.string().regex(/^sha256:[a-f0-9]{64}$/u),
 issued_at:z.iso.datetime(),expires_at:z.iso.datetime(),
}).refine(value=>value.authority_digest===appDataDigest(value.authority)
 &&Date.parse(value.issued_at)<Date.parse(value.expires_at)&&Date.parse(value.expires_at)-Date.parse(value.issued_at)<=120000
 &&value.authority.scope.org_id===value.org_id&&value.authority.scope.owner_user_id===value.owner_user_id
 &&value.authority.review_session_id===value.experience_session_id&&value.authority.scope.target_key===value.target_key);
export type RecordMirrorReviewTicket=z.infer<typeof RecordMirrorReviewTicketSchema>;
const domain=Buffer.from('deft.record_mirror_review_ticket.v1');
export function sealRecordMirrorReview(keys:AppRunKeyProvider,raw:RecordMirrorReviewTicket){const ticket=RecordMirrorReviewTicketSchema.parse(raw),bytes=Buffer.from(JSON.stringify(ticket)),ref=keys.current('run_encryption');try{if(bytes.length>65536)throw appDataDenied();const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',ref.key,nonce);cipher.setAAD(Buffer.concat([domain,Buffer.from('\0'+ref.key_id)]));return [Buffer.from(ref.key_id).toString('base64url'),nonce.toString('base64url'),Buffer.concat([cipher.update(bytes),cipher.final()]).toString('base64url'),cipher.getAuthTag().toString('base64url')].join('.');}finally{bytes.fill(0);ref.key.fill(0);}}
export function openRecordMirrorReview(keys:AppRunKeyProvider,token:string){let key:Buffer|undefined,bytes:Buffer|undefined;try{if(token.length>100000)throw Error();const parts=token.split('.');if(parts.length!==4||parts.some(part=>!/^[A-Za-z0-9_-]+$/u.test(part)))throw Error();const key_id=Buffer.from(parts[0]!,'base64url').toString('utf8'),ref=keys.read('run_encryption',key_id);if(!ref)throw Error();key=ref.key;const nonce=Buffer.from(parts[1]!,'base64url'),tag=Buffer.from(parts[3]!,'base64url');if(nonce.length!==12||tag.length!==16)throw Error();const decipher=createDecipheriv('aes-256-gcm',key,nonce);decipher.setAAD(Buffer.concat([domain,Buffer.from('\0'+key_id)]));decipher.setAuthTag(tag);bytes=Buffer.concat([decipher.update(Buffer.from(parts[2]!,'base64url')),decipher.final()]);if(bytes.length>65536)throw Error();return RecordMirrorReviewTicketSchema.parse(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes)));}catch{throw appDataDenied();}finally{key?.fill(0);bytes?.fill(0);}}
