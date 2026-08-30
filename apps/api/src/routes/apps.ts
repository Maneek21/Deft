import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { APP_LIMITS, AppDigestSchema } from '@deft/app-kit';
import type { AuthUser } from '../middleware/auth.js';
import { humanModuleActor } from '../lib/module-service.js';
import {
  activateAppInstallation,
  disableAppInstallation,
  getAppInstallation,
  inspectAppPackageJson,
  listActiveAppNavigation,
  listAppInstallations,
  stageAppPackage,
} from '../lib/app-service.js';
import { isAppError } from '../lib/app-errors.js';
import { createAppDeveloperPairing, revokeAppDeveloperPairing } from '../lib/app-developer-pairing.js';

export const appRoutes = new Hono();

const IdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const activateSchema = z.strictObject({ expected_package_digest: AppDigestSchema });
const disableSchema = z.strictObject({ expected_lifecycle_epoch: z.number().int().nonnegative() });

function actorFromContext(c: Context) {
  const user = c.get('user') as AuthUser;
  return humanModuleActor({
    orgId: user.org_id,
    userId: user.id,
    role: user.role ?? 'member',
    source: 'rest',
  });
}

function managerFromContext(c: Context) {
  const actor = actorFromContext(c);
  if (actor.kind !== 'human' || (actor.role !== 'owner' && actor.role !== 'admin')) {
    throw new Error('APP_MANAGER_REQUIRED');
  }
  return actor;
}

async function boundedPackageBody(c: Context): Promise<string> {
  const declared = Number(c.req.header('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > APP_LIMITS.package_bytes) {
    throw Object.assign(new Error('App package is too large'), { appPayloadTooLarge: true });
  }
  const body = await c.req.text();
  if (new TextEncoder().encode(body).byteLength > APP_LIMITS.package_bytes) {
    throw Object.assign(new Error('App package is too large'), { appPayloadTooLarge: true });
  }
  return body;
}

function failure(c: Context, error: unknown) {
  if (isAppError(error)) {
    return c.json({ error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) }, error.status);
  }
  if (error instanceof z.ZodError) {
    return c.json({
      error: 'Invalid App request',
      code: 'VALIDATION_ERROR',
      details: { issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
    }, 400);
  }
  if (error instanceof Error && error.message === 'APP_MANAGER_REQUIRED') {
    return c.json({ error: 'Only workspace owners and admins can manage Apps', code: 'APP_ACCESS_DENIED' }, 403);
  }
  if (error && typeof error === 'object' && 'appPayloadTooLarge' in error) {
    return c.json({ error: 'App package is too large', code: 'APP_INVALID_PACKAGE' }, 413);
  }
  console.error('[apps] request failed:', error);
  return c.json({ error: 'App request failed', code: 'INTERNAL_ERROR' }, 500);
}

appRoutes.post('/inspect', async (c) => {
  try {
    managerFromContext(c);
    return c.json({ inspection: await inspectAppPackageJson(await boundedPackageBody(c)) });
  } catch (error) {
    return failure(c, error);
  }
});

appRoutes.post('/pairings', async (c) => {
  try {
    return c.json({ pairing: await createAppDeveloperPairing(managerFromContext(c)) }, 201);
  } catch (error) {
    return failure(c, error);
  }
});

appRoutes.post('/pairings/:pairingId/revoke', async (c) => {
  try {
    await revokeAppDeveloperPairing(managerFromContext(c), IdSchema.parse(c.req.param('pairingId')));
    return c.json({ revoked: true });
  } catch (error) {
    return failure(c, error);
  }
});

appRoutes.post('/stage', async (c) => {
  try {
    return c.json({ app: await stageAppPackage(managerFromContext(c), await boundedPackageBody(c)) }, 201);
  } catch (error) {
    return failure(c, error);
  }
});

appRoutes.get('/', async (c) => {
  try {
    return c.json({ apps: await listAppInstallations(actorFromContext(c)) });
  } catch (error) {
    return failure(c, error);
  }
});

appRoutes.get('/navigation', async (c) => {
  try {
    return c.json({ navigation: await listActiveAppNavigation(actorFromContext(c)) });
  } catch (error) {
    return failure(c, error);
  }
});

appRoutes.get('/:installationId', async (c) => {
  try {
    return c.json({ app: await getAppInstallation(actorFromContext(c), IdSchema.parse(c.req.param('installationId'))) });
  } catch (error) {
    return failure(c, error);
  }
});

appRoutes.post('/:installationId/activate', async (c) => {
  try {
    const body = activateSchema.parse(await c.req.json());
    return c.json({
      app: await activateAppInstallation(
        managerFromContext(c),
        IdSchema.parse(c.req.param('installationId')),
        body.expected_package_digest,
      ),
    });
  } catch (error) {
    return failure(c, error);
  }
});

appRoutes.post('/:installationId/disable', async (c) => {
  try {
    const body = disableSchema.parse(await c.req.json());
    return c.json({
      app: await disableAppInstallation(
        managerFromContext(c),
        IdSchema.parse(c.req.param('installationId')),
        body.expected_lifecycle_epoch,
      ),
    });
  } catch (error) {
    return failure(c, error);
  }
});
