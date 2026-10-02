const sink = channel => `/sink?channel=worker-${channel}`;
let rows = [
  { id: 'a', name: 'Aster', note: 'First synthetic record' },
  { id: 'b', name: 'Birch', note: 'Second synthetic record' },
  { id: 'c', name: 'Cedar', note: 'Third synthetic record' },
];
let selected = 'a';
let draft = 'A small editable text surface.\nNo workspace content is loaded.';
let strokes = [];
let grid = [['Item', 'Count', 'State'], ['Alpha', '12', 'Open'], ['Beta', '8', 'Done'], ['Gamma', '3', 'Open']];
let revision = 0;

function render() {
  const detail = rows.find(row => row.id === selected);
  postMessage({ kind: 'view', revision: ++revision, view: {
    rows: rows.map(({ id, name }) => ({ id, name })),
    selected,
    detail: detail ? { name: detail.name, note: detail.note } : null,
    grid,
    draft,
    strokes,
  }});
}

async function probe() {
  const results = {};
  const attempt = async (name, fn) => {
    try { results[name] = String(await fn()); }
    catch (error) { results[name] = `blocked:${error.name}`; }
  };
  await attempt('document', () => document.body.textContent);
  await attempt('parent', () => parent.document.body.textContent);
  await attempt('cookie-api', () => document.cookie);
  await attempt('local-storage', () => localStorage.length);
  await attempt('service-worker', () => navigator.serviceWorker.register('/worker.js'));
  await attempt('fetch', () => fetch(sink('fetch')));
  await attempt('xhr', () => new Promise((resolve, reject) => { const x = new XMLHttpRequest(); x.onload = resolve; x.onerror = reject; x.open('GET', sink('xhr')); x.send(); }));
  await attempt('websocket', () => new WebSocket(`ws://${location.host}${sink('websocket')}`));
  await attempt('eventsource', () => new EventSource(sink('eventsource')));
  await attempt('import-scripts', () => importScripts(sink('import-scripts')));
  await attempt('nested-worker', () => new Worker(sink('nested-worker')));
  await attempt('navigation', () => { location.href = sink('navigation'); return location.href; });
  await attempt('open', () => open(sink('popup')));
  await attempt('send-beacon', () => navigator.sendBeacon(sink('beacon'), 'x'));
  postMessage({ kind: 'probe', results });
}

onmessage = event => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.kind === 'start') { probe(); render(); return; }
  if (data.kind === 'flood') { for (let i = 0; i < 125; i++) postMessage({ kind: 'noop', i }); postMessage({ kind: 'noop', padding: 'x'.repeat(66000) }); return; }
  if (data.kind === 'late') { setTimeout(() => postMessage({ kind: 'view', revision: 99999, view: { rows: [{ id: 'late', name: 'Late stale view' }], selected: 'late', grid: [], strokes: [], draft: 'stale' } }), 300); return; }
  if (data.kind !== 'event') return;
  if (data.action === 'select' && rows.some(row => row.id === data.id)) selected = data.id;
  else if (data.action === 'add') rows = [...rows, { id: String(rows.length + 1), name: `New ${rows.length + 1}`, note: 'Incrementally added' }];
  else if (data.action === 'draft' && typeof data.value === 'string' && data.value.length <= 2000) draft = data.value;
  else if (data.action === 'grid' && Number.isInteger(data.row) && Number.isInteger(data.column) && data.row >= 0 && data.row < 4 && data.column >= 0 && data.column < 3 && typeof data.value === 'string' && data.value.length <= 100) {
    grid = grid.map((row, r) => row.map((value, c) => r === data.row && c === data.column ? data.value : value));
  }
  else if (data.action === 'grid-paste' && Number.isInteger(data.row) && Number.isInteger(data.column) && Array.isArray(data.values) && data.values.length <= 4) {
    const next = grid.map(row => [...row]);
    data.values.forEach((line, ri) => {
      if (!Array.isArray(line) || line.length > 3) return;
      line.forEach((value, ci) => { if (typeof value === 'string' && value.length <= 100 && next[data.row + ri]?.[data.column + ci] !== undefined) next[data.row + ri][data.column + ci] = value; });
    });
    grid = next;
  }
  else if (data.action === 'draw' && Number.isFinite(data.x) && Number.isFinite(data.y)) {
    strokes = [...strokes.slice(-199), { x: Math.max(0, Math.min(1, data.x)), y: Math.max(0, Math.min(1, data.y)) }];
    postMessage({ kind: 'strokes', strokes });
    return;
  } else return;
  render();
};
