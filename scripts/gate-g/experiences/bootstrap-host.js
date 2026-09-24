const state = window.__bootstrapProbe = { a: null, b: null, received: [], storageReads: [], errors: [] };
const appOrigin = '__APP_ORIGIN__';
const sameOriginControl = new URLSearchParams(location.search).get('mode') === 'same-origin';
const ports = new Map();
const $ = id => document.getElementById(id);
const show = () => {
  $('result-a').textContent = JSON.stringify({ probe: state.a, received: state.received.filter(x => x.id === 'a'), storage: state.storageReads.filter(x => x.id === 'a') }, null, 2);
  $('result-b').textContent = JSON.stringify({ probe: state.b, received: state.received.filter(x => x.id === 'b'), storage: state.storageReads.filter(x => x.id === 'b') }, null, 2);
};
async function hits() { $('hits').textContent = JSON.stringify(await (await fetch('/observations')).json(), null, 2); }
$('refresh').onclick = hits;
function frame(id) {
  const iframe = document.createElement('iframe');
  iframe.sandbox = sameOriginControl ? 'allow-scripts allow-same-origin' : 'allow-scripts';
  iframe.title = `Trusted bootstrap ${id}`;
  iframe.referrerPolicy = 'no-referrer';
  iframe.onload = () => {
    iframe.onload = null;
    const channel = new MessageChannel();
    ports.set(id, channel.port1);
    channel.port1.onmessage = message => {
      if (message.data?.kind === 'probe') state[id] = message.data.results;
      else if (message.data?.kind === 'broadcast-received') state.received.push({ id, from: message.data.from });
      else if (message.data?.kind === 'storage-read') state.storageReads.push({ id, cacheValue: message.data.cacheValue, cacheError: message.data.cacheError, indexedDbValue: message.data.indexedDbValue, indexedDbError: message.data.indexedDbError });
      else if (message.data?.kind === 'bootstrap-error') state.errors.push({ id, reason: message.data.reason });
      show(); hits();
    };
    iframe.contentWindow.postMessage({ kind: 'start', id }, '*', [channel.port2]);
  };
  iframe.src = `${appOrigin}/bootstrap?instance=${id}`;
  $(`frame-${id}`).append(iframe);
}
$('start').onclick = () => { $('start').disabled = true; frame('a'); frame('b'); $('broadcast').disabled = false; $('storage-read').disabled = false; $('revoke').disabled = false; };
$('broadcast').onclick = () => { ports.get('a')?.postMessage({ kind: 'broadcast', marker: 'from-a' }); ports.get('b')?.postMessage({ kind: 'broadcast', marker: 'from-b' }); };
$('storage-read').onclick = () => { ports.get('a')?.postMessage({ kind: 'storage-read' }); ports.get('b')?.postMessage({ kind: 'storage-read' }); };
$('revoke').onclick = () => { for (const port of ports.values()) port.postMessage({ kind: 'revoke' }); ports.clear(); $('frame-a').replaceChildren(); $('frame-b').replaceChildren(); $('broadcast').disabled = true; $('storage-read').disabled = true; $('revoke').disabled = true; };
