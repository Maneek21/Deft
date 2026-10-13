import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { canonicalCapabilityJson } from '@deft/shared';
import { z } from 'zod';
import { type AppRunKeyProvider } from './app-run-keyrings.js';
import { AppRunSecretEnvelopeSchema, type AppRunSecretEnvelope } from './app-run-secrets.js';
import type { NativeEmailAccount, NativeEmailConnectionContext } from './app-connection-contract.js';

const DOMAIN = 'deft.email.imap.credentials.v1';
const MAX_PROFILE_BYTES = 64 * 1024;
const Identifier = z.string().min(1).max(256).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const ScopeSchema = z.strictObject({ org_id: Identifier, owner_user_id: Identifier, account_id: Identifier });
const SmtpProfileSchema=z.strictObject({host:z.string().min(1).max(253),port:z.number().int().min(1).max(65535),transport:z.enum(['implicit_tls','starttls_required']),username:z.string().min(1).max(512),password:z.string().min(1).max(8192)});
const ProfileSchema = z.strictObject({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  transport: z.enum(['implicit_tls', 'starttls_required']),
  username: z.string().min(1).max(512),
  password: z.string().min(1).max(8192),
  smtp:SmtpProfileSchema.optional(),
  sent_copy_mode:z.enum(['server_managed','append']).optional(),
  identity:z.strictObject({primary_address:z.string().email().max(320),display_label:z.string().min(1).max(256)}).optional(),
  verified_at:z.iso.datetime().optional(),
});
/** HTTP setup cannot assert that a profile has already passed authentication. */
export const EmailImapSetupProfileSchema=ProfileSchema.omit({verified_at:true}).required({identity:true});
const StoredRecordSchema = z.strictObject({
  schema_version: z.literal(DOMAIN),
  org_id: Identifier,
  owner_user_id: Identifier,
  account_id: Identifier,
  principal_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  connection_revision: z.number().int().positive().safe(),
  envelope: AppRunSecretEnvelopeSchema,
});

export type EmailImapScope = Readonly<z.infer<typeof ScopeSchema>>;
export type EmailImapProfileInput = Readonly<z.infer<typeof ProfileSchema>>;
export type EmailImapConnectorProfile = Readonly<{
  host: string; port: number; username: string; password: string;
  tls: Readonly<{ mode: 'implicit_tls' | 'starttls_required'; minVersion: 'TLSv1.2'; rejectUnauthorized: true }>;
}>;
export type EmailImapCredentialRecord = Readonly<z.infer<typeof StoredRecordSchema>>;
export type EmailImapCredentialStore = Readonly<{
  read: (scope: EmailImapScope) => Promise<EmailImapCredentialRecord | null>;
  /** Must be a durable compare-and-swap, and atomically keep account connection
   * revision/principal metadata aligned with the encrypted profile row. */
  compareAndSwap: (input: { scope: EmailImapScope; expected_revision: number; record: EmailImapCredentialRecord }) => Promise<boolean>;
}>;

export type EmailImapCustodyErrorCode = 'EMAIL_IMAP_PROFILE_INVALID' | 'EMAIL_IMAP_PRINCIPAL_IMMUTABLE'
  | 'EMAIL_IMAP_CUSTODY_CONFLICT' | 'EMAIL_IMAP_CUSTODY_UNAVAILABLE' | 'EMAIL_IMAP_CUSTODY_KEY_UNAVAILABLE'
  | 'EMAIL_ACCESS_DENIED';
export class EmailImapCustodyError extends Error {
  constructor(readonly code: EmailImapCustodyErrorCode) { super(code); this.name = 'EmailImapCustodyError'; }
}

function deny(): never { throw new EmailImapCustodyError('EMAIL_ACCESS_DENIED'); }
function profileInvalid(): never { throw new EmailImapCustodyError('EMAIL_IMAP_PROFILE_INVALID'); }
async function recheckOrDeny(recheck: () => Promise<void>): Promise<void> {
  try { await recheck(); } catch { deny(); }
}
function normalizeProfile(input: unknown): z.infer<typeof ProfileSchema> {
  const parsed = ProfileSchema.safeParse(input);
  if (!parsed.success) return profileInvalid();
  const hostInput = parsed.data.host.trim().replace(/\.$/u, '').toLowerCase();
  const host = domainToASCII(hostInput);
  const username = parsed.data.username.normalize('NFC').trim();
  if (!host || host.length > 253 || isIP(host) || host === 'localhost' || host.endsWith('.localhost')
    || /[\u0000-\u0020\u007f]/u.test(hostInput) || !host.includes('.')
    || username.length === 0 || username.length > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(username)
    || parsed.data.password.includes('\u0000')
    || parsed.data.transport === 'implicit_tls' && parsed.data.port !== 993
    || parsed.data.transport === 'starttls_required' && parsed.data.port !== 143) return profileInvalid();
  let smtp=parsed.data.smtp;
  if(smtp){
    const hostInput=smtp.host.trim().replace(/\.$/u,'').toLowerCase(),host=domainToASCII(hostInput),username=smtp.username.normalize('NFC').trim();
    if(!host||host.length>253||isIP(host)||host==='localhost'||host.endsWith('.localhost')||!host.includes('.')||/[\u0000-\u0020\u007f]/u.test(hostInput)
      ||!username||/[\u0000-\u001f\u007f-\u009f]/u.test(username)||smtp.password.includes('\u0000')
      ||smtp.transport==='implicit_tls'&&smtp.port!==465||smtp.transport==='starttls_required'&&smtp.port!==587)return profileInvalid();
    smtp={...smtp,host,username};
  }
  const value = { ...parsed.data, host, username,...(smtp?{smtp}:{}) };
  if (Buffer.byteLength(canonicalCapabilityJson(value), 'utf8') > MAX_PROFILE_BYTES) return profileInvalid();
  return value;
}

function principalDigest(scope: EmailImapScope, profile: Pick<EmailImapProfileInput, 'host' | 'port' | 'transport' | 'username'>): string {
  return createHash('sha256').update(canonicalCapabilityJson([
    DOMAIN, scope.org_id, scope.owner_user_id, profile.host, profile.port, profile.username,
  ])).digest('hex');
}

function associatedData(scope: EmailImapScope, principal: string, revision: number): Buffer {
  return Buffer.from(canonicalCapabilityJson([DOMAIN, scope, principal, revision]), 'utf8');
}

function seal(keys: AppRunKeyProvider, scope: EmailImapScope, principal: string, revision: number,
  value: z.infer<typeof ProfileSchema>): AppRunSecretEnvelope {
  const key = keys.current('run_encryption');
  const nonce = randomBytes(12), aad = associatedData(scope, principal, revision);
  const plaintext = Buffer.from(canonicalCapabilityJson(value), 'utf8');
  let ciphertext: Buffer | undefined, tag: Buffer | undefined;
  try {
    const cipher = createCipheriv('aes-256-gcm', key.key, nonce, { authTagLength: 16 });
    cipher.setAAD(aad);
    ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    tag = cipher.getAuthTag();
    return AppRunSecretEnvelopeSchema.parse({ schema_version: 'deft.secret.v1', algorithm: 'aes-256-gcm',
      key_version: key.key_id, nonce_b64: nonce.toString('base64'), ciphertext_b64: ciphertext.toString('base64'),
      auth_tag_b64: tag.toString('base64') });
  } catch (error) {
    if (error instanceof EmailImapCustodyError) throw error;
    throw new EmailImapCustodyError('EMAIL_IMAP_CUSTODY_UNAVAILABLE');
  } finally {
    key.key.fill(0); nonce.fill(0); aad.fill(0); plaintext.fill(0); ciphertext?.fill(0); tag?.fill(0);
  }
}

function open(keys: AppRunKeyProvider, scope: EmailImapScope, rawRecord: unknown): {
  record: EmailImapCredentialRecord; profile: z.infer<typeof ProfileSchema>;
} {
  let record: EmailImapCredentialRecord;
  try { record = StoredRecordSchema.parse(rawRecord); }
  catch { throw new EmailImapCustodyError('EMAIL_IMAP_CUSTODY_UNAVAILABLE'); }
  if (record.org_id !== scope.org_id || record.owner_user_id !== scope.owner_user_id || record.account_id !== scope.account_id) return deny();
  const key = keys.read('run_encryption', record.envelope.key_version);
  if (!key) throw new EmailImapCustodyError('EMAIL_IMAP_CUSTODY_KEY_UNAVAILABLE');
  const nonce = Buffer.from(record.envelope.nonce_b64, 'base64');
  const ciphertext = Buffer.from(record.envelope.ciphertext_b64, 'base64');
  const tag = Buffer.from(record.envelope.auth_tag_b64, 'base64');
  const aad = associatedData(scope, record.principal_digest, record.connection_revision);
  let partial: Buffer | undefined, plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.key, nonce, { authTagLength: 16 });
    decipher.setAAD(aad); decipher.setAuthTag(tag);
    partial = decipher.update(ciphertext); plaintext = Buffer.concat([partial, decipher.final()]);
    if (plaintext.byteLength > MAX_PROFILE_BYTES) throw new Error('oversized');
    const profile = normalizeProfile(JSON.parse(plaintext.toString('utf8')));
    if (principalDigest(scope, profile) !== record.principal_digest) throw new Error('principal');
    return { record, profile };
  } catch (error) {
    if (error instanceof EmailImapCustodyError) throw error;
    throw new EmailImapCustodyError('EMAIL_IMAP_CUSTODY_UNAVAILABLE');
  } finally {
    key.key.fill(0); nonce.fill(0); ciphertext.fill(0); tag.fill(0); aad.fill(0); partial?.fill(0); plaintext?.fill(0);
  }
}

/** Encrypted IMAP credential custody primitive. The injected CAS port is the
 * only persistence boundary; callers provide trusted host setup and authority. */
export class EmailImapCredentialCustody {
  constructor(private readonly keys: AppRunKeyProvider, private readonly store: EmailImapCredentialStore) {}

  async saveProfile(rawScope: unknown, expectedRevision: number, rawProfile: unknown,
    recheck: () => Promise<void>, signal?: AbortSignal): Promise<Readonly<{ connection_revision: number; principal_digest: string }>> {
    let scope: EmailImapScope;
    try { scope = Object.freeze(ScopeSchema.parse(rawScope)); } catch { return deny(); }
    const profile = normalizeProfile(rawProfile);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) return profileInvalid();
    signal?.throwIfAborted();
    await recheckOrDeny(recheck);
    try {
      const current = await this.store.read(scope);
      const priorRevision = current?.connection_revision ?? 0;
      if (priorRevision !== expectedRevision) throw new EmailImapCustodyError('EMAIL_IMAP_CUSTODY_CONFLICT');
      const principal = principalDigest(scope, profile);
      if (current) {
        const prior = open(this.keys, scope, current);
        if (prior.record.principal_digest !== principal) throw new EmailImapCustodyError('EMAIL_IMAP_PRINCIPAL_IMMUTABLE');
        if (canonicalCapabilityJson(prior.profile) === canonicalCapabilityJson(profile)) {
          await recheckOrDeny(recheck);
          return { connection_revision: priorRevision, principal_digest: principal };
        }
      }
      const revision = priorRevision + 1;
      const record = StoredRecordSchema.parse({ schema_version: DOMAIN, ...scope, principal_digest: principal,
        connection_revision: revision, envelope: seal(this.keys, scope, principal, revision, profile) });
      signal?.throwIfAborted();
      if (await this.store.compareAndSwap({ scope, expected_revision: priorRevision, record }) !== true) {
        throw new EmailImapCustodyError('EMAIL_IMAP_CUSTODY_CONFLICT');
      }
      await recheckOrDeny(recheck);
      return { connection_revision: revision, principal_digest: principal };
    } catch (error) {
      if (error instanceof EmailImapCustodyError) throw error;
      throw new EmailImapCustodyError('EMAIL_IMAP_CUSTODY_UNAVAILABLE');
    }
  }

  /** Host-only metadata for an explicitly configured, tested account. This
   * never exposes credential fields to the adapter or browser. */
  async describe(context:NativeEmailConnectionContext){
    const scope=ScopeSchema.parse({org_id:context.org_id,owner_user_id:context.owner_user_id,account_id:context.account_id});
    context.signal?.throwIfAborted();await recheckOrDeny(context.recheck);
    const raw=await this.store.read(scope);if(!raw)return deny();const {record,profile}=open(this.keys,scope,raw);
    try{
      if(!profile.identity||!profile.verified_at||Date.parse(profile.verified_at)>Date.now())return deny();
      await recheckOrDeny(context.recheck);context.signal?.throwIfAborted();
      return Object.freeze({connection_revision:record.connection_revision,principal_digest:record.principal_digest,
        primary_address:profile.identity.primary_address,display_label:profile.identity.display_label,has_smtp:!!profile.smtp,verified_at:profile.verified_at,sent_copy_mode:profile.sent_copy_mode??'server_managed'});
    }finally{profile.password='';if(profile.smtp)profile.smtp.password='';}
  }

  /** Authenticated preference CAS reseals the existing profile. Callers never
   * need to read or resubmit its passwords, SMTP endpoint, or verified identity. */
  async updateSentCopyMode(rawScope:unknown,expectedRevision:number,mode:'server_managed'|'append',recheck:()=>Promise<void>,signal?:AbortSignal){
    const scope=ScopeSchema.parse(rawScope);z.enum(['server_managed','append']).parse(mode);z.number().int().positive().safe().parse(expectedRevision);
    signal?.throwIfAborted();await recheckOrDeny(recheck);const raw=await this.store.read(scope);if(!raw)return deny();const {record,profile}=open(this.keys,scope,raw);
    try{if(record.connection_revision!==expectedRevision)throw new EmailImapCustodyError('EMAIL_IMAP_CUSTODY_CONFLICT');if(!profile.identity||!profile.verified_at||Date.parse(profile.verified_at)>Date.now())return deny();
      await recheckOrDeny(recheck);const saved=await this.saveProfile(scope,expectedRevision,{...profile,sent_copy_mode:mode},recheck,signal);return Object.freeze({account_id:scope.account_id,revision:saved.connection_revision,sent_copy_mode:mode});
    }finally{profile.password='';if(profile.smtp)profile.smtp.password='';}
  }

  /** Decrypts only for a trusted connector callback. Storage access and key use
   * finish before network work starts; the callback never runs under a custody lock. */
  async withVerifiedProfile<T>(context: NativeEmailConnectionContext, expected: NativeEmailAccount,
    work: (profile: EmailImapConnectorProfile) => Promise<T>): Promise<T> {
    return this.withProfile(context,expected,work,'read');
  }
  async withVerifiedSmtpProfile<T>(context:NativeEmailConnectionContext,expected:NativeEmailAccount,
    work:(profile:EmailImapConnectorProfile)=>Promise<T>):Promise<T>{
    return this.withProfile(context,expected,work,'send');
  }
  private async withProfile<T>(context:NativeEmailConnectionContext,expected:NativeEmailAccount,
    work:(profile:EmailImapConnectorProfile)=>Promise<T>,purpose:'read'|'send'):Promise<T>{
    let scope: EmailImapScope;
    try { scope = Object.freeze(ScopeSchema.parse({ org_id: context.org_id, owner_user_id: context.owner_user_id, account_id: context.account_id })); } catch { return deny(); }
    if (!expected || expected.provider !== 'imap_smtp' || expected.account_id !== scope.account_id
      || expected.resource_binding_id !== context.resource_binding_id || expected.health !== 'connected'
      || !expected.capabilities.includes(purpose) || !Number.isSafeInteger(expected.authority_epoch) || expected.authority_epoch < 1
      || !Number.isSafeInteger(expected.connection_revision) || expected.connection_revision < 1
      || !/^[a-f0-9]{64}$/u.test(expected.principal_digest)) return deny();
    context.signal?.throwIfAborted();
    await recheckOrDeny(context.recheck);
    try {
      const raw = await this.store.read(scope);
      if (!raw) return deny();
      const { record, profile } = open(this.keys, scope, raw);
      if (record.connection_revision !== expected.connection_revision || record.principal_digest !== expected.principal_digest) return deny();
      await recheckOrDeny(context.recheck);
      context.signal?.throwIfAborted();
      const selected=purpose==='send'?profile.smtp:profile;if(!selected)return deny();
      const connectorProfile: { host: string; port: number; username: string; password: string;
        tls: { mode: 'implicit_tls' | 'starttls_required'; minVersion: 'TLSv1.2'; rejectUnauthorized: true } } = {
        host: selected.host, port: selected.port, username: selected.username, password: selected.password,
        tls: { mode: selected.transport, minVersion: 'TLSv1.2', rejectUnauthorized: true },
      };
      try { return await work(connectorProfile); }
      finally { connectorProfile.password = ''; profile.password = '';if(profile.smtp)profile.smtp.password=''; }
    } catch (error) {
      if (error instanceof EmailImapCustodyError) throw error;
      if (context.signal?.aborted) throw error;
      throw new EmailImapCustodyError('EMAIL_IMAP_CUSTODY_UNAVAILABLE');
    }
  }
}
