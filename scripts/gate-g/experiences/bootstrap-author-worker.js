let siblingChannel = null;
let instanceId = '';
let appOriginForStorage = '';
const openDb = () => new Promise((resolve, reject) => {
  const request = indexedDB.open('gate-g-probe', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('markers');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const txDone = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error);
});
const attempt = async (name, fn, results) => {
  try { results[name] = String(await fn()); }
  catch (error) { results[name] = `blocked:${error?.name || 'Error'}`; }
};
async function run(data) {
  instanceId = data.id;
  appOriginForStorage = data.appOrigin;
  const results = { locationOrigin: location.origin, selfOrigin: self.origin, secureContext: isSecureContext };
  await attempt('document', () => document.cookie, results);
  await attempt('localStorage', () => localStorage.length, results);
  await attempt('indexedDB', async () => {
    const db = await openDb();
    const transaction = db.transaction('markers', 'readwrite');
    transaction.objectStore('markers').put(instanceId, 'shared');
    await txDone(transaction);
    db.close();
    return 'written';
  }, results);
  await attempt('cacheStorage', async () => { const cache = await caches.open('gate-g-probe'); await cache.put(`${data.appOrigin}/marker`, new Response(instanceId)); return 'written'; }, results);
  await attempt('broadcastChannel', () => {
    siblingChannel = new BroadcastChannel('gate-g-sibling-probe');
    siblingChannel.onmessage = event => postMessage({ kind: 'broadcast-received', from: event.data?.marker });
    return 'opened';
  }, results);
  await attempt('fetch-host', () => fetch(`${data.hostOrigin}/sink?channel=bootstrap-fetch-host`), results);
  await attempt('fetch-app', () => fetch(`${data.appOrigin}/sink?channel=bootstrap-fetch-app`), results);
  await attempt('websocket-app', () => new WebSocket(`${new URL(data.appOrigin).protocol === 'https:' ? 'wss:' : 'ws:'}//${new URL(data.appOrigin).host}/sink?channel=bootstrap-websocket`), results);
  await attempt('eventsource-app', () => new EventSource(`${data.appOrigin}/sink?channel=bootstrap-eventsource`), results);
  await attempt('importScripts-app', () => importScripts(`${data.appOrigin}/sink?channel=bootstrap-importscripts`), results);
  await attempt('nested-worker-url', () => new Worker(`${data.appOrigin}/sink?channel=bootstrap-nested-worker`), results);
  await attempt('nested-blob-worker', () => new Promise((resolve, reject) => {
    const source = `onmessage=async event=>{const out={};try{await fetch(event.data.fetchUrl);out.fetch='allowed'}catch(error){out.fetch='blocked:'+error.name}try{importScripts(event.data.scriptUrl);out.importScripts='allowed'}catch(error){out.importScripts='blocked:'+error.name}postMessage(out)}`;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const child = new Worker(url);
    URL.revokeObjectURL(url);
    const timeout = setTimeout(() => { child.terminate(); reject(new Error('nested timeout')); }, 2000);
    child.onmessage = event => { clearTimeout(timeout); child.terminate(); resolve(JSON.stringify(event.data)); };
    child.onerror = error => { clearTimeout(timeout); child.terminate(); reject(error); };
    child.postMessage({ fetchUrl: `${data.appOrigin}/sink?channel=bootstrap-nested-blob-fetch`, scriptUrl: `${data.appOrigin}/sink?channel=bootstrap-nested-blob-importscripts` });
  }), results);
  await attempt('navigation', () => { location.href = `${data.appOrigin}/sink?channel=bootstrap-navigation`; return location.href; }, results);
  postMessage({ kind: 'probe', id: instanceId, results });
}
onmessage = event => {
  if (event.data?.kind === 'start') { run(event.data); return; }
  if (event.data?.kind === 'broadcast') { siblingChannel?.postMessage({ marker: event.data.marker }); return; }
  if (event.data?.kind === 'storage-read') {
    (async () => {
      const result = { kind: 'storage-read', id: instanceId };
      try {
        const cache = await caches.open('gate-g-probe');
        const response = await cache.match(`${appOriginForStorage}/marker`);
        result.cacheValue = response ? await response.text() : null;
      } catch (error) { result.cacheError = error?.name || 'Error'; }
      try {
        const db = await openDb();
        const transaction = db.transaction('markers', 'readonly');
        const request = transaction.objectStore('markers').get('shared');
        result.indexedDbValue = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result ?? null); request.onerror = () => reject(request.error); });
        db.close();
      } catch (error) { result.indexedDbError = error?.name || 'Error'; }
      postMessage(result);
    })();
  }
};
