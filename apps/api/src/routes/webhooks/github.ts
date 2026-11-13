/**
 * Task 8.7 — GitHub webhook route.
 *
 * Receives GitHub webhook POSTs signed with the deployment-wide
 * `GITHUB_WEBHOOK_SECRET`. Trigger jobs are dispatched per workspace, and
 * a delivery signed with that one secret does not identify a workspace
 * (no repository-to-workspace mapping exists), so merged-PR deliveries are
 * acknowledged with 200 and not dispatched. Merged PRs reach workspaces
 * through the per-workspace GitHub sync (`workers/github-sync.ts`), which
 * the `github-sync-scan` scheduled job runs for every eligible connection
 * every `DEFT_GITHUB_SYNC_INTERVAL_MIN` minutes (default 10), and which a
 * member can also run by hand.
 *
 * The route requires `GITHUB_WEBHOOK_SECRET`. Without it the endpoint is
 * disabled and answers every request with 503. With it, each request must
 * carry a matching `x-hub-signature-256` HMAC-SHA256 signature.
 */
import { Hono } from 'hono';
import crypto from 'node:crypto';

export const githubWebhookRoutes = new Hono();

if (!process.env.GITHUB_WEBHOOK_SECRET) {
  console.warn('[webhooks] GITHUB_WEBHOOK_SECRET is not set; the GitHub webhook endpoint is disabled.');
}

function verifySignature(body: string, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader) return false;
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signatureHeader),
      Buffer.from(expected),
    );
  } catch {
    return false;
  }
}

githubWebhookRoutes.post('/github', async (c) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return c.json({ error: 'GitHub webhook is not configured', code: 'GITHUB_WEBHOOK_NOT_CONFIGURED' }, 503);
  }
  const rawBody = await c.req.text();
  const signature = c.req.header('x-hub-signature-256');
  if (!verifySignature(rawBody, signature, secret)) {
    return c.json({ error: 'signature mismatch', code: 'UNAUTHORIZED' }, 401);
  }

  const event = c.req.header('x-github-event');
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'invalid json', code: 'VALIDATION_ERROR' }, 400);
  }

  // Only the `pull_request` event with action=closed + merged=true matters
  // for the v1 trigger set. Other events are acked so GitHub stops retrying.
  if (event !== 'pull_request') {
    return c.json({ ok: true, skipped: 'event' });
  }
  if (payload?.action !== 'closed' || !payload?.pull_request?.merged) {
    return c.json({ ok: true, skipped: 'not-merged' });
  }

  // Not attributable to a workspace: acknowledge so GitHub does not retry,
  // and dispatch nothing.
  console.info('[webhooks] GitHub merged-PR delivery acknowledged; not attributable to a workspace');
  return c.json({ ok: true, skipped: 'unattributed' });
});
