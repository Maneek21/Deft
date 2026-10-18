let sdk;
let rows = [
  { id: 'alpha', cells: ['Alpha', 'Open', 'Owner A'] },
  { id: 'beta', cells: ['Beta', 'Review', 'Owner B'] },
  { id: 'gamma', cells: ['Gamma', 'Done', 'Owner C'] },
];
let selected = 'alpha';
let strokes = [];
let probe = 'pending';
let storage = 'pending';

function view() {
  const row = rows.find((item) => item.id === selected) ?? rows[0];
  sdk.render({ root: { kind: 'stack', id: 'workspace', title: 'Parcel Studio',
    children: [
      { kind: 'text', id: 'intro', text: 'Edit a cell with Enter. Arrow keys move between cells. Select a row to inspect it.' },
      { kind: 'grid', id: 'orders', columns: ['Order', 'Status', 'Owner'], rows, selected_row_id: selected },
      { kind: 'stack', id: 'detail', title: 'Order detail', children: [
        { kind: 'text', id: 'selected_name', text: 'Selected: ' + row.cells[0] },
        { kind: 'text', id: 'selected_status', text: 'Status: ' + row.cells[1] },
        { kind: 'text', id: 'probe', text: 'Network probe: ' + probe },
        { kind: 'text', id: 'storage_probe', text: 'Storage probe: ' + storage },
      ] },
      { kind: 'stack', id: 'drawing', title: 'Route sketch', children: [
        { kind: 'canvas', id: 'route_canvas', strokes },
      ] },
    ] } });
}
async function noEgressProbe() {
  try {
    await fetch('http://127.0.0.1:4317/sink?kind=author-fetch', { mode: 'no-cors' });
    probe = 'unexpected fetch completion';
  } catch { probe = 'fetch blocked'; }
  view();
}
async function storageProbe(marker) {
  try {
    const cache = await caches.open('experience_probe');
    const markerUrl = 'http://localhost:4318/marker';
    const prior = await cache.match(markerUrl);
    storage = prior ? 'prior marker visible: ' + await prior.text() : 'empty before write';
    await cache.put(markerUrl, new Response(marker));
  } catch (error) {
    storage = 'unavailable: ' + (error?.name || 'error');
  }
  view();
}
self.onmessage = (message) => {
  if (message.data?.kind !== 'start') return;
  sdk = createDeftExperienceSdk(message.data.port, message.data.session_id);
  sdk.onEvent((event) => {
    if (!event || typeof event !== 'object') return;
    if (event.kind === 'grid_select') selected = event.row_id;
    if (event.kind === 'grid_edit') {
      const row = rows.find((item) => item.id === event.row_id);
      if (row && Number.isInteger(event.column) && event.column >= 0 && event.column < row.cells.length) {
        row.cells[event.column] = String(event.value).slice(0, 512);
      }
    }
    if (event.kind === 'canvas_stroke' && Array.isArray(event.points)) {
      strokes = [...strokes, { points: event.points }].slice(-64);
    }
    view();
  });
  view();
  void noEgressProbe();
  void storageProbe(message.data.session_id);
};
