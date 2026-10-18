/** Trusted bootstrap only. Author bytes run exclusively in its opaque Blob Worker. */
export const EXPERIENCE_BOOTSTRAP_SCRIPT = String.raw`(() => {
  'use strict';
  let started = false;
  let worker;
  let sessionId;
  let authorPort;
  const expectedOrigin = location.href === 'about:srcdoc'
    ? document.querySelector('meta[name="deft-experience-parent-origin"]')?.content
    : new URL(location.href).origin;
  if (!expectedOrigin || !/^https?:$/.test(new URL(expectedOrigin).protocol)
    || new URL(expectedOrigin).origin !== expectedOrigin) return;
  addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== parent || event.origin !== expectedOrigin || !data) return;
    if (started && data.kind === 'stop' && data.session_id === sessionId
      && Object.keys(data).every(key => ['kind', 'session_id'].includes(key)) && event.ports.length === 0) {
      worker?.terminate(); authorPort?.close(); worker = undefined; authorPort = undefined; return;
    }
    if (started || Object.keys(data).some((key) => !['kind', 'session_id', 'worker_source'].includes(key))
      || data.kind !== 'start'
      || typeof data.session_id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.session_id)
      || typeof data.worker_source !== 'string'
      || data.worker_source.length < 1 || data.worker_source.length > 98304
      || event.ports.length !== 1) return;
    started = true;
    const port = event.ports[0];
    authorPort = port; sessionId = data.session_id;
    const url = URL.createObjectURL(new Blob([data.worker_source], { type: 'text/javascript' }));
    const status = (state, phase) => parent.postMessage({ kind: 'deft_experience_bootstrap_status.v1', session_id: sessionId, state, phase }, expectedOrigin);
    const failed = (phase) => { worker?.terminate(); port.close(); status('failed', phase); };
    try {
      worker = new Worker(url);
      worker.onerror = () => failed('worker_runtime');
      worker.onmessageerror = () => failed('worker_runtime');
      worker.postMessage({ kind: 'start', session_id: data.session_id, port }, [port]);
      status('started', 'first_view');
    } catch {
      failed('worker_start');
    } finally {
      URL.revokeObjectURL(url);
    }
  });
  parent.postMessage({ kind: 'deft_experience_bootstrap_ready.v1' }, expectedOrigin);
})();
`;
