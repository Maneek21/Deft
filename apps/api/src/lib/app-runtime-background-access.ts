import { appConsentDeadline } from '@deft/app-kit';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { appRuntimeBindings, appRuntimeRegistrations } from '@deft/db/schema';
import { db } from './db.js';
import { AppError } from './app-errors.js';
import { env, isAppOwnerConnectionsEnabled } from './env.js';
import type { ModuleActor } from '@deft/shared/modules';
import type { ExperienceCaller } from './app-experience-service.js';
import type { WebAuthorityGuard } from './app-resource-sync-web-authority.js';
import type { AppConnectionSessionScope } from '@deft/app-kit';

// After an App upgrade the reviewed bindings move to the new version, but the
// Runtime still holds sessions for the old ones. A current owner re-establishes
// background access here: the Host issues sessions through the ordinary
// operator checks and delivers them over its authenticated Runtime transport.
// Session tokens never reach the browser, an agent or an operator file.
export const CHANNEL_INSTALL_SCHEMA = 'deft.app_runtime_channel_install.v1';
const RenewalSchema = z.union([
  z.strictObject({ expires_at: z.iso.datetime(), renewable_until: z.iso.datetime() }),
  z.strictObject({ expires_at: z.iso.datetime(), renewable_until: z.null(), renewal_lifetime: z.literal('until_revoked') }),
]);
export const ChannelInstallResultSchema = z.strictObject({
  schema_version: z.literal('deft.app_runtime_channel_install_result.v1'),
  installed: z.array(z.strictObject({ kind: z.enum(['action', 'observation']), runtime_registration_id: z.string().uuid(),
    session_id: z.string().uuid(), expires_at: z.iso.datetime() })).min(1).max(16),
});
export type BackgroundAccessResult = Readonly<{
  installed: z.infer<typeof ChannelInstallResultSchema>['installed'];
  skipped: Readonly<{ kind: 'observation'; reason: 'permission_not_until_revoked' }>[];
}>;
const denied = () => new AppError('Background access cannot be re-established', 'APP_ACCESS_DENIED', 403);
const MARGIN_MS = 60_000;

/** Public Host origin the Runtime calls back on, from operator configuration. */
export function backgroundChannelUrls(origin = env.DEFT_PUBLIC_URL || env.NEXT_PUBLIC_API_URL) {
  let base: URL;
  try { base = new URL(origin); } catch { throw denied(); }
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) throw denied();
  const at = (path: string) => new URL(path, base.origin).href;
  return { action: at('/api/app-runtime/channel'), observation: at('/api/app-resource-sync-channel/v3'),
    observation_authority: at('/api/app-resource-observations/runtime') };
}

/** Renewal the operator may request for the reviewed account consent. */
export function backgroundRenewalRequest(scope: Pick<AppConnectionSessionScope, 'consent_expires_at' | 'consent_lifetime'>, now = Date.now()) {
  if (scope.consent_lifetime === 'until_revoked') return { renewal_lifetime: 'until_revoked' as const, requested_until: null };
  const deadline = appConsentDeadline(scope.consent_expires_at, scope.consent_lifetime) - MARGIN_MS;
  if (!Number.isFinite(deadline) || deadline <= now) throw denied();
  return { requested_until: new Date(deadline) };
}

export type BackgroundAccessPorts = Readonly<{
  currentAuthority(caller: ExperienceCaller, nomination: { installation_id: string; target_key: string }, guard: WebAuthorityGuard):
    Promise<{ scope: AppConnectionSessionScope; profile: unknown }>;
  actionBindings(scope: AppConnectionSessionScope): Promise<readonly { id: string; runtime_registration_id: string; runtime_epoch: number }[]>;
  issueAction(actor: ModuleActor, bindingId: string, guard: WebAuthorityGuard, renewal: ReturnType<typeof backgroundRenewalRequest>, sid: string):
    Promise<{ session_id: string; session_token: string; expires_at: Date | string; renewable_until?: Date | string | null; renewal_lifetime?: 'until_revoked' } | null>;
  issueObservation(actor: ModuleActor, bindingId: string, guard: WebAuthorityGuard, sid: string):
    Promise<{ session_id: string; session_token: string; expires_at: Date | string; renewable_until?: null; renewal_lifetime?: 'until_revoked' }>;
  install(scope: AppConnectionSessionScope, profile: unknown, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}>;

const iso = (value: Date | string) => new Date(value).toISOString();

export async function reestablishBackgroundAccess(ports: BackgroundAccessPorts, actor: ModuleActor, caller: ExperienceCaller,
  nomination: { installation_id: string; target_key: string }, guard: WebAuthorityGuard, signal: AbortSignal): Promise<BackgroundAccessResult> {
  if (actor.kind !== 'human') throw denied();
  const { scope, profile } = await ports.currentAuthority(caller, nomination, guard);
  if (scope.owner_user_id !== actor.actor_id || scope.operator_user_id !== actor.actor_id) throw denied();
  const urls = backgroundChannelUrls(), renewal = backgroundRenewalRequest(scope);
  const channels: Record<string, unknown>[] = [], skipped: BackgroundAccessResult['skipped'][number][] = [];
  for (const binding of await ports.actionBindings(scope)) {
    const issued = await ports.issueAction(actor, binding.id, guard, renewal, caller.sid);
    if (!issued) throw denied();
    const technical_renewal = RenewalSchema.parse(issued.renewal_lifetime === 'until_revoked'
      ? { expires_at: iso(issued.expires_at), renewable_until: null, renewal_lifetime: 'until_revoked' }
      : { expires_at: iso(issued.expires_at), renewable_until: iso(issued.renewable_until!) });
    channels.push({ kind: 'action', channel: { channel_url: urls.action, credential: { session_id: issued.session_id, session_token: issued.session_token },
      registration: { org_id: scope.org_id, runtime_registration_id: binding.runtime_registration_id, runtime_epoch: binding.runtime_epoch }, technical_renewal } });
  }
  // Observation sessions only renew for an until-revoked account permission.
  if (scope.consent_lifetime === 'until_revoked') {
    const issued = await ports.issueObservation(actor, scope.resource_binding_id, guard, caller.sid);
    channels.push({ kind: 'observation', channel: { channel_url: urls.observation, observation_authority_url: urls.observation_authority,
      credential: { session_id: issued.session_id, session_token: issued.session_token },
      registration: { org_id: scope.org_id, runtime_registration_id: scope.runtime_registration_id, operator_user_id: scope.operator_user_id,
        runtime_epoch: scope.runtime_epoch, profile_digest: scope.profile_digest, target_key: scope.target_key, resource_key: scope.resource_key },
      technical_renewal: RenewalSchema.parse({ expires_at: iso(issued.expires_at), renewable_until: null, renewal_lifetime: 'until_revoked' }) } });
  } else skipped.push({ kind: 'observation', reason: 'permission_not_until_revoked' });
  if (!channels.length) throw denied();
  const result = ChannelInstallResultSchema.parse(await ports.install(scope, profile,
    { schema_version: CHANNEL_INSTALL_SCHEMA, scope, channels }, signal));
  const expected = new Set(channels.map(entry => ((entry.channel as { credential: { session_id: string } }).credential.session_id)));
  if (result.installed.length !== expected.size || result.installed.some(item => !expected.has(item.session_id))) throw denied();
  return { installed: result.installed, skipped };
}

/** Service reconciliation uses the same installer and current reviewed bindings.
 * Its authenticated guard replaces only browser liveness, never grant checks. */
export async function reconcileRuntimeBackgroundAccess(raw:unknown,authorization:string|undefined,signal:AbortSignal){
  const {runtimeBackgroundAccessAuthority}=await import('./app-runtime-authority-service.js');
  const authority=await runtimeBackgroundAccessAuthority(raw,authorization);
  const ports=productionBackgroundAccessPorts();
  return reestablishBackgroundAccess({...ports,currentAuthority:async()=>authority},authority.actor,authority.caller,
    {installation_id:authority.scope.installation_id,target_key:authority.scope.target_key},authority.guard,signal);
}

export async function currentActionBindings(scope: AppConnectionSessionScope) {
  return db.select({ id: appRuntimeBindings.id, runtime_registration_id: appRuntimeBindings.runtime_registration_id,
    runtime_epoch: appRuntimeRegistrations.runtime_epoch })
    .from(appRuntimeBindings).innerJoin(appRuntimeRegistrations, and(eq(appRuntimeRegistrations.org_id, appRuntimeBindings.org_id),
      eq(appRuntimeRegistrations.id, appRuntimeBindings.runtime_registration_id)))
    .where(and(eq(appRuntimeBindings.org_id, scope.org_id), eq(appRuntimeBindings.app_installation_id, scope.installation_id),
      eq(appRuntimeBindings.app_version_id, scope.app_version_id), eq(appRuntimeBindings.owner_resource_binding_id, scope.resource_binding_id),
      eq(appRuntimeBindings.state, 'active'), eq(appRuntimeRegistrations.state, 'active'),
      eq(appRuntimeRegistrations.operator_user_id, scope.operator_user_id)))
    .orderBy(asc(appRuntimeBindings.action_key)).limit(8);
}

export function productionBackgroundAccessPorts(): BackgroundAccessPorts {
  return {
    currentAuthority: async (caller, nomination, guard) => {
      if (process.env.DEFT_APPS_ENABLED !== 'true' || !isAppOwnerConnectionsEnabled()) throw denied();
      const { currentAppConnectionSessionV2Authority } = await import('./app-connection-session-authority.js');
      return currentAppConnectionSessionV2Authority(caller, nomination, guard);
    },
    actionBindings: currentActionBindings,
    issueAction: async (actor, bindingId, guard, renewal, sid) => {
      const { issueRuntimeOperatorSession } = await import('./app-runtime-management.js');
      return issueRuntimeOperatorSession(actor, bindingId, { guard, technical_renewal: { requested_until: renewal.requested_until, sid,
        ...('renewal_lifetime' in renewal ? { renewal_lifetime: renewal.renewal_lifetime } : {}) } });
    },
    issueObservation: async (actor, bindingId, guard, sid) => {
      if (actor.kind !== 'human') throw denied();
      const { getAppAttachmentRuntime } = await import('./app-attachment-runtime.js');
      return (await getAppAttachmentRuntime()).management.issueOperatorSession(actor, bindingId, guard, { sid, role: actor.role });
    },
    install: async (scope, profile, input, signal) => {
      const { getAppConnectionSessionRegistry } = await import('./app-connection-session-registry.js');
      return (await getAppConnectionSessionRegistry()).channelInstallRuntime(scope, profile as never).request({ ...input, scope }, signal);
    },
  };
}
