import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {APP_INTEGRATION_SOURCE_PURPOSES,AppIntegrationSourceTargetSchema,type AppIntegrationSourceTarget,type AppIntegrationSourcePurpose} from '../../../../packages/app-kit/src/app-integration-source.js';
import {AppDataResourceMetaSchema,canonicalAppDataJson} from '../../../../packages/app-kit/src/app-data.js';
import type {z} from 'zod';

/** Created by Host authority adapters, never parsed from author/tool input. */
export type AppIntegrationSourceCaller=Readonly<{org_id:string;user_id:string;
 kind:'human'|'defty'|'personal_mcp'|'capture_policy'|'notification_policy';principal_id:string;
 access_expires_at?:number;authorization_version?:number;conversation_id?:string;employee_id?:string;
 capture_delivery?:Readonly<{job_id:string;lock_token:string;policy_revision:number}>;
 notification_delivery?:Readonly<{job_id:string;lock_token:string;policy_revision:number}>}>;
export type AppIntegrationPublishedSource=Readonly<{checkpoint_id:string;generation:number;cursor_sequence:number;
 projection_revision:string;applied_sequence:number;payload_digest:string;observed_at:string;
 partial:boolean;target:AppIntegrationSourceTarget}>;
export type AppIntegrationSourceAuthority=Readonly<{identity:string;expires_at:number}>;
export type AppIntegrationSourceSnapshot=Readonly<{caller:AppIntegrationSourceCaller;
 purpose:AppIntegrationSourcePurpose;publication:AppIntegrationPublishedSource;
 authority:AppIntegrationSourceAuthority;resource:Readonly<z.infer<typeof AppDataResourceMetaSchema>>;presentation:Readonly<Record<string,unknown>>}>;
export interface AppIntegrationSourcePorts<Tx> {
 authority(caller:AppIntegrationSourceCaller,target:AppIntegrationSourceTarget,purpose:AppIntegrationSourcePurpose,tx?:Tx):Promise<AppIntegrationSourceAuthority>;
 /** tx supplied means share locks on projection/checkpoint and current binding. */
 publication(caller:AppIntegrationSourceCaller,target:AppIntegrationSourceTarget,tx?:Tx):Promise<AppIntegrationPublishedSource>;
 /** Existing public AppData transport; adapter resolves a current account lease.
  * Must validate request UUID/operation/digest/authority envelope as usual. */
 runtime(caller:AppIntegrationSourceCaller,target:AppIntegrationSourceTarget,purpose:AppIntegrationSourcePurpose,signal?:AbortSignal):Promise<{resource:unknown;presentation:Record<string,unknown>}>;
 clock?:()=>number;
}
export const appIntegrationSourceDigest=(value:unknown)=>'sha256:'+createHash('sha256').update(canonicalAppDataJson(value)).digest('hex');
const denied=()=>new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED');
export function createAppIntegrationSource<Tx>(ports:AppIntegrationSourcePorts<Tx>){
 const now=ports.clock??Date.now;
 const issued=new WeakSet<object>();
 const current=(authority:AppIntegrationSourceAuthority)=>{if(!authority.identity||!Number.isFinite(authority.expires_at)||authority.expires_at<=now())throw denied();};
 return Object.freeze({
  async read(caller:AppIntegrationSourceCaller,raw:AppIntegrationSourceTarget,purpose:AppIntegrationSourcePurpose,signal?:AbortSignal):Promise<AppIntegrationSourceSnapshot>{
   const target=AppIntegrationSourceTargetSchema.parse(raw);signal?.throwIfAborted();
   if(!APP_INTEGRATION_SOURCE_PURPOSES.includes(purpose))throw denied();
   const authority=await ports.authority(caller,target,purpose);current(authority);
   const publication=await ports.publication(caller,target);
   if(!isDeepStrictEqual(publication.target,target)||!publication.observed_at||!/^sha256:[a-f0-9]{64}$/u.test(publication.payload_digest))throw denied();
   const reply=await ports.runtime(caller,target,purpose,signal);signal?.throwIfAborted();
   const resource=AppDataResourceMetaSchema.parse(reply.resource);
   if(resource.tombstone||resource.record_id!==target.ref.record_id||resource.content_digest!==target.ref.content_digest
    ||Buffer.byteLength(canonicalAppDataJson(reply.presentation))>262144)throw denied();
   const after=await ports.authority(caller,target,purpose);current(after);
   if(after.identity!==authority.identity)throw denied();
   const afterPublication=await ports.publication(caller,target);
   if(!isDeepStrictEqual(afterPublication,publication))throw denied();
   current(authority);current(after);
   // Copy and deeply freeze untrusted values; a caller cannot silently revise the
   // snapshot it reviewed. This is an internal value, not a public authority token.
   const snapshot=structuredClone({caller,purpose,publication,authority:{...authority,expires_at:Math.min(authority.expires_at,after.expires_at)},resource,presentation:reply.presentation});
   const freeze=(value:unknown):void=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}};freeze(snapshot);issued.add(snapshot);return snapshot;
  },
  async guard(tx:Tx,caller:AppIntegrationSourceCaller,snapshot:AppIntegrationSourceSnapshot,purpose:AppIntegrationSourcePurpose){
   if(!issued.has(snapshot)||!isDeepStrictEqual(caller,snapshot.caller)||purpose!==snapshot.purpose)throw denied();
   current(snapshot.authority);
   const authority=await ports.authority(caller,snapshot.publication.target,purpose,tx);current(authority);
   if(authority.identity!==snapshot.authority.identity)throw denied();
   const publication=await ports.publication(caller,snapshot.publication.target,tx);
   if(!isDeepStrictEqual(publication,snapshot.publication))throw denied();
   current(snapshot.authority);current(authority);
   // An unpublished Runtime-only change after read is outside this transaction's
   // knowledge. Retain observation time/partialness; never call this latest truth.
  },
 });
}
