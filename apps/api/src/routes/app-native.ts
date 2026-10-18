import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { AppDigestSchema } from '@deft/app-kit';
import type { AuthUser } from '../middleware/auth.js';
import { resourceSyncWebAuthority, ResourceSyncWebAuthenticationError } from '../lib/app-resource-sync-web-authority.js';
import { assertNativeCalendarEnabled } from '../lib/app-native-authority.js';
import { getNativeAppReviewContext, prepareNativeAppReview, activateNativeApp } from '../lib/app-native-review.js';
import { stageNativeBinding, getNativeOwnerContext, prepareNativeOwnerReview, acceptNativeOwnerConsent, revokeNativeBinding } from '../lib/app-native-management.js';
import { appHttpFailure } from './app-http-errors.js';
import { AppRunError } from '../lib/app-run-errors.js';
import { getAppRunRuntime } from '../lib/app-run-runtime.js';
import { isAppError } from '../lib/app-errors.js';
import { isModuleError } from '../lib/module-errors.js';
import { stageNativeAppUpgrade, getNativeUpgradeContext, prepareNativeUpgrade, activateNativeUpgrade } from '../lib/app-runtime-upgrade.js';

export const appNativeRoutes = new Hono();
function failure(c: Context, error: unknown) {
  if (error instanceof AppRunError) return appHttpFailure(c, error, 'App Run', 'app-runs');
  if (isAppError(error) || isModuleError(error) || error instanceof ResourceSyncWebAuthenticationError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: 'Invalid native Calendar request', code: 'VALIDATION_ERROR' }, 400);
  return c.json({ error: 'Native Calendar request failed', code: 'INTERNAL_ERROR' }, 500);
}
async function authority(c: Context) {
  const user = c.get('user') as AuthUser | undefined;
  if (!user?.sid) throw new ResourceSyncWebAuthenticationError('Web authentication required');
  const { actor, guard } = await resourceSyncWebAuthority(c.req.header('authorization'), { org_id: user.org_id, user_id: user.id, sid: user.sid });
  return { actor, options: { guard } };
}
async function body(c: Context): Promise<unknown> {
  if (new URL(c.req.url).search || !/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type') ?? '')) throw new SyntaxError();
  return c.req.json();
}
function query(c: Context) {
  if (Object.values(c.req.queries()).some(values => values.length !== 1)) throw new SyntaxError();
  return z.strictObject({ app_version_id: z.uuid() }).parse(c.req.query());
}
appNativeRoutes.use('*', (c, next) => bodyLimit({ maxSize: c.req.path.endsWith('/upgrade/stage') ? 1_048_576 : 8192 })(c, next));
appNativeRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store'); c.header('Pragma', 'no-cache');
  try { assertNativeCalendarEnabled(); await next(); } catch (error) { return failure(c, error); }
});
appNativeRoutes.get('/app/:installationId/context', async c => {
  try {
    const q = query(c), { actor, options } = await authority(c);
    return c.json(await getNativeAppReviewContext(actor, z.uuid().parse(c.req.param('installationId')), q.app_version_id, options));
  } catch (error) { return failure(c, error); }
});
appNativeRoutes.post('/app/:installationId/upgrade/stage', async c => {
  try {
    const raw = await body(c), { actor, options } = await authority(c);
    return c.json(await stageNativeAppUpgrade(actor, z.uuid().parse(c.req.param('installationId')), raw, options));
  } catch (error) { return failure(c, error); }
});
appNativeRoutes.get('/app/:installationId/upgrade/context', async c => {
  try {
    const q = query(c), { actor, options } = await authority(c);
    return c.json(await getNativeUpgradeContext(actor, z.uuid().parse(c.req.param('installationId')), q.app_version_id, options));
  } catch (error) { return failure(c, error); }
});
for (const operation of ['review', 'activate'] as const) appNativeRoutes.post(`/app/:installationId/upgrade/${operation}`, async c => {
  try {
    const raw = await body(c), { actor, options } = await authority(c), id = z.uuid().parse(c.req.param('installationId'));
    return c.json(operation === 'review' ? await prepareNativeUpgrade(actor, id, raw, options) : await activateNativeUpgrade(actor, id, raw, options));
  } catch (error) { return failure(c, error); }
});
for (const operation of ['review', 'activate'] as const) appNativeRoutes.post(`/app/:installationId/${operation}`, async c => {
  try {
    const raw = await body(c), { actor, options } = await authority(c), id = z.uuid().parse(c.req.param('installationId'));
    return c.json(operation === 'review' ? await prepareNativeAppReview(actor, id, raw, options) : await activateNativeApp(actor, id, raw, options));
  } catch (error) { return failure(c, error); }
});
appNativeRoutes.post('/bindings/stage', async c => {
  try {
    const raw = await body(c), { actor, options } = await authority(c);
    return c.json(await stageNativeBinding(actor, raw, options));
  } catch (error) { return failure(c, error); }
});
appNativeRoutes.get('/bindings/:bindingId/context', async c => {
  try {
    if (new URL(c.req.url).search) throw new SyntaxError();
    const { actor, options } = await authority(c);
    return c.json(await getNativeOwnerContext(actor, z.uuid().parse(c.req.param('bindingId')), options));
  } catch (error) { return failure(c, error); }
});
for (const operation of ['review', 'accept'] as const) appNativeRoutes.post(`/bindings/:bindingId/${operation}`, async c => {
  try {
    const raw = await body(c), { actor, options } = await authority(c), id = z.uuid().parse(c.req.param('bindingId'));
    const locator = z.object({ binding_id: z.uuid() }).parse(raw);
    if (locator.binding_id !== id) throw new SyntaxError();
    return c.json(operation === 'review' ? await prepareNativeOwnerReview(actor, raw, options) : await acceptNativeOwnerConsent(actor, raw, options));
  } catch (error) { return failure(c, error); }
});
appNativeRoutes.post('/bindings/:bindingId/revoke', async c => {
  try {
    const raw = z.strictObject({ expected_proposal_digest: AppDigestSchema }).parse(await body(c));
    const { actor, options } = await authority(c);
    return c.json(await revokeNativeBinding(actor, z.uuid().parse(c.req.param('bindingId')), raw.expected_proposal_digest, options));
  } catch (error) { return failure(c, error); }
});

appNativeRoutes.post('/bindings/:bindingId/invoke', async c => {
  try {
    const raw = z.strictObject({ expected_consent_digest: AppDigestSchema,
      idempotency_key: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/), input: z.unknown() }).parse(await body(c));
    const { actor, options } = await authority(c);
    return c.json(await (await getAppRunRuntime()).service.submitReviewedNative({ org_id: actor.org_id, user_id: actor.actor_id },
      { native_binding_id: z.uuid().parse(c.req.param('bindingId')), ...raw }, options.guard));
  } catch (error) { return failure(c, error); }
});
appNativeRoutes.get('/runs/:runId/review', async c => {
  try {
    if (new URL(c.req.url).search) throw new SyntaxError();
    const { actor, options } = await authority(c);
    return c.json(await (await getAppRunRuntime()).service.reviewNativeInput({ org_id: actor.org_id, user_id: actor.actor_id },
      z.uuid().parse(c.req.param('runId')), options.guard));
  } catch (error) { return failure(c, error); }
});
