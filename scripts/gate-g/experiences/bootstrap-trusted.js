// This script is host-owned. The author bytes execute only inside the Worker.
addEventListener('message', event => {
  if (event.source !== parent || event.origin !== HOST_ORIGIN || event.data?.kind !== 'start' || !event.ports[0]) return;
  const port = event.ports[0];
  let worker;
  try {
    const bytes = Uint8Array.from(atob(AUTHOR_BASE64), char => char.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    worker = new Worker(url);
    URL.revokeObjectURL(url);
  } catch (error) {
    port.postMessage({ kind: 'bootstrap-error', reason: `${error.name}: ${error.message}` });
    return;
  }
  let count = 0;
  worker.onmessage = message => {
    if (++count > 100 || !['probe', 'broadcast-received', 'storage-read'].includes(message.data?.kind)) return;
    port.postMessage(message.data);
  };
  worker.onerror = error => port.postMessage({ kind: 'bootstrap-error', reason: error.message });
  port.onmessage = command => {
    if (command.data?.kind === 'broadcast') worker.postMessage({ kind: 'broadcast', marker: String(command.data.marker).slice(0, 40) });
    if (command.data?.kind === 'storage-read') worker.postMessage({ kind: 'storage-read' });
    if (command.data?.kind === 'revoke') { worker.terminate(); port.close(); }
  };
  worker.postMessage({ kind: 'start', id: String(event.data.id).slice(0, 10), hostOrigin: HOST_ORIGIN, appOrigin: location.origin });
}, { once: true });
