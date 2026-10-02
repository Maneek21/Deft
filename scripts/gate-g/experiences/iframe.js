const sink = channel => `/sink?channel=iframe-${channel}`;
addEventListener('message', async event => {
  if (event.data?.kind !== 'start' || !event.ports[0]) return;
  const port = event.ports[0];
  const results = {};
  const attempt = async (name, fn) => {
    try { results[name] = String(await fn()); }
    catch (error) { results[name] = `blocked:${error.name}`; }
  };
  await attempt('parent-dom', () => parent.document.body.textContent);
  await attempt('sibling-dom', () => parent.frames[1].document.body.textContent);
  await attempt('cookie-api', () => document.cookie);
  await attempt('local-storage', () => localStorage.length);
  await attempt('service-worker', () => navigator.serviceWorker.register('/iframe.js'));
  await attempt('fetch', () => fetch(sink('fetch')));
  await attempt('websocket', () => new WebSocket('ws://' + location.host + sink('websocket')));
  await attempt('eventsource', () => new EventSource(sink('eventsource')));
  await attempt('image', () => { const x = new Image(); x.src = sink('image'); document.body.append(x); return 'created'; });
  await attempt('css', () => { const x = document.createElement('link'); x.rel = 'stylesheet'; x.href = sink('css'); document.head.append(x); return 'created'; });
  await attempt('font', () => { const x = new FontFace('Probe', `url(${sink('font')})`); return x.load(); });
  await attempt('media', () => { const x = document.createElement('video'); x.src = sink('media'); x.preload = 'auto'; document.body.append(x); return 'created'; });
  await attempt('preload', () => { const x = document.createElement('link'); x.rel = 'preload'; x.as = 'script'; x.href = sink('preload'); document.head.append(x); return 'created'; });
  await attempt('ping', () => { const x = document.createElement('a'); x.href = '#'; x.ping = sink('ping'); x.click(); return 'clicked'; });
  await attempt('form', () => { const x = document.createElement('form'); x.method = 'POST'; x.action = sink('form'); document.body.append(x); x.submit(); return 'submitted'; });
  await attempt('download', () => { const x = document.createElement('a'); x.href = sink('download'); x.download = 'marker'; x.click(); return 'clicked'; });
  await attempt('popup', () => { const x = open(sink('popup')); if (!x) throw new Error('denied'); return 'opened'; });
  await attempt('top-navigation', () => { top.location.href = sink('top-navigation'); return 'assigned'; });
  await attempt('nested-frame', () => { const x = document.createElement('iframe'); x.src = sink('nested-frame'); document.body.append(x); return 'created'; });
  await attempt('nested-worker', () => new Worker(sink('nested-worker')));
  port.postMessage({ kind: 'results', results });
  setTimeout(() => { location.href = sink('self-navigation'); }, 100);
}, { once: true });
