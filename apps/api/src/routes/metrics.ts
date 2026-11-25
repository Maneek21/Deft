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
import { Hono, type Context } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { db } from '../lib/db.js';
import { collectMetrics } from '../lib/otel-metrics.js';
import { errorTelemetryCounters } from '../lib/telemetry/error-reporter.js';
import { installPingCounters } from '../lib/telemetry/install-ping.js';
import { heartbeatCounters } from '../lib/telemetry/heartbeat.js';

/** Telemetry's local counters (lib/telemetry): what was sent and what was dropped. Numbers only. */
export function telemetryMetricsText(): string {
  const errors = errorTelemetryCounters();
  const ping = installPingCounters();
  const heartbeat = heartbeatCounters();
  const lines = [
    '# HELP deft_telemetry_error_events_total Hosted error events, by outcome.',
    '# TYPE deft_telemetry_error_events_total counter',
    `deft_telemetry_error_events_total{outcome="captured"} ${errors.captured}`,
    `deft_telemetry_error_events_total{outcome="sent"} ${errors.events_sent}`,
    `deft_telemetry_error_events_total{outcome="dropped"} ${errors.events_dropped + errors.dropped_buffer_full}`,
    '# HELP deft_telemetry_error_batches_total Hosted error batches, by outcome.',
    '# TYPE deft_telemetry_error_batches_total counter',
    `deft_telemetry_error_batches_total{outcome="sent"} ${errors.batches_sent}`,
    `deft_telemetry_error_batches_total{outcome="failed"} ${errors.batches_failed}`,
    '# HELP deft_telemetry_install_pings_total Self-hosted install pings, by outcome.',
    '# TYPE deft_telemetry_install_pings_total counter',
    `deft_telemetry_install_pings_total{outcome="sent"} ${ping.sent}`,
    `deft_telemetry_install_pings_total{outcome="failed"} ${ping.failed}`,
    '# HELP deft_telemetry_heartbeats_total Hosted cell heartbeats, by outcome.',
    '# TYPE deft_telemetry_heartbeats_total counter',
    `deft_telemetry_heartbeats_total{outcome="sent"} ${heartbeat.sent}`,
    `deft_telemetry_heartbeats_total{outcome="failed"} ${heartbeat.failed}`,
  ];
  return `${lines.join('\n')}\n`;
}

export const metricsRoutes = new Hono();

/** Authenticate machine-facing operational telemetry with one static bearer. */
export function requireMetricsBearer(c: Context): Response | null {
  const expected = process.env.METRICS_SCRAPE_TOKEN;
  if (!expected) {
    // Fail closed — no token configured means scraping is disabled.
    return c.json(
      {
        error:
          'METRICS_SCRAPE_TOKEN is not configured — set it in .env to enable operator telemetry',
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
  return null;
}

metricsRoutes.get('/', async (c) => {
  const authError = requireMetricsBearer(c);
  if (authError) return authError;

  try {
    const body = `${await collectMetrics(db as any)}${telemetryMetricsText()}`;
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; version=0.0.4' },
    });
  } catch (err) {
    console.error('[metrics] collectMetrics failed:');
    return c.json({ error: 'Failed to collect metrics', code: 'INTERNAL_ERROR' }, 500);
  }
});
