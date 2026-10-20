import { appConsentDeadline } from '../../../../packages/app-kit/src/consent-lifetime';
import { AppDataContextSchema, AppDataConsentSnapshotSchema, AppDataConsentReferenceSchema } from '../../../../packages/app-kit/src/app-data';
import { createResourceObservationFlow } from './app-resource-observation';
import type { AppConnectionTarget } from './app-connection-session-flow';
import { canonicalConnectionReattachmentJson } from '../../../../packages/app-kit/src/connection-session-reattach';
import { boundedConfirmationJson } from './app-experience-action-confirmation';

type Choice = { expires_at: null; consent_lifetime: 'until_revoked' } | { expires_at: string; consent_lifetime?: undefined };
export type InitialConnectPlan = { schema_version: 'deft.initial_connect_consent.v1'; org_id: string; owner_user_id: string;
  installation_id: string; session_tag: string; target_key: string; resource_binding_id: string; app_version_id: string;
  grant_snapshot_id: string; resource_key: string; choice: Choice; completed_stores: string[];
  pending_store: { key: string; phase: 'reviewing' | 'activating'; consent_id: string | null } | null;
  observation: unknown; phase: 'permissions' | 'installing' | 'complete' };
const fail = (): never => { throw Error('Initial account setup metadata changed. Check account permissions.'); };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const closed = (value: Record<string, unknown>, keys: string) => { if (Object.keys(value).sort().join(',') !== keys.split(',').sort().join(',')) fail(); };
const key = (value: unknown) => typeof value === 'string' && /^[a-z][a-z0-9_]{0,47}$/u.test(value) && !['constructor','prototype','__proto__'].includes(value);
const id = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value);
const Choice = { parse(raw: unknown): Choice { const value = object(raw);
  closed(value, value.consent_lifetime === 'until_revoked' ? 'expires_at,consent_lifetime' : 'expires_at');
  appConsentDeadline(value.expires_at as string | null, value.consent_lifetime as 'until_revoked' | undefined);
  return value as Choice;
} };
const Plan = { parse(raw: unknown): InitialConnectPlan { const value = object(raw);
  closed(value, 'schema_version,org_id,owner_user_id,installation_id,session_tag,target_key,resource_binding_id,app_version_id,grant_snapshot_id,resource_key,choice,completed_stores,pending_store,observation,phase');
  if (value.schema_version !== 'deft.initial_connect_consent.v1' || !['org_id','owner_user_id','installation_id','resource_binding_id','app_version_id','grant_snapshot_id'].every(name => id(value[name]))
    || typeof value.session_tag !== 'string' || !/^[a-f0-9]{64}$/u.test(value.session_tag) || !key(value.target_key) || !key(value.resource_key)
    || !Array.isArray(value.completed_stores) || value.completed_stores.length > 16 || value.completed_stores.some(k => !key(k)) || new Set(value.completed_stores).size !== value.completed_stores.length
    || !['permissions','installing','complete'].includes(String(value.phase))) fail();
  Choice.parse(value.choice);
  if (value.pending_store !== null) { const pending = object(value.pending_store); closed(pending, 'key,phase,consent_id');
    if (!key(pending.key) || !['reviewing','activating'].includes(String(pending.phase)) || (pending.phase === 'reviewing' ? pending.consent_id !== null : !id(pending.consent_id))) fail(); }
  return value as InitialConnectPlan;
} };
export const initialConnectPlanKey = (org: string, owner: string, installation: string, target: string) =>
  `deft.initial-connect:${org}:${owner}:${installation}:${target}`;
export const initialConnectChoice = (allowUntilRevoked: boolean, until: string, finite = false) =>
  Choice.parse(allowUntilRevoked && !finite ? { expires_at: null, consent_lifetime: 'until_revoked' } : { expires_at: until });

/** Only the explicit initial Allow handler writes this metadata journal.
 * Existing connected accounts never create one by loading settings. */
export function initialConnectPlan(raw: unknown): InitialConnectPlan { return Plan.parse(raw); }

type Ports = { target: Pick<AppConnectionTarget, 'target_key' | 'scope' | 'session'>; org: string; owner: string; installation: string; sessionTag: string;
  current: () => boolean; signal: AbortSignal; load: () => unknown; save: (plan: InitialConnectPlan) => void;
  request: (path: string, body?: unknown) => Promise<unknown> };

/** Apply the single disclosed choice only after the exact connection ACK.
 * Every mutation still crosses the existing Host consent boundary. The journal
 * fences uncertain writes across OAuth navigation/remount; it is no authority. */
export async function finishInitialConnectConsent(ports: Ports): Promise<void> {
  const raw = ports.load(); if (raw == null) return;
  let plan = Plan.parse(raw);
  const target = ports.target, session = target.session, scope = target.scope;
  const check = () => {
    ports.signal.throwIfAborted();
    if (!ports.current() || session?.state !== 'connected' || !session.account
      || plan.org_id !== ports.org || plan.owner_user_id !== ports.owner || plan.installation_id !== ports.installation
      || plan.session_tag !== ports.sessionTag || scope.org_id !== ports.org || scope.owner_user_id !== ports.owner
      || scope.installation_id !== ports.installation || plan.target_key !== target.target_key
      || plan.resource_binding_id !== scope.resource_binding_id || plan.app_version_id !== scope.app_version_id
      || plan.grant_snapshot_id !== scope.grant_snapshot_id || plan.resource_key !== scope.resource_key
      || canonicalConnectionReattachmentJson(session.scope) !== canonicalConnectionReattachmentJson(scope)
      || plan.choice.expires_at !== scope.consent_expires_at
      || ('consent_lifetime' in plan.choice ? plan.choice.consent_lifetime : undefined) !== scope.consent_lifetime
      || appConsentDeadline(plan.choice.expires_at, 'consent_lifetime' in plan.choice ? plan.choice.consent_lifetime : undefined) <= Date.now())
      throw Error('Initial account permission changed. Review account setup.');
  };
  const save = (change: Partial<InitialConnectPlan>) => { check(); plan = Plan.parse({ ...plan, ...change }); ports.save(plan); };
  const request = async (path: string, body?: unknown) => { check(); const result = await ports.request(path, body); check(); return result; };
  check(); if (plan.phase === 'complete') return;
  if (plan.phase === 'installing') throw Error('Background installation acknowledgement was not confirmed. Check background access before re-establishing it.');
  const context = AppDataContextSchema.parse(await request(`/api/app-data/installations/${ports.installation}/context?target_key=${encodeURIComponent(target.target_key)}`));
  const connected = context.targets.find(row => row.session_id === session!.session_id && row.target_key === target.target_key);
  if (context.installation_id !== ports.installation || !connected || connected.account.account_ref !== session!.account!.account_ref
    || connected.resource_key !== scope.resource_key || connected.stores.some(store => store.declaration.resource_key !== scope.resource_key))
    throw Error('Private account records changed. Check setup status.');
  for (const store of connected.stores) {
    const storeKey = store.declaration.key;
    if (plan.completed_stores.includes(storeKey)) continue;
    if (store.consent) {
      // An acknowledged existing grant is never lengthened, including finite grants.
      if (plan.pending_store && (plan.pending_store.key !== storeKey || plan.pending_store.consent_id !== store.consent.consent_id))
        throw Error('Private record permission was not confirmed. Check account permissions.');
      save({ pending_store: null, completed_stores: [...plan.completed_stores, storeKey] }); continue;
    }
    if (plan.pending_store) throw Error('Private record permission was not confirmed. Check account permissions; do not repeat Allow.');
    const base = `/api/app-data/connections/${session!.session_id}/consent`;
    save({ pending_store: { key: storeKey, phase: 'reviewing', consent_id: null } });
    const reviewed = await request(`${base}/review`, { store_key: storeKey, ...plan.choice }) as { snapshot: unknown; review_digest: string };
    const snapshot = AppDataConsentSnapshotSchema.parse(reviewed.snapshot);
    if (!/^sha256:[a-f0-9]{64}$/u.test(reviewed.review_digest) || snapshot.connection.session_id !== session!.session_id
      || snapshot.connection.account_ref !== session!.account!.account_ref || snapshot.store.key !== storeKey
      || canonicalConnectionReattachmentJson(snapshot.scope) !== canonicalConnectionReattachmentJson(scope)
      || canonicalConnectionReattachmentJson(snapshot.store) !== canonicalConnectionReattachmentJson(store.declaration)
      || snapshot.consent_lifetime !== scope.consent_lifetime
      || appConsentDeadline(snapshot.expires_at, snapshot.consent_lifetime) <= Date.now()
      || Date.parse(snapshot.review_expires_at ?? snapshot.expires_at!) <= Date.now()
      || appConsentDeadline(snapshot.expires_at, snapshot.consent_lifetime) > appConsentDeadline(plan.choice.expires_at, scope.consent_lifetime))
      throw Error('Private record review changed. Check account permissions.');
    save({ pending_store: { key: storeKey, phase: 'activating', consent_id: snapshot.consent_id } });
    const grant = AppDataConsentReferenceSchema.parse(await request(`${base}/activate`, { store_key: storeKey,
      expires_at: snapshot.expires_at, ...(snapshot.consent_lifetime ? { consent_lifetime: snapshot.consent_lifetime } : {}),
      consent_id: snapshot.consent_id, expected_review_digest: reviewed.review_digest, accept_host_policy: true }));
    if (grant.consent_id !== snapshot.consent_id || grant.consent_digest !== reviewed.review_digest
      || grant.expires_at !== snapshot.expires_at || grant.consent_lifetime !== snapshot.consent_lifetime)
      throw Error('Private record acknowledgement changed. Check account permissions.');
    save({ pending_store: null, completed_stores: [...plan.completed_stores, storeKey] });
  }
  const observation = createResourceObservationFlow({ identity: { installation_id: ports.installation, org_id: ports.org,
    owner_user_id: ports.owner, target_key: target.target_key, scope, connection_session_id: session!.session_id,
    account_ref: session!.account!.account_ref }, current: ports.current, signal: ports.signal,
    call: (path, init) => request(path, init.body ? JSON.parse(String(init.body)) : undefined),
    load: () => plan.observation, store: value => save({ observation: value }) });
  await observation.load();
  if (!observation.status) {
    if (observation.pending) await observation.check();
    else await observation.prepare(observation.target!.min_interval_seconds, plan.choice);
  }
  if (observation.review && !observation.uncertain && !await observation.activate())
    throw Error('Background refresh permission was not confirmed. Check setup status.');
  if (observation.status?.state !== 'active') throw Error('Background refresh needs its permission checked.');
  // This endpoint issues only channels for separately reviewed rights. It never
  // grants Send, organize or provider mirroring. No channel token enters the UI.
  if (scope.consent_lifetime !== 'until_revoked')
    throw Error('Finite private-record and observation permissions are saved. Automatic renewable background channels require an until-revoked account permission.');
  save({ phase: 'installing' });
  const installed = await request(`/api/app-connection-sessions/installations/${ports.installation}/background-access`, {
    target_key: target.target_key,
  }) as { installed?: { kind: string; runtime_registration_id: string; session_id: string; expires_at: string }[] };
  if (!Array.isArray(installed?.installed) || installed.installed.length > 16 || !installed.installed.some(item =>
    item.kind === 'observation' && item.runtime_registration_id === scope.runtime_registration_id && id(item.session_id)
      && Date.parse(item.expires_at) > Date.now()))
    throw Error('Background channel installation was not acknowledged. Check background access.');
  save({ phase: 'complete' });
}

/** The OAuth callback and settings recovery use the same post-ACK path. */
export async function finishAcknowledgedInitialConnection(options: {
  target: Ports['target']; org: string; owner: string; installation: string; sessionTag: string;
  storage: Pick<Storage, 'getItem' | 'setItem'>; current: () => boolean; signal: AbortSignal;
  fetch: (path: string, init: RequestInit) => Promise<Response>;
}): Promise<boolean> {
  const key = initialConnectPlanKey(options.org, options.owner, options.installation, options.target.target_key);
  const stored = options.storage.getItem(key); if (!stored) return false;
  if (stored.length > 16384) fail();
  await finishInitialConnectConsent({ ...options,
    load: () => { const value = options.storage.getItem(key); if (value === null || value.length > 16384) return fail(); return JSON.parse(value); },
    save: plan => options.storage.setItem(key, JSON.stringify(plan)),
    request: async (path, body) => {
      if (!options.current()) throw Error('Account setup session ended.');
      const response = await options.fetch(path, { method: body === undefined ? 'GET' : 'POST',
        signal: AbortSignal.any([options.signal, AbortSignal.timeout(35000)]), cache: 'no-store',
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      return boundedConfirmationJson(response);
    } });
  return true;
}
