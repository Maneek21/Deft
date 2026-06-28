import fs from 'node:fs/promises';
import path from 'node:path';

const REPORT_DIR = path.resolve('reports');
const OUT = path.resolve(REPORT_DIR, `dense-human-workflow-certification-consolidated-${new Date().toISOString().slice(0, 10)}.html`);

type Run = {
  run_id: string;
  marker: string;
  started_at: string;
  checks: Array<{ status: string; name: string; detail?: unknown; ms?: number }>;
  screenshots: Record<string, string>;
  sent_messages: unknown[];
  evidence: Record<string, any>;
  findings: Array<{ severity: string; title: string; detail: string }>;
};

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function rel(file: string) {
  return path.relative(path.dirname(OUT), file).replace(/\\/g, '/');
}

async function loadRuns() {
  const files = await fs.readdir(REPORT_DIR);
  const runs: Run[] = [];
  for (const file of files.filter((name) => /^dense-human-workflow-certification-.*\.json$/.test(name))) {
    try {
      runs.push(JSON.parse(await fs.readFile(path.join(REPORT_DIR, file), 'utf8')) as Run);
    } catch {
      // Ignore malformed partials.
    }
  }
  return runs.sort((a, b) => a.started_at.localeCompare(b.started_at));
}

function screenshot(run: Run | undefined, key: string, caption: string) {
  const file = run?.screenshots?.[key];
  if (!file) return '';
  return `<figure><img src="${escapeHtml(rel(file))}" alt="${escapeHtml(caption)}"><figcaption>${escapeHtml(caption)}</figcaption></figure>`;
}

async function main() {
  const runs = await loadRuns();
  const denseRuns = runs.filter((run) => run.evidence?.metrics?.attempted_messages === 100);
  const latest = denseRuns.at(-1);
  const strongest = [...denseRuns].sort((a, b) => (b.evidence?.metrics?.intent_count ?? 0) - (a.evidence?.metrics?.intent_count ?? 0))[0];
  const receiptRun = [...denseRuns].find((run) => (run.evidence?.receipts ?? []).length > 0);
  const rows = denseRuns.slice(-4).map((run) => {
    const m = run.evidence?.metrics ?? {};
    return {
      marker: run.marker,
      sent: `${m.sent_messages ?? 0}/${m.attempted_messages ?? 0}`,
      intents: m.intent_count ?? 0,
      matched: `${m.matched_expected ?? 0}/${m.expected_capture_count ?? 0}`,
      falsePositives: m.false_positive_count ?? 0,
      receipts: (run.evidence?.receipts ?? []).filter((r: any) => r.ok).length,
      note: (run.evidence?.promoted_note ?? []).length,
      findings: run.findings.map((f) => `${f.severity}: ${f.title}`).join('; '),
    };
  });

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Dense Human Workflow Certification - Consolidated</title>
  <style>
    :root { color-scheme: light; --ink:#191714; --muted:#716a60; --line:#ddd5c8; --paper:#faf7ef; --card:#fffdf8; --green:#168a5b; --amber:#a86700; --red:#bf3b2f; }
    body { margin:0; background:var(--paper); color:var(--ink); font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height:1.45; }
    main { max-width:1160px; margin:0 auto; padding:42px 24px 72px; }
    h1 { margin:0 0 10px; font-size:36px; line-height:1.03; }
    h2 { margin:34px 0 12px; font-size:21px; }
    p { color:var(--muted); max-width:900px; }
    .hero,.card,table,figure,pre { border:1px solid var(--line); background:var(--card); border-radius:8px; }
    .hero { padding:28px; }
    .pill { display:inline-flex; padding:5px 10px; border:1px solid var(--line); border-radius:999px; background:#fff; color:var(--muted); font-size:12px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; }
    .card { padding:16px; }
    .metric { font-size:28px; font-weight:760; }
    table { width:100%; border-collapse:collapse; overflow:hidden; }
    th,td { text-align:left; vertical-align:top; padding:11px 12px; border-bottom:1px solid var(--line); font-size:13px; }
    th { background:#f3eee5; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
    tr:last-child td { border-bottom:0; }
    .pass { color:var(--green); font-weight:750; }
    .warn { color:var(--amber); font-weight:750; }
    .fail { color:var(--red); font-weight:750; }
    .screens { display:grid; grid-template-columns:repeat(auto-fit,minmax(310px,1fr)); gap:14px; }
    figure { margin:0; overflow:hidden; }
    figure img { width:100%; display:block; background:#111; }
    figcaption { padding:9px 11px; color:var(--muted); font-size:12px; border-top:1px solid var(--line); }
    pre { white-space:pre-wrap; overflow-wrap:anywhere; padding:14px; font-size:12px; color:#38312a; }
    code { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  </style>
</head>
<body>
<main>
  <section class="hero">
    <span class="pill">Consolidated dense dogfood</span>
    <h1>Dense Human Workflow Certification</h1>
    <p>These were local UI-first runs with five seeded employees acting concurrently across eight spaces. The main result: the human workspace held up under 100-message bursts, but the Defty observation/capture pipeline is not reliable enough yet under realistic chatter.</p>
    <div class="grid">
      <div class="card"><div class="metric">${escapeHtml(latest?.evidence?.metrics?.sent_messages ?? 0)}/100</div><span>Latest UI sends succeeded</span></div>
      <div class="card"><div class="metric">${escapeHtml(strongest?.evidence?.metrics?.intent_count ?? 0)}</div><span>Best run capture count</span></div>
      <div class="card"><div class="metric">${escapeHtml(receiptRun?.evidence?.receipts?.filter((r: any) => r.ok).length ?? 0)}</div><span>Verified receipts in approval run</span></div>
      <div class="card"><div class="metric">${escapeHtml(latest?.evidence?.promoted_note?.length ?? 0)}</div><span>Latest notes promoted to wiki</span></div>
    </div>
  </section>

  <h2>Run Comparison</h2>
  <table>
    <thead><tr><th>Run</th><th>UI Sends</th><th>Intents</th><th>Matched Expected</th><th>No-op Overcapture</th><th>Receipts</th><th>Note→Wiki</th><th>Findings</th></tr></thead>
    <tbody>
      ${rows.map((row) => `<tr><td><code>${escapeHtml(row.marker)}</code></td><td>${escapeHtml(row.sent)}</td><td>${escapeHtml(row.intents)}</td><td>${escapeHtml(row.matched)}</td><td>${escapeHtml(row.falsePositives)}</td><td>${escapeHtml(row.receipts)}</td><td>${escapeHtml(row.note)}</td><td>${escapeHtml(row.findings)}</td></tr>`).join('')}
    </tbody>
  </table>

  <h2>What This Proves</h2>
  <table>
    <thead><tr><th>Claim</th><th>Verdict</th><th>Evidence</th></tr></thead>
    <tbody>
      <tr><td>Humans can work concurrently in Deft</td><td class="pass">Validated locally</td><td>Latest dense run posted 100/100 messages from five browser sessions across eight spaces.</td></tr>
      <tr><td>Chat becomes context</td><td class="fail">Not reliable enough</td><td>Best dense run created 21 intents; latest comparable run created zero. The observation path drops or skips under dense realistic traffic.</td></tr>
      <tr><td>Tasks become action</td><td class="warn">Works when captured</td><td>The strongest run converted representative task captures and verified receipts, but capture recall is too low.</td></tr>
      <tr><td>Approvals become governance</td><td class="pass">Validated where actions exist</td><td>The approval run produced verified receipts for representative approved actions.</td></tr>
      <tr><td>Notes become memory</td><td class="pass">Validated</td><td>The latest run created a note through the UI, promoted it to wiki, and found the promoted page.</td></tr>
    </tbody>
  </table>

  <h2>Main Fix Themes</h2>
  <table>
    <thead><tr><th>Priority</th><th>Theme</th><th>Why</th></tr></thead>
    <tbody>
      <tr><td class="fail">P1</td><td>Move chat observation out of fire-and-forget route execution into durable jobs</td><td>Dense traffic can store messages while producing no work intents. Classification/capture needs durability, retries, and backlog visibility.</td></tr>
      <tr><td class="fail">P1</td><td>Add explicit no-action guardrails before memory capture</td><td>Best dense run captured 6/20 explicit no-action/no-memory messages.</td></tr>
      <tr><td class="fail">P1</td><td>Improve capture recall and evaluation thresholds</td><td>Best dense run matched only 14/80 expected non-noise captures.</td></tr>
      <tr><td class="warn">P2</td><td>Add admin/debug visibility for observation pipeline</td><td>When captures disappear, the UI currently does not expose whether classification skipped, failed, or backlogged.</td></tr>
    </tbody>
  </table>

  <h2>Screenshots</h2>
  <div class="screens">
    ${screenshot(latest, 'after-messages-diego', 'Diego after dense messages')}
    ${screenshot(latest, 'surface-captures-final', 'Final captures surface')}
    ${screenshot(latest, 'surface-dashboard-final', 'Final dashboard surface')}
    ${screenshot(latest, 'knowledge-after-dense-note', 'Knowledge after note promotion')}
    ${screenshot(strongest, 'captures-before-dense-approvals', 'Approval cards in strongest capture run')}
    ${screenshot(strongest, 'captures-after-dense-approvals', 'Approval cards after representative approvals')}
  </div>

  <h2>Raw Summary</h2>
  <pre>${escapeHtml(JSON.stringify({
    latest: latest ? { marker: latest.marker, metrics: latest.evidence.metrics, findings: latest.findings } : null,
    strongest: strongest ? { marker: strongest.marker, metrics: strongest.evidence.metrics, findings: strongest.findings } : null,
    receiptRun: receiptRun ? { marker: receiptRun.marker, receipts: receiptRun.evidence.receipts } : null,
  }, null, 2))}</pre>
</main>
</body>
</html>`;

  await fs.writeFile(OUT, html);
  console.log(`CONSOLIDATED_DENSE_REPORT=${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
