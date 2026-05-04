/**
 * Block 3.3 — webhook-callable agents.
 *
 * Surface A (authenticated, inside the app):
 *   POST   /api/agent-webhooks        — create a webhook for an employee
 *   GET    /api/agent-webhooks?employee_id=… — list
 *   DELETE /api/agent-webhooks/:id    — revoke
 *
 * Surface B (public, no auth, HMAC-gated):
 *   POST   /api/agent-webhooks/:slug  — external trigger. Enqueues an
 *     employee-trigger with trigger_kind='webhook' so the agent's
 *     existing trigger playbook runs over the payload.
 *
 * The slug in surface B is a short opaque id (nanoid-ish, not the
 * employee slug) so knowing the employee name doesn't help an attacker
 * guess the URL. Authentication is `Authorization: Bearer <secret>` OR
 * `X-Deft-Webhook-Secret: <secret>`; the secret is issued ONCE at
 * creation time and stored as an scrypt hash.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import crypto from 'node:crypto';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { agentWebhooks, agentEmployees } from '@deft/db/schema';
import { enqueue, QUEUE_NAMES } from '../lib/queues.js';
import { encrypt, decrypt } from '../lib/encryption.js';

export const agentWebhookRoutes = new Hono();

function randomSlug(bytes = 16): string {
  return crypto.randomBytes(bytes).toString('base64url');
}
function randomSecret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}
function randomHmacKey(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}
function hashSecret(secret: string): string {
  // scrypt is constant-time-verifiable + expensive enough to blunt
  // brute force, and matches lib/encryption.ts's primitive.
  const salt = 'deft-webhook-salt';
  return crypto.scryptSync(secret, salt, 32).toString('hex');
}
function verifySecret(secret: string, hash: string): boolean {
  const computed = hashSecret(secret);
  try {
    return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}

// ─── Authenticated surface ─────────────────────────────────────────────
const createSchema = z.object({
  agent_employee_id: z.string().min(1),
  label: z.string().max(200).optional(),
});

agentWebhookRoutes.post('/', async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
    }

    const [emp] = await db
      .select({ id: agentEmployees.id })
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, parsed.data.agent_employee_id), eq(agentEmployees.org_id, user.org_id)))
      .limit(1);
    if (!emp) return c.json({ error: 'Agent employee not found', code: 'NOT_FOUND' }, 404);

    const slug = randomSlug();
    const secret = randomSecret();
    const hmacKey = randomHmacKey();
    const id = crypto.randomUUID();

    const [inserted] = await db
      .insert(agentWebhooks)
      .values({
        id,
        org_id: user.org_id,
        agent_employee_id: emp.id,
        slug,
        secret_hash: hashSecret(secret),
        hmac_key_encrypted: encrypt(hmacKey),
        label: parsed.data.label ?? null,
        enabled: true,
        created_by: user.id,
      })
      .returning();

    return c.json({
      webhook: {
        id: inserted!.id,
        agent_employee_id: inserted!.agent_employee_id,
        slug: inserted!.slug,
        label: inserted!.label,
        enabled: inserted!.enabled,
        created_at: inserted!.created_at,
      },
      // Both shown ONCE. Caller must save them immediately; subsequent
      // GETs only return the slug.
      // `secret` is the legacy raw-secret auth (deprecated, ships in
      // every request — vulnerable to TLS-terminating-proxy log lift).
      // `hmac_key` is the preferred path: HMAC-SHA256 over the raw body,
      // sent as `x-deft-webhook-signature: sha256=<hex>`.
      secret,
      hmac_key: hmacKey,
      auth_instructions:
        'Sign request body with HMAC-SHA256 using hmac_key as the key. ' +
        'Send signature as `x-deft-webhook-signature: sha256=<hex>`. ' +
        'The legacy `x-deft-webhook-secret` header still works during transition.',
      post_url: `/api/agent-webhooks/${slug}`,
    }, 201);
  } catch (err) {
    console.error('Failed to create agent webhook:', err);
    return c.json({ error: 'Failed to create', code: 'INTERNAL_ERROR' }, 500);
  }
});

agentWebhookRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');
    const employeeId = c.req.query('employee_id');
    const rows = await db
      .select({
        id: agentWebhooks.id,
        agent_employee_id: agentWebhooks.agent_employee_id,
        slug: agentWebhooks.slug,
        label: agentWebhooks.label,
        enabled: agentWebhooks.enabled,
        last_fired_at: agentWebhooks.last_fired_at,
        fire_count: agentWebhooks.fire_count,
        created_at: agentWebhooks.created_at,
      })
      .from(agentWebhooks)
      .where(
        employeeId
          ? and(eq(agentWebhooks.org_id, user.org_id), eq(agentWebhooks.agent_employee_id, employeeId))
          : eq(agentWebhooks.org_id, user.org_id),
      )
      .orderBy(desc(agentWebhooks.created_at));
    return c.json({ webhooks: rows });
  } catch (err) {
    console.error('Failed to list agent webhooks:', err);
    return c.json({ error: 'Failed', code: 'INTERNAL_ERROR' }, 500);
  }
});

agentWebhookRoutes.delete('/:id', async (c) => {
  try {
    const user = c.get('user');
    const id = c.req.param('id');
    const res = await db
      .delete(agentWebhooks)
      .where(and(eq(agentWebhooks.id, id), eq(agentWebhooks.org_id, user.org_id)))
      .returning({ id: agentWebhooks.id });
    if (res.length === 0) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
    return c.json({ revoked: true });
  } catch (err) {
    console.error('Failed to revoke webhook:', err);
    return c.json({ error: 'Failed', code: 'INTERNAL_ERROR' }, 500);
  }
});

// ─── Public surface — HMAC-gated, no auth middleware needed ────────────
// Mounted OUTSIDE the auth middleware in index.ts so external systems
// can POST without a Deft user session.
export const publicAgentWebhookRoutes = new Hono();

publicAgentWebhookRoutes.post('/:slug', async (c) => {
  try {
    const slug = c.req.param('slug');

    // Read body as raw bytes BEFORE parsing — HMAC must compute over the
    // exact bytes the client signed.
    const rawBody = await c.req.text();

    const sigHeader = (c.req.header('x-deft-webhook-signature') ?? '').trim();
    const legacySecret = (c.req.header('x-deft-webhook-secret')
      ?? c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
      ?? '').trim();

    if (!sigHeader && !legacySecret) {
      return c.json({ error: 'Missing webhook authentication', code: 'UNAUTHORIZED' }, 401);
    }

    const [hook] = await db
      .select()
      .from(agentWebhooks)
      .where(eq(agentWebhooks.slug, slug))
      .limit(1);
    if (!hook) return c.json({ error: 'Webhook not found', code: 'NOT_FOUND' }, 404);
    if (!hook.enabled) return c.json({ error: 'Webhook disabled', code: 'DISABLED' }, 410);

    // Prefer HMAC; fall back to legacy raw-secret with a deprecation log
    // so operators can spot pre-rotation traffic. NEVER fail closed on
    // legacy alone — old webhooks (NULL hmac_key_encrypted) still need
    // it during the transition window.
    let authed = false;
    let authMethod: 'hmac' | 'legacy' | null = null;

    if (sigHeader && hook.hmac_key_encrypted) {
      try {
        const hmacKey = decrypt(hook.hmac_key_encrypted);
        const expectedHex = sigHeader.startsWith('sha256=')
          ? sigHeader.slice(7)
          : sigHeader;
        const computedHex = crypto
          .createHmac('sha256', hmacKey)
          .update(rawBody)
          .digest('hex');
        const expected = Buffer.from(expectedHex, 'hex');
        const computed = Buffer.from(computedHex, 'hex');
        if (
          expected.length > 0 &&
          expected.length === computed.length &&
          crypto.timingSafeEqual(expected, computed)
        ) {
          authed = true;
          authMethod = 'hmac';
        }
      } catch (err) {
        console.error('[agent-webhook] HMAC verify failed:', err);
      }
    }

    if (!authed && legacySecret) {
      if (verifySecret(legacySecret, hook.secret_hash)) {
        authed = true;
        authMethod = 'legacy';
        console.warn(
          `[agent-webhook] DEPRECATED auth: webhook ${slug} authenticated via x-deft-webhook-secret. ` +
            'Migrate to x-deft-webhook-signature with HMAC-SHA256 using the per-webhook hmac_key.',
        );
      }
    }

    if (!authed) {
      return c.json({ error: 'Invalid webhook authentication', code: 'UNAUTHORIZED' }, 401);
    }

    const payload = rawBody
      ? (() => {
          try {
            return JSON.parse(rawBody);
          } catch {
            return {};
          }
        })()
      : {};

    await enqueue(QUEUE_NAMES.AGENT_JOBS, 'employee-trigger', {
      employee_id: hook.agent_employee_id,
      trigger_kind: 'webhook',
      context: {
        webhook_slug: slug,
        webhook_label: hook.label,
        payload,
      },
      goal: `An external webhook "${hook.label ?? slug}" just fired. Process the payload using your webhook playbook.`,
    });

    await db
      .update(agentWebhooks)
      .set({
        last_fired_at: new Date(),
        fire_count: hook.fire_count + 1,
      })
      .where(eq(agentWebhooks.id, hook.id));

    return c.json({ accepted: true, webhook_id: hook.id, auth_method: authMethod });
  } catch (err) {
    console.error('Failed to dispatch webhook:', err);
    return c.json({ error: 'Failed', code: 'INTERNAL_ERROR' }, 500);
  }
});
