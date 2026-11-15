import {boundedAppAuthorityJsonKey} from './app-authority-json-key.js';
import {AppConnectionConsentContinuationRuntimeRequestSchema,AppConnectionConsentContinuationRuntimeResultSchema,type AppConnectionConsentContinuationRuntimeRequest} from '@deft/app-kit/core';
import {AppConnectionCredentialRepairRuntimeRequestSchema,AppConnectionCredentialRepairRuntimeResultSchema,type AppConnectionCredentialRepairRuntimeRequest} from '@deft/app-kit/core';
import {AppConnectionReattachAnyRuntimeRequestSchema,AppConnectionReattachAnyRuntimeResultSchema,type AppConnectionReattachAnyRuntimeRequest} from '@deft/app-kit/core';
import {AppIntegrationToolRuntimeRequestSchema,AppIntegrationToolRuntimeResultSchema,canonicalAppDataJson} from '@deft/app-kit/core';
import {AppRunInspectionRuntimeRequestSchema,AppRunInspectionRuntimeResultSchema} from '@deft/app-kit/core';
import {AppLocalJobRuntimeRequestSchema,AppLocalJobInteractiveResultSchema} from '../../../../packages/app-kit/src/local-job.js';
import {AppConnectionFormRuntimeRequestSchema,AppConnectionFormRuntimeResultSchema,type AppConnectionFormRuntimeRequest} from '../../../../packages/app-kit/src/connection-form.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AppConnectionProfileSchema, AppConnectionRuntimeRequestSchema, AppConnectionRuntimeResultSchema,
  AppConnectionReattachRuntimeRequestSchema, AppConnectionReattachRuntimeResultSchema, type AppConnectionReattachRuntimeRequest,
  AppConnectionRuntimeV2RequestSchema,AppConnectionUpgradeRuntimeRequestSchema,AppConnectionUpgradeRuntimeResultSchema,
  type AppConnectionRuntimeV2Request,type AppConnectionUpgradeRuntimeRequest,
  canonicalAppConnectionProfileJson, type AppConnectionProfile, type AppConnectionSessionScope,
  type AppConnectionRegisteredRuntime, type OwnerConnectionPolicyDeclaration } from '@deft/app-kit/core';
import { getScopedAppConnectionSessionRegistry } from './app-authority-registry-scope.js';
import { AppError } from './app-errors.js';
import { appRuntimeResponseError } from './app-runtime-response-error.js';
import { isHostedMode } from './hosted-mode.js';
import type { AppRunTransaction } from './app-run-repository.js';
import {AppRecordChangeRuntimeRequestSchema,type AppRecordChangeRuntimeRequest,APP_DATA_FRAME_MEDIA_TYPE,APP_DATA_LIMITS,AppDataRuntimeRequestSchema,AppDataResultSchema,AppDataBinaryMetadataSchema,frameAppData,parseAppDataFrame,type AppDataRuntimeRequest} from '@deft/app-kit/core';

const unavailable = () => new AppError('Reviewed connection runtime unavailable', 'APP_CONNECTION_PROFILE_UNAVAILABLE', 503);
const id = z.string().uuid();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const endpoint = z.string().max(2048).refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
    && url.pathname === '/v1/connections'; } catch { return false; }
});
const runtimeAuthToken = z.string().regex(/^[A-Za-z0-9_-]{43,256}$/u);
/** Hosted mode only. One reviewed Runtime transport for a connection profile,
 * written by the provisioner before the installation first starts. It names no
 * organisation, installation, operator or registration, because none of those
 * exist until the owner has signed up. Where an entry would be matched by those
 * values, a template is matched by the profile alone and the values are taken
 * from the caller's own current authority. Credentials stay in the Runtime; the
 * only protocol a template may carry is the Runtime-served credential form. */
const HostedTemplateSchema = z.strictObject({
  profile: AppConnectionProfileSchema.omit({ operator_user_id: true }),
  connection_protocol: z.literal('credential_form.v1'),
  endpoint, runtime_auth_token: runtimeAuthToken, authority_token_sha256: digest,
});
export const AppConnectionSessionRegistryConfigSchema = z.strictObject({
  schema_version: z.literal('deft.app_connection_http_registrations.v1'),
  entries: z.array(z.strictObject({ org_id: id, installation_id: id, runtime_registration_id: id,
    runtime_epoch: z.number().int().positive().max(2147483647), profile: AppConnectionProfileSchema,
    connection_protocol: z.enum(['v2','credential_form.v1']).optional(),
    endpoint, runtime_auth_token: runtimeAuthToken, authority_token_sha256: digest,
  })).max(32),
  hosted_templates: z.array(HostedTemplateSchema).max(4).optional(),
});
type Entry = z.infer<typeof AppConnectionSessionRegistryConfigSchema>['entries'][number];
type HostedTemplate = z.infer<typeof HostedTemplateSchema>;
type Transport = Pick<Entry, 'endpoint' | 'runtime_auth_token' | 'authority_token_sha256'>;
// Exact pure profile bytes only; every registry/proof and mutable authority
// read still occurs independently at each admission/invoke/disclosure phase.
const profileDigestMemo = new Map<string, string>();
export function connectionProfileDigest(profile: AppConnectionProfile) {
  const key = boundedAppAuthorityJsonKey(profile, 4096), cached = key === undefined ? undefined : profileDigestMemo.get(key);
  if (cached !== undefined) { profileDigestMemo.delete(key!); profileDigestMemo.set(key!, cached); return cached; }
  const digest = `sha256:${createHash('sha256').update(canonicalAppConnectionProfileJson(profile)).digest('hex')}`;
  if (key !== undefined) {
    profileDigestMemo.set(key, digest);
    if (profileDigestMemo.size > 64) profileDigestMemo.delete(profileDigestMemo.keys().next().value!);
  }
  return digest;
}
export function connectionTransportEntryDigest(entry: Transport) {
  return `sha256:${createHash('sha256').update(JSON.stringify({ endpoint: entry.endpoint,
    runtime_auth_token_sha256: createHash('sha256').update(entry.runtime_auth_token).digest('hex'),
    authority_token_sha256: entry.authority_token_sha256 })).digest('hex')}`;
}
function templateProfile(template: HostedTemplate, operatorId: string): AppConnectionProfile {
  return AppConnectionProfileSchema.parse({ ...template.profile, operator_user_id: operatorId });
}

/** Data-only deployment review. No author URL, module loader or provider key. */
export class AppConnectionSessionRegistry {
  private readonly entries: readonly Entry[];
  private readonly transportRoots: readonly Entry[];
  // Pure per-entry CPU reuse; `connectionTransportEntryDigest` is deterministic
  // over immutable entry bytes and is computed once at construction instead of
  // again on every profile()/transportDigest()/preauthenticate()/reviewedProtocol().
  private readonly transportDigests = new Map<Entry, string>();
  private readonly templates: readonly Readonly<{ template: HostedTemplate; transportDigest: string }>[];
  constructor(raw: unknown, private readonly fetcher: typeof fetch = fetch, trustedSuccessors: readonly Entry[] = [],
    hosted: boolean = isHostedMode()) {
    const parsed = AppConnectionSessionRegistryConfigSchema.parse(raw);
    // A self-hosted install has always refused a file carrying anything but
    // exact entries. Templates do not change that: outside hosted mode the whole
    // file stays unavailable, never read as if the templates were absent.
    const templates = parsed.hosted_templates ?? [];
    if (templates.length && !hosted) throw unavailable();
    const templateKeys = templates.map(template => JSON.stringify([template.profile.key, template.profile.resource_key,
      template.profile.runtime_requirement_key, template.profile.action_keys]));
    if (new Set(templateKeys).size !== templateKeys.length) throw unavailable();
    this.templates = Object.freeze(templates.map(template => Object.freeze({
      template: Object.freeze({ ...template, profile: Object.freeze(template.profile) }), transportDigest: connectionTransportEntryDigest(template) })));
    const rootCount=parsed.entries.length;
    // Successors are internal, independently validated audit proofs; public config keeps its original bound.
    if (trustedSuccessors.length > 256) throw unavailable();
    const entrySchema = AppConnectionSessionRegistryConfigSchema.shape.entries.element;
    parsed.entries.push(...trustedSuccessors.map(entry => entrySchema.parse(entry)));
    const identities = parsed.entries.map(entry => `${entry.org_id}:${entry.runtime_registration_id}:${entry.runtime_epoch}`);
    if (new Set(identities).size !== identities.length) throw unavailable();
    const reviews = new Map<string, string>();
    const digestByRawEntry = new Map<Entry, string>();
    for (const entry of parsed.entries) {
      const transportDigest = connectionTransportEntryDigest(entry);
      digestByRawEntry.set(entry, transportDigest);
      const key = JSON.stringify([entry.org_id, entry.installation_id, entry.profile.key, entry.profile.operator_user_id,
        entry.profile.resource_key, entry.profile.runtime_requirement_key, entry.profile.action_keys]);
      const reviewed = `${connectionProfileDigest(entry.profile)}:${transportDigest}:${entry.connection_protocol??'v1'}`;
      if (reviews.has(key) && reviews.get(key) !== reviewed) throw unavailable();
      reviews.set(key, reviewed);
    }
    this.entries = Object.freeze(parsed.entries.map(entry => {
      const frozen = Object.freeze({ ...entry, profile: Object.freeze(entry.profile) });
      this.transportDigests.set(frozen, digestByRawEntry.get(entry)!);
      return frozen;
    }));
    this.transportRoots=Object.freeze(this.entries.slice(0,rootCount));
  }
  private entryTransportDigest(entry: Entry) {
    let digest = this.transportDigests.get(entry);
    if (digest === undefined) { digest = connectionTransportEntryDigest(entry); this.transportDigests.set(entry, digest); }
    return digest;
  }
  profile(orgId: string, installationId: string, policy: OwnerConnectionPolicyDeclaration, operatorId?: string) {
    const entries = this.entries.filter(entry => entry.org_id === orgId && entry.installation_id === installationId
      && entry.profile.key === policy.provider_profile_key && (!operatorId || entry.profile.operator_user_id === operatorId)
      && entry.profile.resource_key === policy.resource_key && entry.profile.runtime_requirement_key === policy.runtime_requirement_key
      && JSON.stringify(entry.profile.action_keys) === JSON.stringify(policy.action_keys));
    if (!entries.length) {
      // No exact entry was written for this installation. A hosted template for
      // the declared profile answers, completed with the reviewed operator.
      const matches = operatorId === undefined ? [] : this.templates.filter(({ template }) => template.profile.key === policy.provider_profile_key
        && template.profile.resource_key === policy.resource_key && template.profile.runtime_requirement_key === policy.runtime_requirement_key
        && JSON.stringify(template.profile.action_keys) === JSON.stringify(policy.action_keys));
      if (matches.length !== 1) throw unavailable();
      return templateProfile(matches[0]!.template, operatorId!);
    }
    if (new Set(entries.map(entry => `${connectionProfileDigest(entry.profile)}:${this.entryTransportDigest(entry)}:${entry.connection_protocol??'v1'}`)).size !== 1) throw unavailable();
    const profile = entries[0]!.profile;
    if (profile.resource_key !== policy.resource_key || profile.runtime_requirement_key !== policy.runtime_requirement_key
      || JSON.stringify(profile.action_keys) !== JSON.stringify(policy.action_keys)) throw unavailable();
    return profile;
  }
  transportDigest(orgId: string, installationId: string, profile: AppConnectionProfile) {
    const entries = this.entries.filter(entry => entry.org_id === orgId && entry.installation_id === installationId
      && connectionProfileDigest(entry.profile) === connectionProfileDigest(profile));
    if (!entries.length) {
      const template = this.template(profile.operator_user_id, connectionProfileDigest(profile));
      if (!template) throw unavailable();
      return template.transportDigest;
    }
    const digests = new Set(entries.map(entry => this.entryTransportDigest(entry)));
    if (digests.size !== 1) throw unavailable();
    return digests.values().next().value!;
  }
  /** The single hosted template whose profile, completed with this operator,
   * has exactly this digest. Exact entries are always consulted first. */
  private template(operatorId: string, profileDigest: string) {
    const matches = this.templates.filter(({ template }) => connectionProfileDigest(templateProfile(template, operatorId)) === profileDigest);
    return matches.length === 1 ? matches[0]! : undefined;
  }
  private select(scope: AppConnectionSessionScope, profile?: AppConnectionProfile) {
    const reviewed = this.entries.filter(entry => entry.org_id === scope.org_id && entry.installation_id === scope.installation_id
      && entry.profile.operator_user_id === scope.operator_user_id && connectionProfileDigest(entry.profile) === scope.profile_digest);
    const entries = reviewed.filter(entry => entry.runtime_registration_id === scope.runtime_registration_id && entry.runtime_epoch === scope.runtime_epoch);
    if (profile && connectionProfileDigest(profile) !== scope.profile_digest) throw unavailable();
    if (!reviewed.length) {
      // No exact entry reviews this installation's profile at all. The scope is
      // the caller's current authority, rebuilt from reviewed rows; the template
      // supplies only the transport that scope may be sent over. Where exact
      // entries exist they stay the complete list of registrations.
      const found = this.template(scope.operator_user_id, scope.profile_digest);
      if (!found) throw unavailable();
      const { template } = found;
      return Object.freeze({ org_id: scope.org_id, installation_id: scope.installation_id,
        runtime_registration_id: scope.runtime_registration_id, runtime_epoch: scope.runtime_epoch,
        profile: Object.freeze(templateProfile(template, scope.operator_user_id)), connection_protocol: template.connection_protocol,
        endpoint: template.endpoint, runtime_auth_token: template.runtime_auth_token, authority_token_sha256: template.authority_token_sha256 }) as Entry;
    }
    if (entries.length !== 1) throw unavailable();
    return entries[0]!;
  }
  /** Credential-only entry admission. This does not establish an owner,
   * registration/epoch, invocation or operation authority. It never considers
   * trusted aliases: callers must independently run the full current graph and
   * fresh exact authenticate() before returning any allowed proof. */
  preauthenticateTransport(scope:Pick<AppConnectionSessionScope,'org_id'|'installation_id'|'operator_user_id'|'profile_digest'>,
    authorization:string|undefined){
    const denied=()=>new AppError('Connection runtime authentication denied','APP_ACCESS_DENIED',403);
    const token=/^Bearer ([A-Za-z0-9_-]{43,256})$/u.exec(authorization??'')?.[1];
    if(!token)throw denied();
    const entries=this.transportRoots.filter(entry=>entry.org_id===scope.org_id&&entry.installation_id===scope.installation_id
      &&entry.profile.operator_user_id===scope.operator_user_id&&connectionProfileDigest(entry.profile)===scope.profile_digest);
    const template=entries.length?undefined:this.template(scope.operator_user_id,scope.profile_digest);
    if(!template&&(!entries.length||new Set(entries.map(entry=>`${this.entryTransportDigest(entry)}:${entry.connection_protocol??'v1'}`)).size!==1))throw denied();
    const expected=Buffer.from((template?.template??entries[0]!).authority_token_sha256.slice(7),'hex');
    if(!timingSafeEqual(expected,createHash('sha256').update(token).digest()))throw denied();
  }
  authenticate(scope: AppConnectionSessionScope, authorization: string | undefined) {
    const denied = () => new AppError('Connection runtime authentication denied', 'APP_ACCESS_DENIED', 403);
    const token = /^Bearer ([A-Za-z0-9_-]{43,256})$/u.exec(authorization ?? '')?.[1];
    if (!token) throw denied();
    const expected = this.select(scope).authority_token_sha256.slice(7);
    if (!timingSafeEqual(Buffer.from(expected, 'hex'), createHash('sha256').update(token).digest())) throw denied();
  }
  protocol(scope:AppConnectionSessionScope,profile:AppConnectionProfile):'v1'|'v2'|'credential_form.v1'{
    return this.select(scope,profile).connection_protocol??'v1';
  }
  reviewedProtocol(orgId:string,installationId:string,profile:AppConnectionProfile):'v1'|'v2'|'credential_form.v1'{
    const entries=this.entries.filter(entry=>entry.org_id===orgId&&entry.installation_id===installationId
      &&connectionProfileDigest(entry.profile)===connectionProfileDigest(profile));
    if(!entries.length){const template=this.template(profile.operator_user_id,connectionProfileDigest(profile));if(!template)throw unavailable();return template.template.connection_protocol;}
    const reviews=new Set(entries.map(entry=>`${this.entryTransportDigest(entry)}:${entry.connection_protocol??'v1'}`));
    if(reviews.size!==1)throw unavailable();return entries[0]!.connection_protocol??'v1';
  }
  assertReady(scope:AppConnectionSessionScope,profile:AppConnectionProfile){
    // Read-only authority checks readiness without dispatch or protocol fallback.
    this.select(scope,profile);
  }
  localJobRuntime(scope:AppConnectionSessionScope,profile:AppConnectionProfile){const entry=this.select(scope,profile);return {request:async(raw:unknown,signal:AbortSignal)=>{
    const input=AppLocalJobRuntimeRequestSchema.parse(raw);if(!isDeepStrictEqual(input.scope,scope))throw unavailable();const body=JSON.stringify(input);if(Buffer.byteLength(body)>16384)throw unavailable();signal.throwIfAborted();
    const response=await this.fetcher(new URL('/v1/local-jobs',entry.endpoint),{method:'POST',redirect:'error',signal,headers:{Authorization:`Bearer ${entry.runtime_auth_token}`,'Content-Type':'application/json',Accept:'application/json'},body});
    if(!response.ok||response.redirected||!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type')??'')){void response.body?.cancel().catch(()=>undefined);throw unavailable();}
    const result=AppLocalJobInteractiveResultSchema.parse(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(await readBoundedAppDataBytes(response.body,input.operation==='list'?131072:4096,signal))));signal.throwIfAborted();return result;
  }};}
  runInspectionRuntime(scope:AppConnectionSessionScope,profile:AppConnectionProfile){const entry=this.select(scope,profile);return {request:async(raw:unknown,signal:AbortSignal)=>{const input=AppRunInspectionRuntimeRequestSchema.parse(raw);if(!isDeepStrictEqual(input.scope,scope)||entry.connection_protocol!=='credential_form.v1')throw unavailable();const body=JSON.stringify(input);if(Buffer.byteLength(body)>16384)throw unavailable();signal.throwIfAborted();const response=await this.fetcher(new URL('/v1/run-inspections',entry.endpoint),{method:'POST',redirect:'error',signal,headers:{Authorization:`Bearer ${entry.runtime_auth_token}`,'Content-Type':'application/json',Accept:'application/json'},body});if(!response.ok||response.redirected||!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type')??'')){void response.body?.cancel().catch(()=>undefined);throw unavailable();}const result=AppRunInspectionRuntimeResultSchema.parse(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(await readBoundedAppDataBytes(response.body,4096,signal))));signal.throwIfAborted();if(result.request_id!==input.request_id||result.run_id!==input.input.run_id||result.receipt&&(result.receipt.operation_id!==input.input.run_id||result.receipt.run_id!==input.input.run_id||result.receipt.attempt_id!==input.input.attempt_id||result.receipt.account_ref!==input.connection.account_ref))throw unavailable();return result;}};}
  integrationToolRuntime(scope:AppConnectionSessionScope,profile:AppConnectionProfile){
    const entry=this.select(scope,profile);
    return {request:async(raw:unknown,signal:AbortSignal)=>{
      const input=AppIntegrationToolRuntimeRequestSchema.parse(raw);if(!isDeepStrictEqual(input.scope,scope))throw unavailable();
      const body=JSON.stringify(input);if(Buffer.byteLength(body)>614400)throw unavailable();signal.throwIfAborted();
      const response=await this.fetcher(new URL('/v1/integration-tools',entry.endpoint),{method:'POST',redirect:'error',signal,headers:{Authorization:`Bearer ${entry.runtime_auth_token}`,'Content-Type':'application/json',Accept:'application/json'},body});
      if(!response.ok||response.redirected||!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type')??'')){void response.body?.cancel().catch(()=>undefined);throw unavailable();}
      const result=AppIntegrationToolRuntimeResultSchema.parse(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(await readBoundedAppDataBytes(response.body,524288,signal))));signal.throwIfAborted();
      const digest='sha256:'+createHash('sha256').update(canonicalAppDataJson(input.input)).digest('hex');
      if(result.request_id!==input.request_id||result.tool_key!==input.tool_key||result.tool_operation!==input.tool_operation||result.store_key!==input.store_key||result.input_digest!==digest)throw unavailable();return result;
    }};
  }
  dataRuntime(scope: AppConnectionSessionScope,profile:AppConnectionProfile) {
    const entry=this.select(scope,profile);
    return {request:async(raw:AppDataRuntimeRequest|AppRecordChangeRuntimeRequest,signal:AbortSignal,bytes?:Uint8Array)=>{
      const input=raw.schema_version==='deft.app_data_runtime.v2'?AppRecordChangeRuntimeRequestSchema.parse(raw):AppDataRuntimeRequestSchema.parse(raw);
      if(input.schema_version==='deft.app_data_runtime.v2'&&bytes!==undefined)throw unavailable();
      if(!isDeepStrictEqual(input.scope,scope)) throw unavailable();
      const body=bytes===undefined?JSON.stringify(input):frameAppData(input,bytes);
      if(bytes===undefined&&Buffer.byteLength(body as string)>APP_DATA_LIMITS.json_bytes)throw unavailable();
      signal.throwIfAborted();
      const response=await this.fetcher(new URL('/v1/data',entry.endpoint),{method:'POST',redirect:'error',signal,
        headers:{Authorization:`Bearer ${entry.runtime_auth_token}`,'Content-Type':bytes===undefined?'application/json':APP_DATA_FRAME_MEDIA_TYPE,
          Accept:`application/json, ${APP_DATA_FRAME_MEDIA_TYPE}`},body:body as BodyInit});
      if(!response.ok||response.redirected){
        const error=await appRuntimeResponseError(response,signal);
        if(error.details?.runtime_code)console.warn('[app-runtime] data request denied',{code:error.code,runtime_code:error.details.runtime_code,status:error.status,operation:input.operation,request_id:input.request_id});
        throw error;
      }
      const type=response.headers.get('content-type')??'';
      if(/^application\/json(?:\s*;|$)/iu.test(type))return {result:AppDataResultSchema.parse(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(await readBoundedAppDataBytes(response.body,APP_DATA_LIMITS.result_json_bytes,signal))))};
      if(input.schema_version==='deft.app_data_runtime.v2'||type!==APP_DATA_FRAME_MEDIA_TYPE){void response.body?.cancel().catch(()=>undefined);throw unavailable();}
      const frame=parseAppDataFrame(await readBoundedAppDataBytes(response.body,APP_DATA_LIMITS.source_bytes+APP_DATA_LIMITS.frame_header_bytes+4,signal));
      return {metadata:AppDataBinaryMetadataSchema.parse(frame.header),bytes:frame.bytes};
    }};
  }
  runtime(scope: AppConnectionSessionScope, profile: AppConnectionProfile): AppConnectionRegisteredRuntime {
    const entry = this.select(scope, profile);
    if(entry.connection_protocol!==undefined)throw unavailable();
    return { identity: { runtime_registration_id: entry.runtime_registration_id,
      operator_user_id: entry.profile.operator_user_id, runtime_epoch: entry.runtime_epoch },
      request: async (raw, signal) => {
        const input = AppConnectionRuntimeRequestSchema.parse(raw);
        if (!isDeepStrictEqual(input.scope, scope)) throw unavailable();
        signal.throwIfAborted();
        const response = await this.fetcher(entry.endpoint, { method: 'POST', redirect: 'error', signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${entry.runtime_auth_token}`, Accept: 'application/json' },
          body: JSON.stringify(input) });
        if (!response.ok || response.redirected || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) {
          void response.body?.cancel().catch(() => undefined); throw unavailable();
        }
        return AppConnectionRuntimeResultSchema.parse(await readBoundedConnectionJson(response.body, signal));
      } };
  }
  reattachmentRuntime(scope: AppConnectionSessionScope, profile: AppConnectionProfile) {
    const entry = this.select(scope, profile);
    if(entry.connection_protocol!==undefined&&entry.connection_protocol!=='v2')throw unavailable();
    return { request: async (raw: AppConnectionReattachAnyRuntimeRequest, signal: AbortSignal) => {
      const input = AppConnectionReattachAnyRuntimeRequestSchema.parse(raw);
      if ((input.schema_version==='deft.app_connection_reattach_runtime.v2')!==(entry.connection_protocol==='v2')||!isDeepStrictEqual(input.scope, scope)) throw unavailable();
      const body = JSON.stringify(input);
      if (Buffer.byteLength(body) > 16384) throw unavailable();
      signal.throwIfAborted();
      const response = await this.fetcher(entry.endpoint, { method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${entry.runtime_auth_token}`, Accept: 'application/json' }, body });
      if (!response.ok || response.redirected || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) {
        void response.body?.cancel().catch(() => undefined); throw unavailable();
      }
      return AppConnectionReattachAnyRuntimeResultSchema.parse(await readBoundedConnectionJson(response.body, signal));
    } };
  }
  consentContinuationRuntime(scope:AppConnectionSessionScope,profile:AppConnectionProfile){
    const entry=this.select(scope,profile);if(!entry.connection_protocol)throw unavailable();
    return {request:async(raw:AppConnectionConsentContinuationRuntimeRequest,signal:AbortSignal)=>AppConnectionConsentContinuationRuntimeResultSchema.parse(
      await this.requestClosed(entry,scope,AppConnectionConsentContinuationRuntimeRequestSchema.parse(raw),signal))};
  }
  formRuntime(scope:AppConnectionSessionScope,profile:AppConnectionProfile){
    const entry=this.select(scope,profile);if(entry.connection_protocol!=='credential_form.v1')throw unavailable();
    return {request:async(raw:AppConnectionFormRuntimeRequest,signal:AbortSignal)=>AppConnectionFormRuntimeResultSchema.parse(await this.requestClosed(entry,scope,AppConnectionFormRuntimeRequestSchema.parse(raw),signal))};
  }
  runtimeV2(scope:AppConnectionSessionScope,profile:AppConnectionProfile){
    const entry=this.select(scope,profile);
    if(entry.connection_protocol!=='v2')throw unavailable();
    return {identity:{runtime_registration_id:entry.runtime_registration_id,operator_user_id:entry.profile.operator_user_id,runtime_epoch:entry.runtime_epoch},
      request:async(raw:AppConnectionRuntimeV2Request,signal:AbortSignal)=>AppConnectionRuntimeResultSchema.parse(
        await this.requestClosed(entry,scope,AppConnectionRuntimeV2RequestSchema.parse(raw),signal))};
  }
  upgradeRuntime(scope:AppConnectionSessionScope,profile:AppConnectionProfile){
    const entry=this.select(scope,profile);
    if(entry.connection_protocol!=='v2')throw unavailable();
    return {request:async(raw:AppConnectionUpgradeRuntimeRequest,signal:AbortSignal)=>AppConnectionUpgradeRuntimeResultSchema.parse(
      await this.requestClosed(entry,scope,AppConnectionUpgradeRuntimeRequestSchema.parse(raw),signal))};
  }
  /** Delivers Host-issued channel sessions; the Runtime proves each with the Host before keeping it. */
  channelInstallRuntime(scope:AppConnectionSessionScope,profile:AppConnectionProfile){
    const entry=this.select(scope,profile);if(entry.connection_protocol!=='v2')throw unavailable();
    return {request:async(input:{scope:AppConnectionSessionScope}&Record<string,unknown>,signal:AbortSignal)=>this.requestClosed(entry,scope,input,signal)};
  }
  credentialRepairRuntime(scope:AppConnectionSessionScope,profile:AppConnectionProfile){
    const entry=this.select(scope,profile);if(entry.connection_protocol!=='v2')throw unavailable();
    return {request:async(raw:AppConnectionCredentialRepairRuntimeRequest,signal:AbortSignal)=>AppConnectionCredentialRepairRuntimeResultSchema.parse(
      await this.requestClosed(entry,scope,AppConnectionCredentialRepairRuntimeRequestSchema.parse(raw),signal))};
  }
  private async requestClosed(entry:Entry,scope:AppConnectionSessionScope,input:{scope:AppConnectionSessionScope},signal:AbortSignal){
    if(!isDeepStrictEqual(input.scope,scope))throw unavailable();
    const body=JSON.stringify(input);if(Buffer.byteLength(body)>16384)throw unavailable();signal.throwIfAborted();
    const response=await this.fetcher(entry.endpoint,{method:'POST',redirect:'error',signal,
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${entry.runtime_auth_token}`,Accept:'application/json'},body});
    if(!response.ok||response.redirected||!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type')??'')){
      void response.body?.cancel().catch(()=>undefined);throw unavailable();}
    return readBoundedConnectionJson(response.body,signal);
  }
}

export async function readBoundedAppDataBytes(stream:ReadableStream<Uint8Array>|null,maximum:number,signal:AbortSignal){
  if(!stream)throw unavailable();const reader=stream.getReader(),chunks:Uint8Array[]=[];let count=0;
  const cancel=()=>{void reader.cancel().catch(()=>undefined);};signal.addEventListener('abort',cancel,{once:true});
  try{for(;;){signal.throwIfAborted();const part=await reader.read();if(part.done)break;count+=part.value.byteLength;
    if(count>maximum)throw unavailable();chunks.push(part.value);}signal.throwIfAborted();return new Uint8Array(Buffer.concat(chunks));}
  catch(error){cancel();throw error;}finally{signal.removeEventListener('abort',cancel);reader.releaseLock();}
}

export async function readBoundedConnectionJson(stream: ReadableStream<Uint8Array> | null, signal?: AbortSignal) {
  if (!stream) throw unavailable();
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let count = 0;
  let rejectAbort: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  void aborted.catch(() => undefined);
  const cancel = () => { void reader.cancel().catch(() => undefined); rejectAbort(unavailable()); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) { signal?.throwIfAborted(); const part = await Promise.race([reader.read(), aborted]); if (part.done) break;
      count += part.value.byteLength; if (count > 16384) throw unavailable(); chunks.push(part.value); }
    signal?.throwIfAborted();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { cancel(); throw unavailable(); }
  finally { signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
}

export type AppConnectionSessionRegistryStatIdentity = Readonly<{ path: string; dev: number; ino: number; size: number; mtimeMs: number }>;

/** `lstat` plus the exact file-shape guards from `loadAppConnectionSessionRegistry`,
 * returned as a stable identity. A replaced/removed/symlinked/oversized file or a
 * mode-bits change throws the same `APP_CONNECTION_PROFILE_UNAVAILABLE` error, so
 * a caller can decide whether a previously parsed registry is still current. */
export async function statAppConnectionSessionRegistryFile(path: string): Promise<AppConnectionSessionRegistryStatIdentity> {
  if (!isAbsolute(path)) throw unavailable();
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 131072
    || process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw unavailable();
  return { path, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

/** Only an explicitly supplied authority transaction is reused. Callers without
 * one retain an independent committed-state proof read. */
export async function loadAppConnectionSessionRegistry(path: string | undefined, transaction?: AppRunTransaction,
  options:Readonly<{trustedSuccessors?:boolean}>={}) {
  if (!path) return new AppConnectionSessionRegistry({ schema_version: 'deft.app_connection_http_registrations.v1', entries: [] });
  try {
    await statAppConnectionSessionRegistryFile(path);
    const config = AppConnectionSessionRegistryConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    if(options.trustedSuccessors===false)return new AppConnectionSessionRegistry(config);
    const { trustedUpgradeRegistryEntries } = await import('./app-upgrade-trust-registry.js');
    const successors = await trustedUpgradeRegistryEntries(config.entries, transaction).catch(() => []);
    return new AppConnectionSessionRegistry(config, fetch, successors);
  } catch { throw unavailable(); }
}
// Reread deployment review on each authority check; replacement/removal revokes
// access without waiting for an API restart. Credentials never enter responses.
// Within one request `withAuthorityRegistryScope` shares the parsed registry
// object (still lstat-validated on every lookup) across no-transaction call sites.
export async function getAppConnectionSessionRegistry(transaction?: AppRunTransaction) {
  return getScopedAppConnectionSessionRegistry(transaction);
}

/** Fresh static deployment credential check only; no proof/result/registry is
 * retained. Full current authority and final exact authentication stay required. */
export async function preauthenticateAppConnectionTransport(
  scope:Pick<AppConnectionSessionScope,'org_id'|'installation_id'|'operator_user_id'|'profile_digest'>,authorization:string|undefined){
  const registry=await loadAppConnectionSessionRegistry(process.env.DEFT_APP_CONNECTION_HTTP_CONFIG,undefined,{trustedSuccessors:false});
  registry.preauthenticateTransport(scope,authorization);
}
