import type { ExperienceNode, ExperienceView } from './app-experience-bridge';

export type ExperienceUiEvent = Readonly<{
  kind: 'click' | 'input' | 'grid_select' | 'grid_edit' | 'canvas_stroke';
  node_id: string;
  row_id?: string;
  column?: number;
  value?: string;
  points?: readonly Readonly<{ x: number; y: number }>[];
}>;

export const EXPERIENCE_RENDERER_CSS = `
.deft-experience { font: 14px/1.45 system-ui,sans-serif; color:#eaf1ff; background:#111827; min-height:100%; padding:16px; box-sizing:border-box }
.deft-experience * { box-sizing:border-box }
.deft-experience .ex-stack { display:grid; gap:14px; min-width:0 }
.deft-experience .ex-stack-title { margin:0; font-size:18px; font-weight:700 }
.deft-experience .ex-grid-scroll { overflow:auto; border:1px solid #334155; border-radius:10px; max-width:100% }
.deft-experience table { width:100%; min-width:560px; border-collapse:collapse; background:#172235 }
.deft-experience th,.deft-experience td { border-bottom:1px solid #334155; padding:7px 8px; text-align:left }
.deft-experience th { background:#24334b; color:#cbd5e1; font-size:12px; white-space:nowrap }
.deft-experience tr[aria-selected=true] { background:#233f57 }
.deft-experience input { width:100%; min-width:80px; padding:5px 7px; border:1px solid transparent; border-radius:5px; color:#eaf1ff; background:transparent; font:inherit }
.deft-experience input:focus { outline:2px solid #60a5fa; border-color:#60a5fa; background:#0f172a }
.deft-experience button { min-height:44px; border:1px solid #4b75a8; background:#244b77; color:#fff; border-radius:7px; padding:8px 12px; cursor:pointer; font:inherit }
.deft-experience button:focus-visible { outline:2px solid #93c5fd; outline-offset:2px }
.deft-experience .ex-text { margin:0; white-space:pre-wrap; overflow-wrap:anywhere }
.deft-experience .ex-field { display:grid; gap:4px; min-width:0 }
.deft-experience .ex-field label { display:grid; gap:4px; color:#a9b9d1; font-size:12px }
.deft-experience .ex-field input { min-height:44px; border-color:#4b75a8; background:#172235 }
.deft-experience canvas { display:block; width:100%; height:200px; border:1px solid #4b75a8; border-radius:9px; background:#0d1a2c; touch-action:none }
@media(max-width:420px) { .deft-experience { padding:10px } .deft-experience table { min-width:510px } .deft-experience .ex-stack-title { font-size:16px } }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function paint(canvas: HTMLCanvasElement, strokes: ExperienceNode & { kind: 'canvas' }): void {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(ratio, ratio);
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#7dd3fc';
  for (const stroke of strokes.strokes) {
    if (stroke.points.length < 2) continue;
    ctx.beginPath();
    stroke.points.forEach((point, index) => {
      const x = point.x * rect.width;
      const y = point.y * rect.height;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

function renderNode(node: ExperienceNode, emit: (event: ExperienceUiEvent) => void): HTMLElement {
  if (node.kind === 'text') {
    const p = el('p', 'ex-text');
    p.textContent = node.text;
    return p;
  }
  if (node.kind === 'button') {
    const button = el('button');
    button.type = 'button';
    button.textContent = node.label;
    button.dataset.focusKey = node.id;
    button.addEventListener('click', () => emit({ kind: 'click', node_id: node.id }));
    return button;
  }
  if (node.kind === 'input') {
    const wrap = el('div', 'ex-field');
    const label = el('label');
    const input = el('input');
    input.value = node.value;
    input.dataset.focusKey = node.id;
    label.textContent = node.label;
    input.addEventListener('change', () => emit({ kind: 'input', node_id: node.id, value: input.value }));
    label.append(input);
    wrap.append(label);
    return wrap;
  }
  if (node.kind === 'stack') {
    const wrap = el('section', 'ex-stack');
    if (node.title) {
      const title = el('h2', 'ex-stack-title');
      title.textContent = node.title;
      wrap.append(title);
    }
    node.children.forEach((child) => wrap.append(renderNode(child, emit)));
    return wrap;
  }
  if (node.kind === 'grid') {
    const scroll = el('div', 'ex-grid-scroll');
    const table = el('table');
    table.setAttribute('role', 'grid');
    table.setAttribute('aria-label', node.id.replaceAll('_', ' '));
    const head = el('thead');
    const heading = el('tr');
    node.columns.forEach((column) => {
      const th = el('th'); th.textContent = column; heading.append(th);
    });
    head.append(heading);
    const body = el('tbody');
    node.rows.forEach((row, rowIndex) => {
      const tr = el('tr');
      tr.setAttribute('aria-selected', String(row.id === node.selected_row_id));
      tr.addEventListener('click', () => emit({ kind: 'grid_select', node_id: node.id, row_id: row.id }));
      row.cells.forEach((cell, column) => {
        const td = el('td');
        const input = el('input');
        input.value = cell;
        input.setAttribute('aria-label', `${node.columns[column]}, row ${rowIndex + 1}`);
        input.dataset.focusKey = `${node.id}:${row.id}:${column}`;
        input.dataset.gridRow = String(rowIndex);
        input.dataset.gridColumn = String(column);
        input.addEventListener('change', () => emit({
          kind: 'grid_edit', node_id: node.id, row_id: row.id, column, value: input.value,
        }));
        input.addEventListener('keydown', (event) => {
          let targetRow = rowIndex;
          let targetColumn = column;
          if (event.key === 'ArrowDown') targetRow += 1;
          else if (event.key === 'ArrowUp') targetRow -= 1;
          else if (event.key === 'ArrowRight' && input.selectionStart === input.value.length) targetColumn += 1;
          else if (event.key === 'ArrowLeft' && input.selectionStart === 0) targetColumn -= 1;
          else if (event.key === 'Enter') {
            emit({ kind: 'grid_edit', node_id: node.id, row_id: row.id, column, value: input.value });
            targetRow += 1;
          } else return;
          const next = body.querySelector<HTMLInputElement>(
            `input[data-grid-row="${targetRow}"][data-grid-column="${targetColumn}"]`);
          if (next) { event.preventDefault(); next.focus(); next.select(); }
        });
        td.append(input); tr.append(td);
      });
      body.append(tr);
    });
    table.append(head, body); scroll.append(table);
    return scroll;
  }
  const canvas = el('canvas');
  canvas.setAttribute('aria-label', node.id.replaceAll('_', ' '));
  canvas.setAttribute('role', 'img');
  let points: { x: number; y: number }[] | null = null;
  const relative = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) };
  };
  canvas.addEventListener('pointerdown', (event) => {
    points = [relative(event)]; canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (points && points.length < 512) points.push(relative(event));
  });
  canvas.addEventListener('pointerup', (event) => {
    if (!points) return;
    points.push(relative(event));
    emit({ kind: 'canvas_stroke', node_id: node.id, points });
    points = null;
  });
  requestAnimationFrame(() => paint(canvas, node));
  return canvas;
}

/** Author content becomes text/value/canvas strokes only; never HTML or URL sinks. */
export function renderExperienceView(
  container: HTMLElement, view: ExperienceView, emit: (event: ExperienceUiEvent) => void,
): void {
  const focused = document.activeElement instanceof HTMLElement && container.contains(document.activeElement)
    ? document.activeElement.dataset.focusKey : undefined;
  const selection = document.activeElement instanceof HTMLInputElement
    ? { start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : undefined;
  container.classList.add('deft-experience');
  container.replaceChildren(renderNode(view.root, emit));
  if (focused) {
    const candidate = Array.from(container.querySelectorAll<HTMLElement>('[data-focus-key]'))
      .find((element) => element.dataset.focusKey === focused);
    candidate?.focus();
    if (candidate instanceof HTMLInputElement && selection?.start !== null
      && selection?.start !== undefined && selection.end !== null && selection.end !== undefined) {
      candidate.setSelectionRange(selection.start, selection.end);
    }
  }
}
