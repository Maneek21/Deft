import { buildExperienceBootstrapSrcdoc } from '../../../apps/web/src/lib/app-experience-bootstrap-srcdoc';
declare const __HARNESS_API_ORIGIN__: string;

const output = document.querySelector('pre')!;
const report: any = { state: 'ready_to_start', mode: new URL(location.href).searchParams.get('mode') === 'http' ? 'http' : 'srcdoc', frames: {}, sink_hits: null, pass: false, browser_started_by_harness: false };
const frames: HTMLIFrameElement[] = [];
const ports: MessagePort[] = [];
const foreignOrigin = __HARNESS_API_ORIGIN__;
const paint = () => { output.textContent = JSON.stringify(report, null, 2); };
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function checkResults(results: any) {
  const denied = ['parentDOM', 'document', 'localStorage', 'indexedDB', 'cacheStorage', 'fetchHost', 'fetchForeign', 'webSocket', 'importScripts', 'eventSource', 'nestedHTTPWorker'];
  let nested;
  try { nested = JSON.parse(results.nestedBlobWorker.value); } catch { return false; }
  return results.opaque === true && denied.every(key => results[key]?.allowed === false)
    && results.nestedBlobWorker.allowed === true && Object.keys(nested).length === 3 && Object.values(nested).every(value => value === 'blocked');
}
async function start() {
  (document.querySelector('button') as HTMLButtonElement).disabled = true;
  report.state = 'running'; paint();
  const marker = 'deft-srcdoc-synthetic-' + crypto.randomUUID();
  const parentChannel = new BroadcastChannel(marker);
  parentChannel.onmessage = () => { report.parent_broadcast_leak = true; paint(); };
  try {
    const source = await (await fetch('/author-worker.js', { cache: 'no-store' })).text();
    const before = await (await fetch('/observations', { cache: 'no-store' })).json();
    // Ensure both sinks are reachable and CORS-permissive before the worker probes.
    await Promise.all([location.origin, foreignOrigin].map(origin => fetch(origin + '/sink?control=parent&run=' + marker, { credentials: 'omit' })));
    const markup = await buildExperienceBootstrapSrcdoc(location.origin);
    const make = async (id: string) => {
      const frame = document.createElement('iframe'); frames.push(frame);
      const sid = crypto.randomUUID(); const channel = new MessageChannel(); ports.push(channel.port1);
      const row: any = report.frames[id] = { load: false, ready: false, opaque: false, starts: 0, first_view: false, results: null, pass: false };
      frame.title = 'Synthetic isolated transport ' + id;
      frame.sandbox.add('allow-scripts'); frame.referrerPolicy = 'no-referrer';
      frame.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
      frame.addEventListener('load', () => { row.load = true; paint(); });
      const onMessage = (event: MessageEvent) => {
        if (event.source !== frame.contentWindow || event.origin !== 'null' || !event.data) return;
        if (event.data.kind === 'deft_experience_bootstrap_status.v1') { row.status = { state: event.data.state, phase: event.data.phase }; paint(); return; }
        if (row.ready || JSON.stringify(event.data) !== JSON.stringify({ kind: 'deft_experience_bootstrap_ready.v1' })) return;
        row.ready = true; row.opaque = true; row.starts += 1;
        frame.contentWindow!.postMessage({ kind: 'start', session_id: sid, worker_source: source }, '*', [channel.port2]);
        channel.port1.postMessage({ kind: 'probe', id, hostOrigin: location.origin, foreignOrigin, marker }); paint();
      };
      addEventListener('message', onMessage);
      channel.port1.onmessage = event => {
        if (event.data?.id !== id) return;
        if (event.data.kind === 'first_view') row.first_view = true;
        if (event.data.kind === 'probe_ready') row.probe_ready = true;
        if (event.data.kind === 'broadcast_ack') row.broadcast_ack = true;
        if (event.data.kind === 'sibling_leak') row.sibling_leak = true;
        if (event.data.kind === 'probe_results') { row.results = event.data.results; row.pass = checkResults(row.results); }
        paint();
      };
      channel.port1.start();
      if (report.mode === 'http') frame.src = '/app-experience-bootstrap'; else frame.srcdoc = markup;
      document.body.append(frame);
      return () => { removeEventListener('message', onMessage); frame.contentWindow?.postMessage({ kind: 'stop', session_id: sid }, '*'); frame.remove(); channel.port1.close(); };
    };
    const cleanup = await Promise.all(['a', 'b'].map(make));
    const deadline = performance.now() + 12000;
    while (performance.now() < deadline && !Object.values(report.frames).every((r: any) => r.probe_ready)) await wait(100);
    if (Object.values(report.frames).every((r: any) => r.probe_ready)) {
      ports.forEach(port => port.postMessage({ kind: 'broadcast' }));
      parentChannel.postMessage('synthetic-parent'); report.parent_broadcast_sent = true;
      while (performance.now() < deadline && !Object.values(report.frames).every((r: any) => r.broadcast_ack)) await wait(20);
      await wait(800); report.broadcast_observation_ms = 800;
      ports.forEach(port => port.postMessage({ kind: 'finish' }));
      while (performance.now() < deadline && !Object.values(report.frames).every((r: any) => r.results)) await wait(20);
    }
    const observed = await (await fetch('/observations', { cache: 'no-store' })).json();
    report.sink_hits = observed.worker_hits.slice(before.worker_hits.length);
    report.parent_controls_reached = observed.parent_controls.filter((row: any) => row.run === marker);
    report.pass = Object.values(report.frames).length === 2 && Object.values(report.frames).every((r: any) => r.load && r.ready && r.opaque && r.starts === 1 && r.first_view && r.probe_ready && r.broadcast_ack && r.pass && !r.sibling_leak)
      && !report.parent_broadcast_leak && report.sink_hits.length === 0 && report.parent_controls_reached.length === 2 && new Set(report.parent_controls_reached.map((row: any) => row.port)).size === 2;
    cleanup.forEach(fn => fn()); report.frames_removed = frames.every(frame => !frame.isConnected); report.pass &&= report.frames_removed;
    report.state = report.pass ? 'PASS' : 'FAIL';
  } catch (error) { report.state = 'FAIL'; report.error_class = (error as Error)?.name || 'Error'; }
  finally { frames.forEach(frame => frame.remove()); ports.forEach(port => port.close()); parentChannel.close(); paint(); }
}
document.querySelector('button')!.addEventListener('click', () => { void start(); });
paint();
