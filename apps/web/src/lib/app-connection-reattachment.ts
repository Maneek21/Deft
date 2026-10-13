import { AppConnectionSessionViewSchema, type AppConnectionSessionView } from '../../../../packages/app-kit/src/connection-session';
import { AppConnectionReattachAnyReviewViewSchema } from '../../../../packages/app-kit/src/connection-session-reattach';
import type { AppConnectionIdentity, AppConnectionTarget } from './app-connection-session-flow';

export type ExistingAccountReview = ReturnType<typeof AppConnectionReattachAnyReviewViewSchema.parse>;
export type ExistingAccountResult = ExistingAccountReview | AppConnectionSessionView;
type Account = NonNullable<AppConnectionSessionView['account']>;
export type AppConnectionReattachmentMetadata = {
  candidate: null | { source_session_id: string; source_revision: number; account: Account };
  pending: null | { session_id: string; state: 'starting' | 'reattach_reviewed' | 'reattaching' | 'reattach_checking' | 'indeterminate'; activation_started: boolean; review: ExistingAccountReview | null };
};
function fail(): never { throw Error('Account reuse was not confirmed. Check status before continuing.'); }
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail();
const exact = (v: Record<string, unknown>, keys: string) => { if (Object.keys(v).sort().join(',') !== keys.split(',').sort().join(',')) fail(); };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const accountSchema = AppConnectionSessionViewSchema.shape.account.unwrap();
const idSchema = AppConnectionSessionViewSchema.shape.session_id;
function reviewed(raw: unknown, target: AppConnectionTarget) {
  const value = AppConnectionReattachAnyReviewViewSchema.parse(raw);
  if (Boolean(target.upgrade)!==(value.schema_version==='deft.app_connection_reattach_review.v2')||!same(value.scope, target.scope) || Date.parse(value.expires_at) > Date.parse(target.scope.consent_expires_at)) fail();
  return value;
}
/** Closed host nomination only; no historical authority or runtime locator is accepted. */
export function appConnectionReattachmentMetadata(raw: unknown, target: AppConnectionTarget): AppConnectionReattachmentMetadata {
  const value = object(raw); exact(value, 'candidate,pending');
  let candidate: AppConnectionReattachmentMetadata['candidate'] = null, pending: AppConnectionReattachmentMetadata['pending'] = null;
  if (value.candidate !== null) {
    const c = object(value.candidate); exact(c, 'source_session_id,source_revision,account');
    const source_session_id = idSchema.parse(c.source_session_id);
    if (!Number.isInteger(c.source_revision) || (c.source_revision as number) < 1 || (c.source_revision as number) > 2147483646
      || target.session && !['not_connected', 'disconnected'].includes(target.session.state)
        && !(target.session.account === null && ['awaiting_callback', 'indeterminate'].includes(target.session.state) && Date.parse(target.session.expires_at) <= Date.now()) || source_session_id === target.session?.session_id) fail();
    candidate = { source_session_id, source_revision: c.source_revision as number, account: accountSchema.parse(c.account) };
  }
  if (value.pending !== null) {
    const p = object(value.pending); exact(p, 'session_id,state,activation_started,review');
    const session_id = idSchema.parse(p.session_id);
    if (candidate || !target.session || target.session.session_id !== session_id || target.session.state !== 'indeterminate'
      || !['starting', 'reattach_reviewed', 'reattaching', 'reattach_checking', 'indeterminate'].includes(String(p.state)) || typeof p.activation_started !== 'boolean') fail();
    const review = p.review === null ? null : reviewed(p.review, target);
    if (review && (p.activation_started || p.state !== 'reattach_reviewed' || review.session_id !== session_id
      || target.session.account && !same(target.session.account, review.account))) fail();
    pending = { session_id, state: p.state as NonNullable<typeof pending>['state'], activation_started: p.activation_started, review };
  }
  return { candidate, pending };
}

type Intent = { schema_version: 'deft.app_connection_reuse_pending.v1'; identity: AppConnectionIdentity; target_key: string;
  session_id: string; scope: AppConnectionSessionView['scope']; source_session_id: string | null; source_revision: number | null;
  account: Account | null; phase: 'reviewing' | 'reviewed' | 'activating' | 'resolved' };
type Ports = { identity: AppConnectionIdentity; storage: Pick<Storage, 'getItem' | 'setItem'>; current: () => void;
  target: (key: string) => AppConnectionTarget; post: (operation: string, input: unknown) => Promise<unknown>; now?: () => number };

/** One reviewed custody transition. Browser metadata fences acknowledgement loss;
 * durable host activation_started also fences recovery in another browser. */
export function createAppConnectionReattachmentFlow(ports: Ports) {
  let busy = false;
  const now = () => ports.now?.() ?? Date.now();
  // Each newly authorized scope has a distinct acknowledgement journal. Old
  // intent is retained as history and never becomes authority for an upgrade.
  const key = (targetKey: string) => `deft.app-connection-reuse.pending.v1:${JSON.stringify([ports.identity.orgId, ports.identity.ownerId, ports.identity.installationId, ports.identity.sessionTag, targetKey, ports.target(targetKey).scope])}`;
  function intent(target: AppConnectionTarget): Intent | null {
    const stored = ports.storage.getItem(key(target.target_key)); if (!stored) return null;
    if (stored.length > 8192) fail();
    const value = object(JSON.parse(stored)); exact(value, 'schema_version,identity,target_key,session_id,scope,source_session_id,source_revision,account,phase');
    if (value.schema_version !== 'deft.app_connection_reuse_pending.v1' || !same(value.identity, ports.identity) || value.target_key !== target.target_key
      || !['reviewing', 'reviewed', 'activating', 'resolved'].includes(String(value.phase))) fail();
    idSchema.parse(value.session_id);
    if (!same(value.scope, target.scope)) fail();
    if (value.source_session_id !== null) idSchema.parse(value.source_session_id);
    if (value.source_revision !== null && (!Number.isInteger(value.source_revision) || (value.source_revision as number) < 1 || (value.source_revision as number) > 2147483646)) fail();
    if (value.account !== null) accountSchema.parse(value.account);
    return value as Intent;
  }
  const store = (value: Intent) => ports.storage.setItem(key(value.target_key), JSON.stringify(value));
  const ready = (target: AppConnectionTarget) => { ports.current(); if (!target.runtime_ready || Date.parse(target.scope.consent_expires_at) <= now()) fail(); };
  function result(raw: unknown, target: AppConnectionTarget, expected: Intent, allowReview: boolean): ExistingAccountResult {
    if (['deft.app_connection_reattach_review.v1','deft.app_connection_reattach_review.v2'].includes(String(object(raw).schema_version))) {
      const value = reviewed(raw, target);
      if (!allowReview || expected.phase === 'activating' || target.reattachment?.pending?.activation_started || value.session_id !== expected.session_id
        || expected.source_session_id && value.source_session_id !== expected.source_session_id
        || expected.source_revision && value.source_revision !== expected.source_revision || expected.account && !same(value.account, expected.account)) fail();
      store({ ...expected, source_session_id: value.source_session_id, source_revision: value.source_revision, account: value.account, phase: 'reviewed' });
      target.session = { schema_version: 'deft.app_connection_session.v1', session_id: value.session_id,
        state: 'indeterminate', scope: value.scope, account: null, expires_at: value.scope.consent_expires_at };
      target.reattachment = { candidate: null, pending: { session_id: value.session_id, state: 'reattach_reviewed', activation_started: false, review: value } };
      return value;
    }
    const value = AppConnectionSessionViewSchema.parse(raw);
    if (!same(value.scope, target.scope) || value.session_id !== expected.session_id || Date.parse(value.expires_at) > Date.parse(target.scope.consent_expires_at)
      || Date.parse(value.expires_at) <= now() || !['connected', 'indeterminate', 'not_connected'].includes(value.state) || value.state === 'connected' && !value.account
      || value.state === 'not_connected' && value.account || expected.account && value.account && !same(value.account, expected.account)) fail();
    if (value.state === 'not_connected' && (expected.phase === 'activating' || target.reattachment?.pending?.activation_started)) fail();
    target.reattachment = { candidate: null, pending: value.state === 'indeterminate'
      ? { session_id: value.session_id, state: 'indeterminate', activation_started: expected.phase === 'activating' || !!target.reattachment?.pending?.activation_started, review: null } : null };
    store({ ...expected, account: value.account ?? expected.account, phase: value.state === 'indeterminate' ? expected.phase : 'resolved' });
    target.session = value; return value;
  }
  function pendingIntent(target: AppConnectionTarget) {
    const existing = intent(target); if (existing && existing.phase !== 'resolved') return existing;
    const pending = target.reattachment?.pending; if (!pending) return null;
    const review = pending.review;
    return { schema_version: 'deft.app_connection_reuse_pending.v1', identity: ports.identity, target_key: target.target_key,
      session_id: pending.session_id, scope: target.scope, source_session_id: review?.source_session_id ?? null,
      source_revision: review?.source_revision ?? null, account: review?.account ?? target.session?.account ?? null,
      phase: pending.activation_started ? 'activating' : review ? 'reviewed' : 'reviewing' } as Intent;
  }
  return {
    unresolved(targetKey: string) { ports.current(); const target = ports.target(targetKey); return !!pendingIntent(target); },
    reviewView(targetKey: string): ExistingAccountReview | null {
      ports.current(); const target = ports.target(targetKey), pending = pendingIntent(target);
      if (pending?.phase === 'activating' || target.reattachment?.pending?.activation_started) return null;
      const value = target.reattachment?.pending?.review ?? null;
      if (value && (!same(value.scope, target.scope) || pending && value.session_id !== pending.session_id)) fail();
      return value;
    },
    async review(targetKey: string): Promise<ExistingAccountResult> {
      ports.current(); if (busy) fail(); const target = ports.target(targetKey); ready(target);
      if (pendingIntent(target) || target.session && !['not_connected', 'disconnected'].includes(target.session.state)
        && !(target.reattachment?.candidate && target.session.account === null && ['awaiting_callback', 'indeterminate'].includes(target.session.state) && Date.parse(target.session.expires_at) <= now())) fail();
      const candidate = target.reattachment?.candidate; if (!candidate) fail();
      const expected: Intent = { schema_version: 'deft.app_connection_reuse_pending.v1', identity: ports.identity, target_key: targetKey,
        session_id: crypto.randomUUID(), scope: target.scope, source_session_id: candidate.source_session_id,
        source_revision: candidate.source_revision, account: candidate.account, phase: 'reviewing' };
      store(expected); busy = true;
      try {
        const raw = await ports.post('reattach/review', { installation_id: ports.identity.installationId, target_key: targetKey,
          source_session_id: candidate.source_session_id, request_id: expected.session_id });
        ports.current(); if (ports.target(targetKey) !== target) fail(); ready(target); return result(raw, target, expected, true);
      } finally { busy = false; }
    },
    async activate(targetKey: string): Promise<ExistingAccountResult> {
      ports.current(); if (busy) fail(); const target = ports.target(targetKey); ready(target);
      const pending = pendingIntent(target), value = this.reviewView(targetKey);
      if (!pending || pending.phase !== 'reviewed' || !value || Date.parse(value.expires_at) <= now()) fail();
      const expected: Intent = { ...pending, phase: 'activating' }; store(expected); target.reattachment = { candidate: null, pending: { session_id: expected.session_id, state: 'reattaching', activation_started: true, review: null } }; busy = true;
      try {
        const raw = await ports.post('reattach/activate', { session_id: expected.session_id, review_digest: value.review_digest });
        ports.current(); if (ports.target(targetKey) !== target) fail(); ready(target); return result(raw, target, expected, false);
      } finally { busy = false; }
    },
    async check(targetKey: string): Promise<ExistingAccountResult> {
      ports.current(); if (busy) fail(); const target = ports.target(targetKey); ready(target);
      const expected = pendingIntent(target); if (!expected) fail(); store(expected); busy = true;
      try {
        const raw = await ports.post('reattach/status', { session_id: expected.session_id });
        ports.current(); if (ports.target(targetKey) !== target) fail(); ready(target); return result(raw, target, expected, true);
      } finally { busy = false; }
    },
  };
}
