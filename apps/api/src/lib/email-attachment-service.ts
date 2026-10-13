import { EmailOperationActorSchema } from './email-agent-actor.js';
import {z} from 'zod';
import type {EmailOperationActor,EmailAuthority,EmailOperation,EmailScope} from './email-mailbox-service.js';
import {EmailAttachmentStore,EmailAttachmentMetadataSchema,type EmailAttachmentMetadata} from './email-attachment-store.js';
const Identifier=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const Scope=z.strictObject({org_id:Identifier,owner_user_id:Identifier,account_id:Identifier});
const Actor = EmailOperationActorSchema;
const UUID=z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
const Revision=z.number().int().min(1).max(2147483645);
export class EmailAttachmentService{
 constructor(private readonly authority:EmailAuthority,private readonly store:EmailAttachmentStore,private readonly now=Date.now){}
 private async authorize(rawActor:EmailOperationActor,rawScope:EmailScope,signal?:AbortSignal,operation:EmailOperation='human_draft'){
  const actor=Object.freeze(Actor.parse(rawActor)),scope=Object.freeze(Scope.parse(rawScope));
  if(actor.user_id!==scope.owner_user_id||actor.access_expires_at<=this.now())throw Error('EMAIL_ATTACHMENT_ACCESS_DENIED');
  signal?.throwIfAborted();const current=await this.authority.current(actor,scope,operation,undefined,signal);
  const valid=(cap:typeof current)=>cap.scope.org_id===scope.org_id&&cap.scope.owner_user_id===scope.owner_user_id&&cap.scope.account_id===scope.account_id
   &&Number.isFinite(cap.expires_at)&&cap.expires_at>this.now()&&Identifier.safeParse(cap.authority_version).success&&Identifier.safeParse(cap.resource_binding_id).success;
  if(!valid(current))throw Error('EMAIL_ATTACHMENT_ACCESS_DENIED');
  const guard=async(tx:unknown)=>{signal?.throwIfAborted();if(actor.access_expires_at<=this.now())throw Error('EMAIL_ATTACHMENT_ACCESS_DENIED');
   const cap=await this.authority.current(actor,scope,operation,tx,signal);signal?.throwIfAborted();
   if(!valid(cap)||cap.authority_version!==current.authority_version||cap.resource_binding_id!==current.resource_binding_id)throw Error('EMAIL_ATTACHMENT_ACCESS_DENIED');};
  return {scope,guard};
 }
 async upload(actor:EmailOperationActor,scope:EmailScope,draftId:string,expectedRevision:number,fileId:string,input:{filename:string;media_type:string},bytes:Uint8Array,signal?:AbortSignal){
  const authorized=await this.authorize(actor,scope,signal);
  return this.store.upload(authorized.scope,UUID.parse(draftId),Revision.parse(expectedRevision),UUID.parse(fileId),input,bytes,authorized.guard,signal);
 }
 async detach(actor:EmailOperationActor,scope:EmailScope,draftId:string,expectedRevision:number,fileId:string,signal?:AbortSignal){
  const authorized=await this.authorize(actor,scope,signal);
  return this.store.detach(authorized.scope,UUID.parse(draftId),Revision.parse(expectedRevision),UUID.parse(fileId),authorized.guard,signal);
 }
 async read(actor:EmailOperationActor,scope:EmailScope,draftId:string,fileId:string,expected?:EmailAttachmentMetadata,signal?:AbortSignal){
  const authorized=await this.authorize(actor,scope,signal);
  return this.store.read(authorized.scope,UUID.parse(draftId),UUID.parse(fileId),expected,authorized.guard,signal);
 }
 /** Server-internal Send read. It releases exact saved attachment bytes only
  * while the current owner has human_send authority; public file reads remain
  * under human_draft and this method is never mounted as an HTTP route. */
 async readForSend(actor:EmailOperationActor,scope:EmailScope,draftId:string,fileId:string,expected:EmailAttachmentMetadata,signal?:AbortSignal){
  const authorized=await this.authorize(actor,scope,signal,'human_send');
  return this.store.read(authorized.scope,UUID.parse(draftId),UUID.parse(fileId),EmailAttachmentMetadataSchema.parse(expected),authorized.guard,signal);
 }
}
