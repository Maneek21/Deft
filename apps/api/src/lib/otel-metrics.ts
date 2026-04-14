/**
 * Phase 10 — Prometheus text format helpers + metrics collector.
 *
 * We do NOT keep in-memory counter state. Every scrape re-derives the
 * metrics from the DB so scraper failures and restarts are invisible.
 * The cost is a handful of aggregate queries per scrape — negligible at
 * Deft's scale and cacheable later if needed.
 *
 * Format: Prometheus text exposition 0.0.4. See
 *   https://prometheus.io/docs/instrumenting/exposition_formats/
 *
 * Metrics exposed today:
 *   - deft_employee_chat_turn_total      (counter)
 *   - deft_employee_chat_latency_ms      (histogram)
 *   - deft_employee_tokens_in_total      (counter)
 *   - deft_employee_tokens_out_total     (counter)
 *   - deft_approval_queue_size           (gauge)
 *   - deft_mcp_tool_calls_total          (counter; stub — no log table yet)
 */
import { sql } from 'drizzle-orm';

// ─── Escaping ────────────────────────────────────────────────────────────

function escapeLabelValue(v: string): string {
  // Per 0.0.4 spec, label values escape \\, \n, and ".
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatLabels(labels: Record<string, string | number>): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return '';
  const pairs = keys.map((k) => `${k}="${escapeLabelValue(String(labels[k]))}"`);
  return `{${pairs.join(',')}}`;
}

// ─── Line emitters ────────────────────────────────────────────────────────

export function formatCounter(
  name: string,
  help: string,
  labels: Record<string, string | number>,
  value: number,
): string {
  return (
    `# HELP ${name} ${help}\n` +
    `# TYPE ${name} counter\n` +
    `${name}${formatLabels(labels)} ${value}\n`
  );
}

export function formatGauge(
  name: string,
  help: string,
  labels: Record<string, string | number>,
  value: number,
): string {
  return (
    `# HELP ${name} ${help}\n` +
    `# TYPE ${name} gauge\n` +
    `${name}${formatLabels(labels)} ${value}\n`
  );
}

export type HistogramBucket = { le: number; count: number };

export function formatHistogram(
  name: string,
  help: string,
  labels: Record<string, string | number>,
  buckets: HistogramBucket[],
  sum: number,
  count: number,
): string {
  const header = `# HELP ${name} ${help}\n# TYPE ${name} histogram\n`;
  const sorted = [...buckets].sort((a, b) => a.le - b.le);
  const lines: string[] = [];
  for (const b of sorted) {
    const leLabel = Number.isFinite(b.le) ? String(b.le) : '+Inf';
    const bucketLabels = formatLabels({ ...labels, le: leLabel });
    lines.push(`${name}_bucket${bucketLabels} ${b.count}`);
  }
  lines.push(`${name}_sum${formatLabels(labels)} ${sum}`);
  lines.push(`${name}_count${formatLabels(labels)} ${count}`);
  return header + lines.join('\n') + '\n';
}

// ─── Multi-line formatters (one metric, many label permutations) ─────────

function formatMultiCounter(
  name: string,
  help: string,
  rows: Array<{ labels: Record<string, string | number>; value: number }>,
): string {
  let out = `# HELP ${name} ${help}\n# TYPE ${name} counter\n`;
  for (const r of rows) {
    out += `${name}${formatLabels(r.labels)} ${r.value}\n`;
  }
  return out;
}

function formatMultiGauge(
  name: string,
  help: string,
  rows: Array<{ labels: Record<string, string | number>; value: number }>,
): string {
  let out = `# HELP ${name} ${help}\n# TYPE ${name} gauge\n`;
  for (const r of rows) {
    out += `${name}${formatLabels(r.labels)} ${r.value}\n`;
  }
  return out;
}

function formatMultiHistogram(
  name: string,
  help: string,
  series: Array<{
    labels: Record<string, string | number>;
    buckets: HistogramBucket[];
    sum: number;
    count: number;
  }>,
): string {
  let out = `# HELP ${name} ${help}\n# TYPE ${name} histogram\n`;
  for (const s of series) {
    const sorted = [...s.buckets].sort((a, b) => a.le - b.le);
    for (const b of sorted) {
      const leLabel = Number.isFinite(b.le) ? String(b.le) : '+Inf';
      out += `${name}_bucket${formatLabels({ ...s.labels, le: leLabel })} ${b.count}\n`;
    }
    out += `${name}_sum${formatLabels(s.labels)} ${s.sum}\n`;
    out += `${name}_count${formatLabels(s.labels)} ${s.count}\n`;
  }
  return out;
}

// ─── Main collector ──────────────────────────────────────────────────────

const LATENCY_BUCKETS_MS = [500, 1000, 2000, 5000, 10000, 30000, 60000];

type DbLike = {
  execute: (query: any) => Promise<any>;
};

export async function collectMetrics(db: DbLike): Promise<string> {
  const parts: string[] = [];

  // ─── deft_employee_chat_turn_total (counter) ──
  const turnCountsRes = await db.execute(sql`
    SELECT
      e.slug AS employee_slug,
      e.org_id AS org_id,
      t.trigger_kind,
      t.result,
      COUNT(*)::int AS cnt
    FROM agent_session_turns t
    JOIN agent_employees e ON e.id = t.employee_id
    GROUP BY e.slug, e.org_id, t.trigger_kind, t.result
    ORDER BY e.slug, t.trigger_kind, t.result
  `);
  const turnCountRows = ((turnCountsRes as any).rows ?? turnCountsRes) as any[];
  parts.push(
    formatMultiCounter(
      'deft_employee_chat_turn_total',
      'Total chat turns dispatched to employees',
      turnCountRows.map((r) => ({
        labels: {
          employee_slug: r.employee_slug ?? 'unknown',
          org_id: r.org_id ?? 'unknown',
          trigger_kind: r.trigger_kind ?? 'unknown',
          result: r.result ?? 'unknown',
        },
        value: Number(r.cnt),
      })),
    ),
  );

  // ─── deft_employee_chat_latency_ms (histogram) ──
  // Per employee. We issue a single query computing cumulative counts for
  // each bucket, then fold into the histogram shape.
  const bucketExprs = LATENCY_BUCKETS_MS.map(
    (b) => sql`COUNT(*) FILTER (WHERE latency_ms <= ${b})::int AS "b_${sql.raw(String(b))}"`,
  );
  const latencyRes = await db.execute(sql`
    SELECT
      e.slug AS employee_slug,
      ${sql.join(bucketExprs, sql`, `)},
      COUNT(*)::int AS cnt,
      COALESCE(SUM(latency_ms), 0)::bigint AS total_latency
    FROM agent_session_turns t
    JOIN agent_employees e ON e.id = t.employee_id
    GROUP BY e.slug
    ORDER BY e.slug
  `);
  const latencyRows = ((latencyRes as any).rows ?? latencyRes) as any[];
  parts.push(
    formatMultiHistogram(
      'deft_employee_chat_latency_ms',
      'Chat turn latency in ms, per employee',
      latencyRows.map((r) => {
        const buckets: HistogramBucket[] = LATENCY_BUCKETS_MS.map((b) => ({
          le: b,
          count: Number(r[`b_${b}`] ?? 0),
        }));
        buckets.push({ le: Infinity, count: Number(r.cnt) });
        return {
          labels: { employee_slug: r.employee_slug ?? 'unknown' },
          buckets,
          sum: Number(r.total_latency ?? 0),
          count: Number(r.cnt),
        };
      }),
    ),
  );

  // ─── deft_employee_tokens_in_total / tokens_out_total (counter) ──
  const tokensRes = await db.execute(sql`
    SELECT
      e.slug AS employee_slug,
      COALESCE(SUM(t.tokens_in), 0)::bigint AS tin,
      COALESCE(SUM(t.tokens_out), 0)::bigint AS tout
    FROM agent_session_turns t
    JOIN agent_employees e ON e.id = t.employee_id
    GROUP BY e.slug
  `);
  const tokenRows = ((tokensRes as any).rows ?? tokensRes) as any[];
  parts.push(
    formatMultiCounter(
      'deft_employee_tokens_in_total',
      'Total input tokens consumed by an employee',
      tokenRows.map((r) => ({
        labels: { employee_slug: r.employee_slug ?? 'unknown' },
        value: Number(r.tin ?? 0),
      })),
    ),
  );
  parts.push(
    formatMultiCounter(
      'deft_employee_tokens_out_total',
      'Total output tokens produced by an employee',
      tokenRows.map((r) => ({
        labels: { employee_slug: r.employee_slug ?? 'unknown' },
        value: Number(r.tout ?? 0),
      })),
    ),
  );

  // ─── deft_approval_queue_size (gauge) ──
  const queueRes = await db.execute(sql`
    SELECT org_id, COUNT(*)::int AS cnt
    FROM agent_actions
    WHERE approval_status = 'pending'
    GROUP BY org_id
  `);
  const queueRows = ((queueRes as any).rows ?? queueRes) as any[];
  parts.push(
    formatMultiGauge(
      'deft_approval_queue_size',
      'Pending approval queue size per org',
      queueRows.map((r) => ({
        labels: { org_id: r.org_id ?? 'unknown' },
        value: Number(r.cnt ?? 0),
      })),
    ),
  );

  // ─── deft_mcp_tool_calls_total (counter — stub) ──
  //
  // We do not yet have a dedicated `mcp_tool_calls` log table. The closest
  // signal we have is `agent_actions.source = 'mcp'`, which approximates a
  // tool call after it was approved/executed. We use that as a best-effort
  // proxy so the metric is non-zero for orgs that are actively using MCP
  // tools. A proper tool-call event log is tracked as a Phase 10 follow-up.
  const mcpRes = await db.execute(sql`
    SELECT
      COALESCE(e.slug, 'unknown') AS employee_slug,
      a.org_id,
      a.action AS tool,
      a.approval_status AS result,
      COUNT(*)::int AS cnt
    FROM agent_actions a
    LEFT JOIN agent_employees e ON e.id = a.agent_employee_id
    WHERE a.source = 'mcp'
    GROUP BY e.slug, a.org_id, a.action, a.approval_status
  `);
  const mcpRows = ((mcpRes as any).rows ?? mcpRes) as any[];
  parts.push(
    formatMultiCounter(
      'deft_mcp_tool_calls_total',
      'Total MCP tool calls per tool / org / employee / result (derived from agent_actions.source=mcp)',
      mcpRows.length > 0
        ? mcpRows.map((r) => ({
            labels: {
              tool: r.tool ?? 'unknown',
              employee_slug: r.employee_slug ?? 'unknown',
              org_id: r.org_id ?? 'unknown',
              result: r.result ?? 'unknown',
            },
            value: Number(r.cnt),
          }))
        : // Always emit at least the HELP/TYPE header so scrapers see the series.
          [{ labels: { tool: 'none', employee_slug: 'none', org_id: 'none', result: 'none' }, value: 0 }],
    ),
  );

  return parts.join('');
}
