/**
 * Task 8.7 — GitHub webhook route.
 *
 * Phase 8's trigger dispatcher binds `webhook:github-pr-merged` to the
 * skill triggers that claim it. This route receives the GitHub webhook
 * POST, filters for PR-merged events, and enqueues a `trigger-dispatch`
 * job with the trigger kind + payload context. The `trigger-dispatch`
 * handler then fans out to every subscribed employee.
 *
 * The route requires `GITHUB_WEBHOOK_SECRET`. Without it the endpoint is
 * disabled and answers every request with 503. With it, each request must
 * carry a matching `x-hub-signature-256` HMAC-SHA256 signature.
 */
import { Hono } from 'hono';
import crypto from 'node:crypto';
import { enqueue, QUEUE_NAMES } from '../../lib/queues.js';

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

  const pr = payload.pull_request;
  await enqueue(QUEUE_NAMES.SCHEDULED_JOBS, 'trigger-dispatch', {
    trigger_kind: 'webhook:github-pr-merged',
    context: {
      pr_number: pr.number,
      pr_title: pr.title,
      pr_url: pr.html_url,
      pr_author: pr.user?.login,
      merged_by: pr.merged_by?.login,
      repo: payload.repository?.full_name,
    },
    goal: `A pull request was merged (${payload.repository?.full_name}#${pr.number}): "${pr.title}". Review whether any open tasks should be updated, closed, or kicked off because of this.`,
  });

  return c.json({ ok: true, dispatched: 'webhook:github-pr-merged' });
});
