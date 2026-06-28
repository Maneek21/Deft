import fs from 'node:fs/promises';
import path from 'node:path';

const REPORT_DIR = path.resolve('reports');
const OUT = path.resolve(REPORT_DIR, `demo-process-certification-consolidated-${new Date().toISOString().slice(0, 10)}.html`);

type Run = {
  run_id: string;
  marker: string;
  started_at: string;
  finished_at?: string;
  checks: Array<{ status: 'pass' | 'warn' | 'fail'; name: string; detail?: unknown; ms?: number }>;
  screenshots: Record<string, string>;
  ids: Record<string, string>;
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

function hasCheck(run: Run, needle: string, status?: string) {
  return run.checks.some((check) => check.name.includes(needle) && (!status || check.status === status));
}

async function loadRuns(): Promise<Run[]> {
  const files = await fs.readdir(REPORT_DIR);
  const jsonFiles = files
    .filter((file) => /^demo-claim-certification-.*\.json$/.test(file))
    .map((file) => path.join(REPORT_DIR, file));
  const runs: Run[] = [];
  for (const file of jsonFiles) {
    try {
      runs.push(JSON.parse(await fs.readFile(file, 'utf8')) as Run);
    } catch {
      // Ignore partial files.
    }
  }
  return runs.sort((a, b) => a.started_at.localeCompare(b.started_at));
}

function screenshotFigure(run: Run | undefined, key: string, caption: string) {
  const file = run?.screenshots?.[key];
  if (!file) return '';
  return `<figure><img src="${escapeHtml(rel(file))}" alt="${escapeHtml(caption)}"><figcaption>${escapeHtml(caption)}</figcaption></figure>`;
}

async function main() {
  const runs = await loadRuns();
  const workflow = [...runs].reverse().find((run) => run.ids?.created_task_id && Array.isArray(run.evidence?.final_intents));
  const flaky = [...runs].reverse().find((run) => hasCheck(run, 'Expected Defty captures appeared', 'fail'));
  const notes = [...runs].reverse().find((run) => hasCheck(run, 'Notes-only certification completed', 'pass'));

  if (!workflow || !notes) {
    throw new Error('Could not find both workflow and notes certification runs to consolidate.');
  }

  const workflowKinds = (workflow.evidence.final_intents ?? []).map((intent: any) => `${intent.kind}:${intent.status}`);
  const converted = (workflow.evidence.final_intents ?? []).filter((intent: any) => intent.status === 'converted');
  const missing = flaky?.evidence?.capture_poll?.kinds ?? [];
  const wikiPages = workflow.evidence?.wiki_search?.pages ?? [];
  const notePages = notes.evidence?.promoted_note?.wiki_pages ?? [];

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Deft Demo Process Certification</title>
  <style>
    :root { color-scheme: light; --ink:#191714; --muted:#70685d; --line:#ddd5c7; --paper:#faf7f0; --card:#fffdf8; --accent:#6f5fda; --green:#168a5b; --amber:#a86700; --red:#bf3b2f; }
    body { margin:0; background:var(--paper); color:var(--ink); font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height:1.46; }
    main { max-width:1160px; margin:0 auto; padding:42px 24px 72px; }
    h1 { margin:0 0 10px; font-size:38px; line-height:1.02; letter-spacing:0; }
    h2 { margin:34px 0 12px; font-size:21px; }
    h3 { margin:22px 0 8px; font-size:15px; }
    p { color:var(--muted); max-width:880px; }
    .hero, .card, table, figure { border:1px solid var(--line); background:var(--card); border-radius:8px; }
    .hero { padding:28px; }
    .pill { display:inline-flex; padding:5px 10px; border:1px solid var(--line); border-radius:999px; background:#fff; color:var(--muted); font-size:12px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:12px; }
    .card { padding:16px; }
    .metric { font-size:28px; font-weight:750; color:var(--ink); }
    table { width:100%; border-collapse:collapse; overflow:hidden; }
    th, td { padding:11px 12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; font-size:13px; }
    th { background:#f3eee5; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
    tr:last-child td { border-bottom:0; }
    .pass { color:var(--green); font-weight:750; }
    .warn { color:var(--amber); font-weight:750; }
    .fail { color:var(--red); font-weight:750; }
    .screens { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:14px; }
    figure { margin:0; overflow:hidden; }
    figure img { width:100%; display:block; background:#0f0f12; }
    figcaption { padding:9px 11px; color:var(--muted); font-size:12px; border-top:1px solid var(--line); }
    pre { white-space:pre-wrap; overflow-wrap:anywhere; background:#fffdf8; border:1px solid var(--line); border-radius:8px; padding:14px; font-size:12px; color:#3b342d; }
    code { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  </style>
</head>
<body>
<main>
  <section class="hero">
    <span class="pill">Human-like process validation on demo.deft.ing</span>
    <h1>Deft Demo Process Certification</h1>
    <p>This consolidates the latest UI-first runs against the Testers Tomatoes demo org. The result is not a clean green stamp: the core workflow works, but the demo still has reliability cracks around over-capture, rate limits, and classifier repeatability.</p>
    <div class="grid">
      <div class="card"><div class="metric">Partial</div><span>Overall demo process status</span></div>
      <div class="card"><div class="metric">${converted.length}</div><span>Converted captures in strongest workflow run</span></div>
      <div class="card"><div class="metric">${notePages.length}</div><span>Note pages promoted to wiki in focused run</span></div>
    </div>
  </section>

  <h2>Claim Verdicts</h2>
  <table>
    <thead><tr><th>Claim</th><th>Verdict</th><th>What actually happened</th></tr></thead>
    <tbody>
      <tr><td>Chat becomes context</td><td class="warn">Works, but noisy/flaky</td><td>A tagged workflow message created task, decision, resource, and note work intents in one run. A later equivalent run only created task/note/noise captures. A "no action needed" message was captured as memory.</td></tr>
      <tr><td>Tasks become action</td><td class="pass">Validated</td><td>UI approval of the task capture created task <code>${escapeHtml(workflow.ids.created_task_id)}</code> linked back to source message <code>${escapeHtml(workflow.evidence.created_task?.source_message_id)}</code>.</td></tr>
      <tr><td>Notes become memory</td><td class="pass">Validated through explicit promotion</td><td>The Notes UI created a blank note, edited it, promoted it to wiki, and wiki search found the promoted page.</td></tr>
      <tr><td>Approvals become governance</td><td class="pass">Validated</td><td>Capture cards required approval. A narrow API receipt check verified receipts for the four approved actions from the strongest workflow run.</td></tr>
    </tbody>
  </table>

  <h2>Important Findings</h2>
  <table>
    <thead><tr><th>Severity</th><th>Issue</th><th>Why it matters</th></tr></thead>
    <tbody>
      <tr><td class="fail">P1</td><td>Classifier repeatability is not yet demo-safe</td><td>Run <code>${escapeHtml(workflow.marker)}</code> produced the full capture set: ${escapeHtml(workflowKinds.join(', '))}. Run <code>${escapeHtml(flaky?.marker)}</code> only produced: ${escapeHtml(missing.join(', '))}. The same demo story can look impressive once and underpowered the next time.</td></tr>
      <tr><td class="fail">P1</td><td>Production demo rate limit is too tight for normal rich UI testing</td><td>Rapid human-like sends hit <code>429 RATE_LIMITED</code>. Even if real humans type slower, a demo recording should not need one-minute pauses between messages.</td></tr>
      <tr><td class="warn">P2</td><td>No-op/no-action messages become memory captures</td><td>The explicit "No action needed, no task, no memory" message still produced a note_candidate. This is a chaos risk in busy channels.</td></tr>
      <tr><td class="warn">P3</td><td>Marker search undercounts converted knowledge</td><td>The strongest run converted decision/resource/note captures, but marker wiki search returned ${wikiPages.length} page(s). Receipts prove approvals happened; searchability needs tighter verification/index timing.</td></tr>
    </tbody>
  </table>

  <h2>Evidence</h2>
  <div class="grid">
    <div class="card"><strong>Workflow run</strong><br><code>${escapeHtml(workflow.marker)}</code><p>Message id <code>${escapeHtml(workflow.ids.message_workflow_id)}</code>; task id <code>${escapeHtml(workflow.ids.created_task_id)}</code>.</p></div>
    <div class="card"><strong>Notes run</strong><br><code>${escapeHtml(notes.marker)}</code><p>Promoted pages: ${escapeHtml(notePages.map((p: any) => p.title).join(', '))}</p></div>
    <div class="card"><strong>Verified receipts</strong><br><p>Manual narrow check: three <code>wiki_create</code> receipts and one <code>task_create</code> receipt returned <code>verified: true</code>.</p></div>
  </div>

  <h2>Screenshots</h2>
  <div class="screens">
    ${screenshotFigure(workflow, 'chat-after-demo-messages', 'Chat after workflow messages')}
    ${screenshotFigure(workflow, 'captures-before-task', 'Capture card before task approval')}
    ${screenshotFigure(workflow, 'captures-after-knowledge', 'Capture card after knowledge approvals')}
    ${screenshotFigure(notes, 'notes-after-new-note-click', 'Notes create menu / blank note flow')}
    ${screenshotFigure(notes, 'notes-manager-note-before-promote', 'Manager note before promotion')}
    ${screenshotFigure(notes, 'knowledge-search-marker', 'Knowledge search after note promotion')}
  </div>

  <h2>Raw Evidence Snapshot</h2>
  <pre>${escapeHtml(JSON.stringify({
    workflow: {
      marker: workflow.marker,
      final_intents: workflow.evidence.final_intents,
      created_task: workflow.evidence.created_task,
      wiki_search: workflow.evidence.wiki_search,
    },
    flaky_followup: {
      marker: flaky?.marker,
      capture_poll: flaky?.evidence?.capture_poll,
    },
    notes: notes.evidence.promoted_note,
  }, null, 2))}</pre>
</main>
</body>
</html>`;

  await fs.writeFile(OUT, html);
  console.log(`CONSOLIDATED_REPORT=${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
