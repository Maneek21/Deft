import { lookup as systemLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { canonicalCapabilityJson } from '@deft/shared';
import { z } from 'zod';
import type { NativeEmailAccount, NativeEmailConnectionContext } from './app-connection-contract.js';
import type { EmailImapCredentialCustody } from './email-imap-custody.js';
import {publicEmailServerAddress as publicImageAddress} from './email-public-address.js';

const TRUSTED_FIELDS = ['org_id', 'owner_user_id', 'installation_id', 'account_id', 'provider', 'resource_binding_id',
  'authority_epoch', 'connection_revision', 'principal_digest', 'health', 'capabilities', 'primary_address', 'display_label'] as const;
const HostAccountSchema = z.strictObject({
  org_id: z.string().min(1).max(256), owner_user_id: z.string().min(1).max(256), installation_id: z.string().min(1).max(256),
  account_id: z.string().min(1).max(256), provider: z.literal('imap_smtp'), resource_binding_id: z.string().min(1).max(256),
  authority_epoch: z.number().int().positive().safe(), connection_revision: z.number().int().positive().safe(),
  principal_digest: z.string().regex(/^[a-f0-9]{64}$/u), health: z.enum(['connected', 'reauth_required', 'revoked', 'unavailable']),
  capabilities: z.array(z.enum(['read', 'search', 'thread', 'send', 'modify', 'permanent_delete'])).max(6),
  primary_address: z.string().min(1).max(256), display_label: z.string().min(1).max(256),
  connection_target:z.string().min(1).max(256).optional(),action_binding_id:z.string().min(1).max(256).optional(),verified_sender_identities:z.array(z.string().email().max(320)).max(32).optional(),
});
const NativeAccountSchema = HostAccountSchema.omit({ org_id: true, owner_user_id: true, installation_id: true,connection_target:true,action_binding_id:true,verified_sender_identities:true });
const CONNECT_TIMEOUT_MS = 20_000;
const DNS_TIMEOUT_MS = 5_000;
const CONNECTOR_OPTIONS = Object.freeze({ connectionTimeout: CONNECT_TIMEOUT_MS, greetingTimeout: 10_000, socketTimeout: 30_000,
  logger: false, logRaw: false, emitLogs: false, disableAutoIdle: true, maxLineLength: 1_048_576, maxLiteralSize: 1_048_576,
  maxResponseSize: 2_097_152, maxMessageSize: 1_048_576 });

export type EmailImapHostAccount = Readonly<Omit<z.infer<typeof HostAccountSchema>, 'capabilities'> & {
  capabilities: ReadonlyArray<z.infer<typeof HostAccountSchema>['capabilities'][number]>;
}>;
export type EmailImapHostContext = NativeEmailConnectionContext;
export type EmailImapFlowClient = {
  connect(): Promise<unknown>; logout(): Promise<unknown>; close(): void;
  authenticated?: unknown; secureConnection?: boolean; tls?: { authorized?: boolean } | false | null;
  options?: { auth?: { pass?: string; user?: string } };
};
export type EmailImapFlowConstructor = new(options: Record<string, unknown>) => EmailImapFlowClient;
export type EmailImapHostDependencies = Readonly<{
  custody: Pick<EmailImapCredentialCustody, 'withVerifiedProfile'>;
  /** SQL-only account/custody metadata reader. It must never connect to IMAP. */
  current: (context: EmailImapHostContext,purpose?:'read'|'modify'|'send') => Promise<EmailImapHostAccount>;
  ImapFlow: EmailImapFlowConstructor;
  lookup?: (hostname: string, options: { all: true; verbatim: true }) => Promise<readonly { address: string; family: number }[]>;
}>;

export class EmailImapHostError extends Error {
  constructor(readonly code: 'EMAIL_ACCESS_DENIED' | 'EMAIL_IMAP_TLS_REQUIRED' | 'EMAIL_IMAP_CONNECT_FAILED') {
    super(code); this.name = 'EmailImapHostError';
  }
}

const denied = (): never => { throw new EmailImapHostError('EMAIL_ACCESS_DENIED'); };
function normalizeAccount(value: unknown, context: EmailImapHostContext): EmailImapHostAccount {
  const parsed = HostAccountSchema.safeParse(value);
  if (!parsed.success) return denied();
  const account = parsed.data;
  if (account.org_id !== context.org_id || account.owner_user_id !== context.owner_user_id
    || account.installation_id !== context.installation_id || account.account_id !== context.account_id
    || account.resource_binding_id !== context.resource_binding_id || new Set(account.capabilities).size !== account.capabilities.length) return denied();
  return Object.freeze({ ...account, capabilities: Object.freeze([...account.capabilities]) });
}
function sameExpected(current: EmailImapHostAccount, rawExpected: NativeEmailAccount): boolean {
  const {connection_target:target,action_binding_id:action,verified_sender_identities:senders,...base}=rawExpected as NativeEmailAccount&Partial<Pick<EmailImapHostAccount,'connection_target'|'action_binding_id'|'verified_sender_identities'>>;
  const parsed = NativeAccountSchema.safeParse(base);
  if (!parsed.success) return false;
  const { org_id: _org, owner_user_id: _owner, installation_id: _installation,connection_target:_target,action_binding_id:_action,verified_sender_identities:_senders, ...visible } = current;
  return canonicalCapabilityJson(visible) === canonicalCapabilityJson(parsed.data)
    &&(target===undefined||target===current.connection_target)&&(action===undefined||action===current.action_binding_id)
    &&(senders===undefined||canonicalCapabilityJson(senders)===canonicalCapabilityJson(current.verified_sender_identities));
}

function abortable<T>(pending: Promise<T>, signal?: AbortSignal, timeoutMs = DNS_TIMEOUT_MS): Promise<T> {
  signal?.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: (value: any) => void, value: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); callback(value);
    };
    const onAbort = () => finish(reject, signal?.reason ?? new Error('Aborted'));
    const timer = setTimeout(() => finish(reject, new Error('IMAP DNS resolution timed out')), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.then(value => finish(resolve, value), error => finish(reject, error));
  });
}

async function resolvePinned(host: string, resolver: NonNullable<EmailImapHostDependencies['lookup']>, signal?: AbortSignal) {
  if (!host || host.length > 253 || host.endsWith('.') || isIP(host) !== 0 || host === 'localhost' || host.endsWith('.localhost')) return denied();
  let addresses: readonly { address: string; family: number }[];
  try { addresses = await abortable(Promise.resolve(resolver(host, { all: true, verbatim: true })), signal); }
  catch (error) { if (signal?.aborted) throw error; throw new EmailImapHostError('EMAIL_IMAP_CONNECT_FAILED'); }
  signal?.throwIfAborted();
  if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > 32
    || addresses.some(row => !row || !publicImageAddress(row.address) || row.family !== isIP(row.address))) return denied();
  const selected = { address: addresses[0]!.address, family: addresses[0]!.family };
  const lookup = (_hostname: string, options: { all?: boolean; family?: number }, callback: (...values: unknown[]) => void) => {
    if (options.family && options.family !== selected.family) {
      callback(Object.assign(new Error('Address family unavailable'), { code: 'EAI_ADDRFAMILY' })); return;
    }
    if (options.all) callback(null, [{ ...selected }]);
    else callback(null, selected.address, selected.family);
  };
  return lookup;
}

/** Trusted host-side connector composition for the native IMAP bridge. It only
 * connects after SQL metadata, encrypted profile custody, and pinned public DNS
 * validation agree. All profile fields remain inside the closure. */
export function createEmailImapHost(dependencies: EmailImapHostDependencies) {
  if (!dependencies || typeof dependencies.current !== 'function' || typeof dependencies.custody?.withVerifiedProfile !== 'function'
    || typeof dependencies.ImapFlow !== 'function') throw new TypeError('IMAP host dependencies are incomplete');
  const resolver = dependencies.lookup ?? ((hostname, options) => systemLookup(hostname, options));
  const current = async (context: EmailImapHostContext,purpose:'read'|'modify'|'send'='read'): Promise<EmailImapHostAccount> => {
    try {
      context.signal?.throwIfAborted();
      if (context.expires_at <= Date.now()) return denied();
      await context.recheck();
      const account = normalizeAccount(await dependencies.current(context,purpose), context);
      await context.recheck();
      context.signal?.throwIfAborted();
      if (context.expires_at <= Date.now()) return denied();
      return account;
    } catch (error) {
      if (error instanceof EmailImapHostError) throw error;
      if (context.signal?.aborted) throw error;
      return denied();
    }
  };
  const withAuthorizedClient = async <T>(context: EmailImapHostContext, expected: NativeEmailAccount,
    work: (client: EmailImapFlowClient) => Promise<T>,purpose:'read'|'modify'='read'): Promise<T> => {
    if(context.lifecycle_inspect!==undefined)return denied();
    let before = await current(context,purpose);
    if (before.health !== 'connected' || !before.capabilities.includes(purpose) || !sameExpected(before, expected)) return denied();
    return dependencies.custody.withVerifiedProfile(context, expected, async profile => {
      let client: EmailImapFlowClient | undefined;
      let aborted = false, connected = false, clientClosed = false;
      const closeClient = () => { if (client && !clientClosed) { clientClosed = true; try { client.close(); } catch {} } };
      const onAbort = () => { aborted = true; closeClient(); };
      context.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        context.signal?.throwIfAborted();
        if ((profile.tls.mode === 'implicit_tls' && profile.port !== 993)
          || (profile.tls.mode === 'starttls_required' && profile.port !== 143)
          || profile.tls.minVersion !== 'TLSv1.2' || profile.tls.rejectUnauthorized !== true
          || typeof profile.username !== 'string' || profile.username.length < 1 || profile.username.length > 512
          || typeof profile.password !== 'string' || profile.password.length < 1 || profile.password.length > 8192) return denied();
        before = await current(context,purpose);
        if (before.health !== 'connected' || !before.capabilities.includes(purpose) || !sameExpected(before, expected)) return denied();
        const pinnedLookup = await resolvePinned(profile.host, resolver, context.signal);
        const afterDns = await current(context,purpose);
        if (afterDns.health !== 'connected' || !afterDns.capabilities.includes(purpose)
          || canonicalCapabilityJson(afterDns) !== canonicalCapabilityJson(before)) return denied();
        const secure = profile.tls.mode === 'implicit_tls';
        client = new dependencies.ImapFlow({ ...CONNECTOR_OPTIONS, host: profile.host, port: profile.port, servername: profile.host,
          secure, ...(secure ? {} : { doSTARTTLS: true }), auth: { user: profile.username, pass: profile.password },
          tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: profile.host, lookup: pinnedLookup } });
        await client.connect();
        connected = true;
        context.signal?.throwIfAborted();
        if (aborted) return denied();
        if (client.secureConnection !== true || client.tls === false || client.tls?.authorized !== true || !client.authenticated) {
          throw new EmailImapHostError('EMAIL_IMAP_TLS_REQUIRED');
        }
        const accountAfterConnect = await current(context,purpose);
        if (accountAfterConnect.health !== 'connected' || !accountAfterConnect.capabilities.includes(purpose)
          || canonicalCapabilityJson(accountAfterConnect) !== canonicalCapabilityJson(before)) return denied();
        const result = await work(client);
        context.signal?.throwIfAborted();
        if (aborted) return denied();
        const final = await current(context,purpose);
        if (final.health !== 'connected' || !final.capabilities.includes(purpose)
          || canonicalCapabilityJson(final) !== canonicalCapabilityJson(before)) return denied();
        return result;
      } catch (error) {
        if (error instanceof EmailImapHostError) throw error;
        if (context.signal?.aborted) throw error;
        throw new EmailImapHostError('EMAIL_IMAP_CONNECT_FAILED');
      } finally {
        context.signal?.removeEventListener('abort', onAbort);
        if (client?.options?.auth) client.options.auth.pass = '';
        if (client) {
          if (aborted || context.signal?.aborted) closeClient();
          else if (connected) { try { await client.logout(); } catch {} closeClient(); }
          else closeClient();
        }
      }
    });
  };
  return Object.freeze({ current, withAuthorizedClient });
}
