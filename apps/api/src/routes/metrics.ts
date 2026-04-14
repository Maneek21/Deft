/**
 * Phase 10 — Prometheus metrics export.
 *
 *   GET /api/metrics
 *
 * Auth: a static bearer token matching `env.METRICS_SCRAPE_TOKEN`. The user
 * sets this env var and points their Prometheus / ClawMetry / Grafana
 * scraper at it. We intentionally do NOT put this behind the normal user
 * JWT — scrapers are machines.
 *
 * Returns: Prometheus text format 0.0.4, `text/plain; version=0.0.4`.
 */
import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { db } from '../lib/db.js';
import { collectMetrics } from '../lib/otel-metrics.js';

export const metricsRoutes = new Hono();

metricsRoutes.get('/', async (c) => {
  const expected = process.env.METRICS_SCRAPE_TOKEN;
  if (!expected) {
    // Fail closed — no token configured means scraping is disabled.
    return c.json(
      {
        error:
          'METRICS_SCRAPE_TOKEN is not configured — set it in .env to enable /api/metrics',
        code: 'METRICS_DISABLED',
      },
      503,
    );
  }

  const authHeader = c.req.header('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized', code: 'NO_TOKEN' }, 401);
  }
  const token = authHeader.slice(7);
  // Phase 12 review fix — constant-time compare. Length-mismatched buffers
  // throw inside timingSafeEqual, so gate on length first.
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return c.json({ error: 'Unauthorized', code: 'BAD_TOKEN' }, 401);
  }

  try {
    const body = await collectMetrics(db as any);
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; version=0.0.4' },
    });
  } catch (err) {
    console.error('[metrics] collectMetrics failed:', err);
    return c.json({ error: 'Failed to collect metrics', code: 'INTERNAL_ERROR' }, 500);
  }
});
