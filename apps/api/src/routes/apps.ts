import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { APP_LIMITS, AppDigestSchema } from '@deft/app-kit';
import type { AuthUser } from '../middleware/auth.js';
import { humanModuleActor } from '../lib/module-service.js';
import {
  activateAppInstallation,
  disableAppInstallation,
  enableAppInstallation,
  getAppInstallation,
  inspectAppPackageJson,
  listActiveAppNavigation,
  listAppInstallations,
  refuseAppUninstall,
  stageAppPackage,
  stageAppUpgrade,
} from '../lib/app-service.js';
import {
  activateConnectedAppInstallation,
  activateConnectedAppUpgrade,
  getConnectedAppGrantManagement,
  inspectConnectedAppHealth,
  prepareConnectedAppReview,
  prepareConnectedAppUpgradeReview,
} from '../lib/app-review-service.js';
import { resourceSyncWebAuthority, ResourceSyncWebAuthenticationError } from '../lib/app-resource-sync-web-authority.js';
import { isAppError } from '../lib/app-errors.js';
import { isModuleError } from '../lib/module-errors.js';
import { createAppDeveloperPairing, revokeAppDeveloperPairing } from '../lib/app-developer-pairing.js';
import { appOperationsService } from '../lib/app-operations-service.js';
import {
  AppAutomationCreateRequestSchema,
  AppAutomationReviewRequestSchema,
  createManagedAppAutomation,
  listManagedAppAutomations,
  pauseManagedAppAutomation,
  prepareManagedAppAutomationReview,
  projectManagedAppAutomationDefinition,
  resumeManagedAppAutomation,
} from '../lib/app-automation-management-service.js';
import { AppRunError } from '../lib/app-run-errors.js';
import { appHttpFailure } from './app-http-errors.js';
import { appNativeRoutes } from './app-native.js';

import { appAttachmentRoutes } from './app-attachments.js';
export const appRoutes = new Hono();
appRoutes.route('/blob',appAttachmentRoutes);
appRoutes.route('/native', appNativeRoutes);

const IdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const activateSchema = z.strictObject({ expected_package_digest: AppDigestSchema });
const disableSchema = z.strictObject({ expected_lifecycle_epoch: z.number().int().nonnegative() });
const connectorSelectionSchema = z.strictObject({
  connector_requirement_key: z.string().min(1).max(48).regex(/^[a-z][a-z0-9_]{0,47}$/),
  mcp_connection_id: IdSchema,
});
const connectedReviewSchema = z.strictObject({
  app_version_id: IdSchema,
  expected_package_digest: AppDigestSchema,
  expected_requested_snapshot_digest: AppDigestSchema,
  expected_lifecycle_epoch: z.number().int().nonnegative(),
  expected_grant_epoch: z.number().int().nonnegative(),
  connector_selections: z.array(connectorSelectionSchema).min(1).max(8),
});
const connectedActivationSchema = connectedReviewSchema.extend({
  expected_review_digest: AppDigestSchema,
  accept_host_policy: z.boolean(),
  accept_module_adoptions: z.boolean().optional(),
  allow_identical_carry_forward: z.boolean().optional(),
});
const connectedUpgradeReviewSchema = connectedReviewSchema.extend({
  schema_version: z.literal('deft.connected_app_upgrade_request.v1'),
  prior_app_version_id: IdSchema,
  pending_work_policy: z.literal('supersede_pending_work'),
});
const connectedUpgradeActivationSchema = connectedUpgradeReviewSchema.extend({
  expected_review_digest: AppDigestSchema,
  expected_upgrade_review_digest: AppDigestSchema,
  accept_host_policy: z.boolean(),
  accept_module_adoptions: z.boolean().optional(),
  allow_identical_carry_forward: z.boolean().optional(),
});
const healthSchema = z.strictObject({ refresh_provider_schemas: z.boolean().default(true) });
const automationTransitionSchema = z.strictObject({
  expected_definition_epoch: z.number().int().min(1),
});

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
  if (error instanceof ResourceSyncWebAuthenticationError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
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
  if (isModuleError(error) && error.code === 'MODULE_ACCESS_DENIED') {
    return c.json({
      error: 'Only active workspace owners and admins can manage Apps',
      code: 'APP_ACCESS_DENIED',
    }, 403);
  }
  if (error instanceof AppRunError) {
    if (error.code === 'APP_RUN_ACCESS_DENIED') {
      return c.json({
        error: 'Only active workspace owners and admins can inspect App operations',
        code: 'APP_ACCESS_DENIED',
      }, 403);
    }
    return appHttpFailure(c, error, 'App Run', 'app-runs');
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
    const packageJson = await boundedPackageBody(c);
    let native = false;
    try { native = (JSON.parse(packageJson) as { manifest?: { schema_version?: string } })?.manifest?.schema_version === '6'; } catch { /* The package parser owns invalid-package errors. */ }
    if (native) {
      const user = c.get('user') as AuthUser;
      if (!user.sid) throw new ResourceSyncWebAuthenticationError('Web authentication required');
      const { actor, guard } = await resourceSyncWebAuthority(c.req.header('authorization'), { org_id: user.org_id, user_id: user.id, sid: user.sid });
      return c.json({ app: await stageAppPackage(actor, packageJson, { guard }) }, 201);
    }
    return c.json({ app: await stageAppPackage(managerFromContext(c), packageJson) }, 201);
  } catch (error) {
    return failure(c, error);
  }
});

appRoutes.post('/:installationId/upgrades/stage', async (c) => {
  try {
    const expectedLifecycleEpoch = z.coerce.number().int().nonnegative().parse(
      c.req.query('expected_lifecycle_epoch'),
    );
    return c.json({
      app: await stageAppUpgrade(
        managerFromContext(c),
        IdSchema.parse(c.req.param('installationId')),
        await boundedPackageBody(c),
        expectedLifecycleEpoch,
      ),
    }, 201);
  } catch (error) {
    return failure(c, error);
  }
});

appRoutes.post('/:installationId/review', async (c) => {
  try {
    const body = connectedReviewSchema.parse(await c.req.json());
    return c.json({
      review: await prepareConnectedAppReview(
        managerFromContext(c),
        IdSchema.parse(c.req.param('installationId')),
        body,
      ),
    });
  } catch (error) {
    return failure(c, error);
  }
});

appRoutes.post('/:installationId/review/activate', async (c) => {
  try {
    const body = connectedActivationSchema.parse(await c.req.json());
    return c.json({
      review: await activateConnectedAppInstallation(
        managerFromContext(c),
        IdSchema.parse(c.req.param('installationId')),
        body,
      ),
    });
  } catch (error) {
    return failure(c, error);
  }
});

for (const operation of ['review', 'activate'] as const) {
  appRoutes.post(`/:installationId/upgrade/${operation}`, async c => {
    try {
      c.header('Cache-Control', 'no-store');
      if (new URL(c.req.url).search || !/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type') ?? '')) {
        return c.json({ error: 'Invalid connected upgrade request', code: 'VALIDATION_ERROR' }, 400);
      }
      const user = c.get('user') as AuthUser | undefined;
      if (!user?.sid) throw new ResourceSyncWebAuthenticationError('Web authentication required');
      const { actor, guard } = await resourceSyncWebAuthority(c.req.header('authorization'),
        { org_id: user.org_id, user_id: user.id, sid: user.sid });
      const id = IdSchema.parse(c.req.param('installationId'));
      const raw: unknown = await c.req.json();
      return c.json(operation === 'review'
        ? await prepareConnectedAppUpgradeReview(actor, id, connectedUpgradeReviewSchema.parse(raw), undefined, { guard })
        : await activateConnectedAppUpgrade(actor, id, connectedUpgradeActivationSchema.parse(raw), undefined, { guard }));
    } catch (error) {
      if (error instanceof SyntaxError) return c.json({ error: 'Invalid connected upgrade request', code: 'VALIDATION_ERROR' }, 400);
      return failure(c, error);
    }
  });
}

appRoutes.get('/:installationId/grants', async (c) => {
  try {
    return c.json({
      grants: await getConnectedAppGrantManagement(
        managerFromContext(c),
        IdSchema.parse(c.req.param('installationId')),
      ),
    });
  } catch (error) {
    return failure(c, error);
  }
});

appRoutes.post('/:installationId/health', async (c) => {
  try {
    const body = healthSchema.parse(await c.req.json());
    return c.json({
      health: await inspectConnectedAppHealth(
        managerFromContext(c),
        IdSchema.parse(c.req.param('installationId')),
        body,
      ),
    });
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

appRoutes.get('/operations', async (c) => {
  try {
    return c.json({ operations: await appOperationsService.read(managerFromContext(c)) });
  } catch (error) {
    return failure(c, error);
  }
});

appRoutes.get('/:installationId/automations', async (c) => {
  try {
    const cursor = c.req.query('cursor');
    const rawLimit = c.req.query('limit');
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) {
      return c.json({ error: 'Invalid App automation page limit', code: 'VALIDATION_ERROR' }, 400);
    }
    return c.json({
      automations: await listManagedAppAutomations(
        managerFromContext(c),
        IdSchema.parse(c.req.param('installationId')),
        { cursor, limit },
      ),
    });
  } catch (error) {
    return failure(c, error);
  }
});

appRoutes.post('/:installationId/automations/review', async (c) => {
  try {
    return c.json({
      review: await prepareManagedAppAutomationReview(
        managerFromContext(c),
        IdSchema.parse(c.req.param('installationId')),
        AppAutomationReviewRequestSchema.parse(await c.req.json()),
      ),
    });
  } catch (error) {
    return failure(c, error);
  }
});

appRoutes.post('/:installationId/automations', async (c) => {
  try {
    const created = await createManagedAppAutomation(
      managerFromContext(c),
      IdSchema.parse(c.req.param('installationId')),
      AppAutomationCreateRequestSchema.parse(await c.req.json()),
    );
    return c.json({ automation: projectManagedAppAutomationDefinition(created) }, 201);
  } catch (error) {
    return failure(c, error);
  }
});

appRoutes.post('/:installationId/automations/:definitionId/pause', async (c) => {
  try {
    const body = automationTransitionSchema.parse(await c.req.json());
    const updated = await pauseManagedAppAutomation(
      managerFromContext(c),
      IdSchema.parse(c.req.param('installationId')),
      IdSchema.parse(c.req.param('definitionId')),
      body.expected_definition_epoch,
    );
    return c.json({ automation: projectManagedAppAutomationDefinition(updated) });
  } catch (error) {
    return failure(c, error);
  }
});

appRoutes.post('/:installationId/automations/:definitionId/resume', async (c) => {
  try {
    const body = automationTransitionSchema.parse(await c.req.json());
    const updated = await resumeManagedAppAutomation(
      managerFromContext(c),
      IdSchema.parse(c.req.param('installationId')),
      IdSchema.parse(c.req.param('definitionId')),
      body.expected_definition_epoch,
    );
    return c.json({ automation: projectManagedAppAutomationDefinition(updated) });
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

appRoutes.post('/:installationId/enable', async (c) => {
  try {
    const body = disableSchema.parse(await c.req.json());
    return c.json({
      app: await enableAppInstallation(
        managerFromContext(c),
        IdSchema.parse(c.req.param('installationId')),
        body.expected_lifecycle_epoch,
      ),
    });
  } catch (error) {
    return failure(c, error);
  }
});

appRoutes.post('/:installationId/uninstall', async (c) => {
  try {
    const body = disableSchema.parse(await c.req.json().catch(() => undefined));
    await refuseAppUninstall(
      managerFromContext(c),
      IdSchema.parse(c.req.param('installationId')),
      body.expected_lifecycle_epoch,
    );
    return c.json({ error: 'App uninstall was not refused', code: 'INTERNAL_ERROR' }, 500);
  } catch (error) {
    return failure(c, error);
  }
});
