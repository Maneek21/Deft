import { Hono } from 'hono';
import { z } from 'zod';
import { APP_LIMITS } from '@deft/app-kit';
import { activateAppInstallation, stageAppPackage } from '../lib/app-service.js';
import { claimAppDeveloperSession, exchangeAppDeveloperPairing } from '../lib/app-developer-pairing.js';
import { isAppError } from '../lib/app-errors.js';

export const appDeveloperRoutes = new Hono();
const exchangeSchema = z.strictObject({ code: z.string().min(1).max(64) });

function fail(c: any, error: unknown) {
  if (isAppError(error)) return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof z.ZodError) return c.json({ error: 'Invalid developer request', code: 'VALIDATION_ERROR' }, 400);
  console.error('[app-developer] request failed:', error);
  return c.json({ error: 'Developer request failed', code: 'INTERNAL_ERROR' }, 500);
}

appDeveloperRoutes.get('/status', (c) => c.json({ app_protocol: '0', audience: 'app-developer', single_use_install: true }));

appDeveloperRoutes.post('/pair/exchange', async (c) => {
  try {
    return c.json(await exchangeAppDeveloperPairing(exchangeSchema.parse(await c.req.json()).code));
  } catch (error) {
    return fail(c, error);
  }
});

appDeveloperRoutes.post('/install', async (c) => {
  try {
    const authorization = c.req.header('authorization') ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > APP_LIMITS.package_bytes) return c.json({ error: 'App package is too large', code: 'APP_INVALID_PACKAGE' }, 413);
    const packageJson = await c.req.text();
    if (new TextEncoder().encode(packageJson).byteLength > APP_LIMITS.package_bytes) {
      return c.json({ error: 'App package is too large', code: 'APP_INVALID_PACKAGE' }, 413);
    }
    const actor = await claimAppDeveloperSession(token);
    const staged = await stageAppPackage(actor, packageJson);
    const app = await activateAppInstallation(actor, staged.id, staged.package_digest);
    return c.json({ app }, 201);
  } catch (error) {
    return fail(c, error);
  }
});
