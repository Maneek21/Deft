const $ = id => document.getElementById(id);
const telemetry = window.__gateG = { iframe: null, worker: null, rejected: 0, messages: 0, session: 0 };
let activeWorker = null;
let currentView = null;
let rateWindow = performance.now();
let rateCount = 0;

const write = (id, value) => { $(id).textContent = JSON.stringify(value, null, 2); };
async function refreshHits() { write('hits', await (await fetch('/observations')).json()); }
$('refresh-hits').onclick = refreshHits;

$('run-iframe').onclick = () => {
  $('run-iframe').disabled = true;
  $('iframe-status').textContent = 'Running browser probes…';
  const frame = document.createElement('iframe');
  frame.title = 'Sandboxed synthetic author HTML';
  frame.sandbox = 'allow-scripts';
  frame.referrerPolicy = 'no-referrer';
  frame.style.cssText = 'width:100%;height:70px;border:1px solid #6582a6;background:white';
  frame.onload = () => {
    frame.onload = null;
    const channel = new MessageChannel();
    channel.port1.onmessage = event => {
      if (event.data?.kind !== 'results') return;
      telemetry.iframe = event.data.results;
      write('iframe-results', event.data.results);
      $('iframe-status').textContent = 'Probe responses received; inspect sink for actual requests.';
      setTimeout(refreshHits, 350);
    };
    frame.contentWindow.postMessage({ kind: 'start' }, '*', [channel.port2]);
  };
  frame.src = '/iframe';
  $('iframe-container').append(frame);
  const navigationFrame = document.createElement('iframe');
  navigationFrame.title = 'Navigation-only synthetic author HTML';
  navigationFrame.sandbox = 'allow-scripts';
  navigationFrame.referrerPolicy = 'no-referrer';
  navigationFrame.style.cssText = 'width:100%;height:45px;border:1px solid #6582a6;background:white';
  navigationFrame.src = '/iframe?mode=navigation';
  $('iframe-container').append(navigationFrame);
};

function send(action, extra = {}) {
  if (activeWorker) activeWorker.postMessage({ kind: 'event', action, ...extra });
}
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text).slice(0, 2000);
  return node;
};
function draw(canvas, strokes) {
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#1756a9';
  context.lineWidth = 3;
  context.beginPath();
  strokes.forEach((point, index) => {
    const x = point.x * canvas.width;
    const y = point.y * canvas.height;
    if (index) context.lineTo(x, y); else context.moveTo(x, y);
  });
  context.stroke();
  for (const point of strokes) {
    context.beginPath();
    context.arc(point.x * canvas.width, point.y * canvas.height, 3, 0, Math.PI * 2);
    context.fillStyle = '#1756a9';
    context.fill();
  }
}
function validView(view) {
  const short = (value, max) => typeof value === 'string' && value.length <= max;
  const validStrokes = strokes => Array.isArray(strokes) && strokes.length <= 200 &&
    strokes.every(point => point && Number.isFinite(point.x) && point.x >= 0 && point.x <= 1 && Number.isFinite(point.y) && point.y >= 0 && point.y <= 1);
  return view && typeof view === 'object' &&
    Array.isArray(view.rows) && view.rows.length <= 100 &&
    view.rows.every(row => row && short(row.id, 80) && short(row.name, 200)) &&
    short(view.selected, 80) &&
    (view.detail === null || (view.detail && short(view.detail.name, 200) && short(view.detail.note, 2000))) &&
    Array.isArray(view.grid) && view.grid.length <= 30 &&
    view.grid.every(row => Array.isArray(row) && row.length === 3 && row.every(cell => short(cell, 100))) &&
    short(view.draft, 2000) &&
    validStrokes(view.strokes);
}
function render(view) {
  if (!validView(view)) { telemetry.rejected++; return; }
  const root = $('worker-ui');
  const active = document.activeElement;
  const focusKey = active?.dataset?.focusKey;
  const selectionStart = active instanceof HTMLTextAreaElement ? active.selectionStart : null;
  root.replaceChildren();
  const shell = element('div', 'app-shell');
  const list = element('div', 'list');
  const add = element('button', '', 'Add record'); add.onclick = () => send('add'); list.append(add);
  for (const row of view.rows) {
    const button = element('button', '', row.name);
    button.dataset.focusKey = `row-${row.id}`;
    button.setAttribute('aria-current', String(row.id === view.selected));
    button.onclick = () => send('select', { id: row.id });
    list.append(button);
  }
  const detail = element('div', 'detail');
  detail.append(element('h3', '', view.detail?.name || 'No selection'), element('p', '', view.detail?.note || ''));
  const editor = element('textarea', 'field');
  editor.setAttribute('aria-label', 'Text editor'); editor.dataset.focusKey = 'editor';
  editor.rows = 4; editor.value = view.draft;
  editor.oninput = () => send('draft', { value: editor.value });
  detail.append(editor);
  shell.append(list, detail); root.append(shell);
  root.append(element('h3', '', 'Editable grid'));
  const grid = element('div', 'grid'); grid.setAttribute('role', 'grid');
  view.grid.forEach((row, r) => row.forEach((cell, c) => {
    const input = element('input', 'field'); input.value = String(cell).slice(0, 100);
    input.setAttribute('aria-label', `Grid row ${r + 1} column ${c + 1}`);
    input.dataset.focusKey = `grid-${r}-${c}`;
    input.onchange = () => send('grid', { row: r, column: c, value: input.value });
    input.onkeydown = event => {
      const offsets = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] };
      if (!offsets[event.key]) return;
      event.preventDefault();
      const [dr, dc] = offsets[event.key];
      grid.querySelector(`[data-focus-key="grid-${Math.max(0, Math.min(view.grid.length - 1, r + dr))}-${Math.max(0, Math.min(2, c + dc))}"]`)?.focus();
    };
    input.onpaste = event => {
      const cells = event.clipboardData.getData('text/plain').split(/\r?\n/).slice(0, 20).map(x => x.split('\t').slice(0, 3));
      if (cells.length < 2 && cells[0].length < 2) return;
      event.preventDefault();
      send('grid-paste', { row: r, column: c, values: cells.map(line => line.map(value => value.slice(0, 100))) });
    };
    grid.append(input);
  }));
  root.append(grid, element('h3', '', 'Canvas-like pointer input'));
  const canvas = element('canvas', 'canvas'); canvas.width = 620; canvas.height = 150;
  canvas.setAttribute('aria-label', 'Pointer drawing surface');
  canvas.onpointerdown = event => { canvas.setPointerCapture(event.pointerId); canvas.onpointermove(event); };
  canvas.onpointermove = event => {
    if (event.buttons !== 1) return;
    const box = canvas.getBoundingClientRect();
    send('draw', { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height });
  };
  root.append(canvas);
  draw(canvas, view.strokes);
  if (focusKey) {
    const restored = [...root.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === focusKey);
    restored?.focus();
    if (selectionStart !== null && restored instanceof HTMLTextAreaElement) restored.setSelectionRange(selectionStart, selectionStart);
  }
}

$('run-worker').onclick = () => {
  if (activeWorker) return;
  const session = ++telemetry.session;
  rateWindow = performance.now(); rateCount = 0;
  const worker = new Worker('/worker.js');
  activeWorker = worker;
  $('run-worker').disabled = true; $('revoke-worker').disabled = false;
  $('flood-worker').disabled = false; $('late-worker').disabled = false;
  $('worker-status').textContent = `Session ${session} active`;
  worker.onmessage = event => {
    if (activeWorker !== worker || telemetry.session !== session) { telemetry.rejected++; return; }
    const now = performance.now();
    if (now - rateWindow > 1000) { rateWindow = now; rateCount = 0; }
    if (++rateCount > 100) { telemetry.rejected++; return; }
    let length;
    try { length = JSON.stringify(event.data).length; }
    catch { telemetry.rejected++; return; }
    if (length > 65536) { telemetry.rejected++; return; }
    telemetry.messages++;
    if (event.data?.kind === 'probe') { telemetry.worker = event.data.results; write('worker-results', event.data.results); refreshHits(); }
    if (event.data?.kind === 'strokes' && Array.isArray(event.data.strokes) && event.data.strokes.length <= 200 && event.data.strokes.every(point => point && Number.isFinite(point.x) && point.x >= 0 && point.x <= 1 && Number.isFinite(point.y) && point.y >= 0 && point.y <= 1)) {
      if (currentView) { currentView.strokes = event.data.strokes; telemetry.view = currentView; }
      const canvas = $('worker-ui').querySelector('canvas');
      if (canvas) draw(canvas, event.data.strokes);
    }
    if (event.data?.kind === 'view') {
      if (!validView(event.data.view)) { telemetry.rejected++; return; }
      currentView = event.data.view; telemetry.view = currentView; render(currentView);
    }
  };
  worker.postMessage({ kind: 'start' });
};
$('flood-worker').onclick = () => activeWorker?.postMessage({ kind: 'flood' });
$('late-worker').onclick = () => activeWorker?.postMessage({ kind: 'late' });
$('revoke-worker').onclick = () => {
  if (!activeWorker) return;
  activeWorker.terminate(); activeWorker = null; telemetry.session++;
  currentView = null; $('worker-ui').replaceChildren();
  telemetry.view = null;
  $('worker-status').textContent = 'Session revoked; author logic terminated';
  $('run-worker').disabled = false; $('revoke-worker').disabled = true;
  $('flood-worker').disabled = true; $('late-worker').disabled = true;
};
