/* Synthetic, provider-free payload. It receives only this harness's loopback URLs. */
onmessage = event => {
  if (event.data?.kind !== 'start' || !event.data.port) return;
  const port = event.data.port;
  let broadcast, probeId, completedResults;
  port.onmessage = async event => {
    if (event.data?.kind === 'broadcast' && completedResults) {
      broadcast?.postMessage(probeId);
      port.postMessage({ kind: 'broadcast_ack', id: probeId }); return;
    }
    if (event.data?.kind === 'finish' && completedResults) {
      broadcast?.close();
      port.postMessage({ kind: 'probe_results', id: probeId, results: completedResults }); return;
    }
    if (event.data?.kind !== 'probe') return;
    const { id, hostOrigin, foreignOrigin, marker } = event.data;
    probeId = id;
    port.postMessage({ kind: 'first_view', id });
    const results = { opaque: self.origin === 'null', secure: isSecureContext };
    const attempt = async (key, run) => {
      try { results[key] = { allowed: true, value: String(await run()) }; }
      catch (error) { results[key] = { allowed: false, error: error?.name || 'Error' }; }
    };
    await attempt('parentDOM', () => parent.document.body);
    await attempt('document', () => document.cookie);
    await attempt('localStorage', () => localStorage.getItem(marker));
    await attempt('indexedDB', () => new Promise((resolve, reject) => {
      const request = indexedDB.open(marker);
      request.onsuccess = () => { request.result.close(); resolve('opened'); };
      request.onerror = () => reject(request.error);
    }));
    await attempt('cacheStorage', () => caches.open(marker));
    await attempt('broadcast', () => {
      broadcast = new BroadcastChannel(marker);
      broadcast.onmessage = () => port.postMessage({ kind: 'sibling_leak', id });
      return 'opened';
    });
    await attempt('fetchHost', () => fetch(hostOrigin + '/sink?probe=' + id + '-fetch-host'));
    await attempt('fetchForeign', () => fetch(foreignOrigin + '/sink?probe=' + id + '-fetch-foreign'));
    await attempt('webSocket', () => new Promise((resolve, reject) => {
      const socket = new WebSocket(foreignOrigin.replace('http:', 'ws:') + '/sink?probe=' + id + '-ws');
      const timeout = setTimeout(() => { socket.close(); reject(new Error('bounded timeout')); }, 1500);
      socket.onopen = () => { clearTimeout(timeout); socket.close(); resolve('opened'); };
      socket.onerror = () => { clearTimeout(timeout); reject(new Error('blocked')); };
    }));
    await attempt('importScripts', () => importScripts(foreignOrigin + '/sink?probe=' + id + '-import'));
    await attempt('eventSource', () => new Promise((resolve, reject) => {
      const source = new EventSource(foreignOrigin + '/sink?probe=' + id + '-eventsource');
      const timeout = setTimeout(() => { source.close(); reject(new Error('bounded timeout')); }, 1500);
      source.onopen = () => { clearTimeout(timeout); source.close(); resolve('opened'); };
      source.onerror = () => { clearTimeout(timeout); source.close(); reject(new Error('blocked')); };
    }));
    await attempt('nestedHTTPWorker', () => new Worker(foreignOrigin + '/sink?probe=' + id + '-worker'));
    await attempt('nestedBlobWorker', () => new Promise((resolve, reject) => {
      const code = `onmessage=async e=>{const out={};for(const[k,url]of Object.entries(e.data)){try{if(k==='importScripts')importScripts(url);else await fetch(url);out[k]='allowed'}catch(x){out[k]='blocked'}}postMessage(out)}`;
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      const child = new Worker(url); URL.revokeObjectURL(url);
      const timeout = setTimeout(() => { child.terminate(); reject(new Error('bounded timeout')); }, 2000);
      child.onmessage = e => { clearTimeout(timeout); child.terminate(); resolve(JSON.stringify(e.data)); };
      child.onerror = () => { clearTimeout(timeout); child.terminate(); reject(new Error('worker failure')); };
      child.postMessage({ fetchHost: hostOrigin + '/sink?probe=' + id + '-nested-host', fetchForeign: foreignOrigin + '/sink?probe=' + id + '-nested-foreign', importScripts: foreignOrigin + '/sink?probe=' + id + '-nested-import' });
    }));
    completedResults = results;
    port.postMessage({ kind: 'probe_ready', id });
  };
  port.start();
};
