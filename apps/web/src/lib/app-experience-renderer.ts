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
.deft-experience { font:inherit; line-height:1.5; container-type:inline-size; color:var(--foreground,#1e293b); background:var(--surface,#fff); min-height:100%; padding:24px; box-sizing:border-box }
.deft-experience * { box-sizing:border-box }
.deft-experience .ex-stack { display:grid; gap:16px; min-width:0; align-content:start }
.deft-experience .ex-stack-list { gap:0 }
.deft-experience .ex-stack-horizontal { display:flex; flex-wrap:wrap; align-items:center; gap:10px }
.deft-experience .ex-stack-split { grid-template-columns:minmax(240px,32%) minmax(0,1fr); gap:24px }
.deft-experience .ex-stack-panel { padding:20px; border:1px solid var(--border,#e2e8f0); border-radius:12px; background:var(--surface,#fff) }
.deft-experience .ex-stack-title { margin:0; font-size:18px; font-weight:650; letter-spacing:-.02em; grid-column:1/-1 }
.deft-experience .ex-grid-scroll { overflow:auto; border:1px solid var(--border,#e2e8f0); border-radius:10px; max-width:100% }
.deft-experience table { width:100%; min-width:560px; border-collapse:collapse; background:var(--surface,#fff) }
.deft-experience th,.deft-experience td { border-bottom:1px solid var(--border,#e2e8f0); padding:7px 8px; text-align:left }
.deft-experience th { background:var(--surface-container-low,#f8fafc); color:var(--foreground-secondary,#64748b); font-size:12px; white-space:nowrap }
.deft-experience tr[aria-selected=true] { background:var(--accent-subtle,#eff6ff) }
.deft-experience input,.deft-experience textarea { width:100%; min-width:80px; padding:10px 12px; border:1px solid transparent; border-radius:7px; color:var(--foreground,#1e293b); background:transparent; font:inherit }
.deft-experience input:focus,.deft-experience textarea:focus { outline:2px solid var(--accent,#93c5fd); border-color:var(--accent,#3b82f6); background:var(--surface,#fff) }
.deft-experience button { min-height:44px; border:1px solid var(--accent,#2563eb); background:var(--accent,#2563eb); color:var(--on-primary-container,#fff); border-radius:8px; padding:10px 16px; cursor:pointer; font:inherit; font-weight:550 }
.deft-experience button:hover { filter:brightness(.97) }
.deft-experience button:focus-visible { outline:2px solid var(--accent,#3b82f6); outline-offset:2px }
.deft-experience button:disabled { cursor:default; opacity:.5 }
.deft-experience .ex-button-secondary { background:var(--surface,#fff); border-color:#cbd5e1; border-color:color-mix(in srgb,var(--foreground,#1e293b) 22%,transparent); color:var(--foreground,#334155) }
.deft-experience .ex-button-ghost { background:transparent; border-color:transparent; color:var(--foreground-secondary,#475569) }
.deft-experience .ex-button-list { width:100%; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:5px 12px; text-align:left; border:0; border-bottom:1px solid var(--border,#e2e8f0); border-radius:0; background:var(--surface,#fff); color:var(--foreground,#1e293b); padding:16px }
.deft-experience .ex-button-list:hover { background:var(--surface-container-low,#f8fafc); filter:none }
.deft-experience .ex-button-list[aria-pressed=true] { background:var(--accent-subtle,#eff6ff); box-shadow:inset 3px 0 var(--accent,#2563eb) }
.deft-experience .ex-button-description { grid-column:1/-1; color:var(--foreground-secondary,#64748b); font-weight:400; font-size:13px; white-space:pre-wrap; overflow-wrap:anywhere }
.deft-experience .ex-button-meta { color:var(--foreground-secondary,#64748b); font-size:11px; font-weight:400 }
.deft-experience .ex-button-label { overflow-wrap:anywhere }
.deft-experience .ex-button-list .ex-button-label { font-size:14px }
.deft-experience .ex-button-list .ex-button-description { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden }
.deft-experience .ex-text { margin:0; white-space:pre-wrap; overflow-wrap:anywhere }
.deft-experience .ex-text-muted { color:var(--foreground-secondary,#64748b) }
.deft-experience .ex-text-heading { font-size:24px; font-weight:650; letter-spacing:-.025em; line-height:1.3 }
.deft-experience .ex-text-caption { color:var(--foreground-secondary,#64748b); font-size:12px }
.deft-experience .ex-field { display:grid; gap:6px; min-width:0 }
.deft-experience .ex-field label { display:grid; gap:6px; color:var(--foreground-secondary,#475569); font-size:12px; font-weight:550 }
.deft-experience .ex-field input,.deft-experience .ex-field textarea { min-height:44px; border-color:#cbd5e1; border-color:color-mix(in srgb,var(--foreground,#1e293b) 22%,transparent); background:var(--surface,#fff); font-weight:400; font-size:14px }
.deft-experience .ex-field textarea { min-height:220px; resize:vertical; line-height:1.6 }
.deft-experience canvas { display:block; width:100%; height:200px; border:1px solid var(--border-default,#cbd5e1); border-radius:9px; background:var(--surface-container-low,#f8fafc); touch-action:none }
.deft-experience.ex-workspace { padding:0; height:100%; min-height:0; overflow:hidden }
.deft-experience .ex-stack-workspace { display:flex; flex-direction:column; gap:0; height:100%; min-height:0; overflow:hidden }
.deft-experience .ex-stack-workspace > .ex-stack-split { flex:1; min-height:0; grid-template-columns:clamp(340px,32%,380px) minmax(0,1fr); grid-template-rows:minmax(0,1fr); gap:0; overflow:hidden }
.deft-experience .ex-stack-sidebar { border-right:1px solid var(--border,#e2e8f0); padding:0; overflow:auto; min-height:0; gap:0; background:var(--surface,#fff) }
.deft-experience .ex-stack-document { padding:32px 40px; overflow:auto; min-height:0; gap:24px; background:var(--surface,#fff) }
.deft-experience .ex-stack-toolbar { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; padding:12px 20px; border-bottom:1px solid var(--border,#e2e8f0); position:sticky; top:0; z-index:1; flex-shrink:0; background:var(--surface,#fff) }
.deft-experience .ex-stack-toolbar > .ex-field-search { flex:1; min-width:180px; max-width:420px }
.deft-experience .ex-stack-sidebar > .ex-text { padding:12px 20px }
.deft-experience .ex-stack-sidebar > .ex-stack-list > .ex-text { padding:24px 20px 12px; font-size:14px }
.deft-experience .ex-stack-sidebar > .ex-button-ghost { justify-self:start; margin:0 8px 12px }
.deft-experience .ex-stack-sidebar > .ex-stack-horizontal { padding:12px 16px }
.deft-experience .ex-stack-sidebar > .ex-field-search { margin:12px 16px }
.deft-experience .ex-text-body { max-width:68ch; font-size:15px; line-height:1.8; color:var(--foreground,#1e293b) }
.deft-experience .ex-button-list { padding:18px 24px; gap:4px 16px; background:transparent }
.deft-experience .ex-button-list[aria-pressed=true] { background:color-mix(in srgb,var(--foreground,#1e293b) 5%,transparent); box-shadow:inset 2px 0 var(--accent,#2563eb) }
.deft-experience .ex-button-list .ex-button-label { grid-column:1/-1; font-size:14px; font-weight:500; line-height:1.5 }
.deft-experience .ex-button-eyebrow { grid-column:1; grid-row:1; font-size:12px; font-weight:650; color:var(--foreground,#1e293b); overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.deft-experience .ex-button-list .ex-button-meta { grid-column:2; grid-row:1; align-self:center }
.deft-experience .ex-button-list .ex-button-description { font-size:13px; line-height:1.6; -webkit-line-clamp:2 }
.deft-experience button:not(.ex-button-list) { display:inline-flex; align-items:center; justify-content:center; gap:8px; font-size:13px; border-radius:6px }
.deft-experience .ex-icon { width:16px; height:16px; flex-shrink:0; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round }
.deft-experience .ex-field-search label { position:relative; display:block }
.deft-experience .ex-field-search .ex-field-label,.deft-experience .ex-field-body .ex-field-label { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%) }
.deft-experience .ex-field-search .ex-icon { position:absolute; left:12px; top:14px; color:var(--foreground-secondary,#64748b) }
.deft-experience .ex-field-search input { padding-left:38px; border-color:transparent; background:var(--surface-container-low,#f8fafc) }
.deft-experience .ex-field-inline label { display:flex; align-items:center; gap:16px; border-bottom:1px solid var(--border,#e2e8f0); font-weight:400; font-size:13px }
.deft-experience .ex-field-inline .ex-field-label { flex:0 0 56px }
.deft-experience .ex-field-inline input { border:0; border-radius:0; padding:12px 0; background:transparent }
.deft-experience .ex-field-body textarea { border:0; border-radius:0; padding:12px 0; min-height:260px; font-size:15px; line-height:1.8; background:transparent }
@media(pointer:fine) and (min-width:701px) { .deft-experience button:not(.ex-button-list) { min-height:36px; padding:7px 12px } }

.deft-experience .ex-stack-toolbar > .ex-text:first-child { margin-right:auto; font-weight:600; font-size:14px }
.deft-experience .ex-stack-workspace > .ex-stack-toolbar > .ex-text:first-child { font-size:18px; letter-spacing:-.02em }
.deft-experience .ex-stack-horizontal > .ex-field-search { flex:1; min-width:0 }
.deft-experience .ex-stack-horizontal:has(> .ex-field-search) > button > .ex-icon { display:none }
.deft-experience .ex-stack-horizontal > button { flex-shrink:0 }
.deft-experience .ex-stack-document:has(> .ex-field-body) { display:flex; flex-direction:column; gap:0 }
.deft-experience .ex-stack-document:has(> .ex-field-body) > .ex-stack-toolbar { margin:-32px -40px 12px; padding:12px 24px }
.deft-experience .ex-stack-document:has(> .ex-field-body) > .ex-field-body { display:flex; flex:1; min-height:200px; margin-top:12px }
.deft-experience .ex-field-body label { display:flex; flex:1; min-height:0 }
.deft-experience .ex-field-body textarea { flex:1; height:100%; min-height:200px; resize:none }
.deft-experience .ex-stack-document:has(> .ex-field-body) > .ex-stack-horizontal:last-child { margin-top:auto; padding-top:16px; flex-shrink:0 }
.deft-experience .ex-stack-document > .ex-text-muted + .ex-text-caption { margin-top:-16px }
.deft-experience .ex-stack-document > .ex-button-ghost:has(.ex-button-description) { justify-self:start; align-items:flex-start; flex-direction:column; text-align:left; padding:8px 0; color:var(--primary,#6d5bd0) }
.deft-experience .ex-stack-document > .ex-button-ghost:has(.ex-button-description):hover .ex-button-label { text-decoration:underline; text-underline-offset:3px }
.deft-experience .ex-stack-sidebar { background:color-mix(in srgb,var(--foreground,#1e293b) 2%,var(--surface,#fff)); border-right-color:color-mix(in srgb,var(--foreground,#1e293b) 10%,transparent) }
.deft-experience .ex-stack-workspace > .ex-stack:last-child:not(.ex-stack-split):not(.ex-stack-toolbar):not(.ex-stack-sidebar):not(.ex-stack-document) { gap:0 }
.deft-experience .ex-stack-workspace > .ex-stack:last-child:not(.ex-stack-split):not(.ex-stack-toolbar):not(.ex-stack-sidebar):not(.ex-stack-document) > .ex-text:not(:empty) { padding:8px 20px; border-top:1px solid var(--border,#e2e8f0); font-size:12px }
.deft-experience .ex-text:empty { display:none }

.deft-experience .ex-mobile-only { display:none }
.deft-experience .ex-mobile-only > button { justify-self:start }
@media(max-width:700px) { .deft-experience .ex-stack-document:has(> .ex-field-body) > .ex-stack-toolbar { margin:-24px -20px 12px; padding:12px 16px } .deft-experience .ex-stack-workspace > .ex-stack-split { grid-template-columns:minmax(0,1fr); gap:0 } .deft-experience .ex-stack-document { padding:24px 20px } .deft-experience .ex-stack-sidebar { border-right:0 } .deft-experience .ex-stack-toolbar { padding:12px 16px } .deft-experience .ex-button-list { padding:16px 20px } .deft-experience.ex-workspace { padding:0 } .deft-experience { padding:16px } .deft-experience .ex-stack-split { grid-template-columns:minmax(0,1fr); gap:16px } .deft-experience .ex-stack.ex-mobile-hidden { display:none } .deft-experience .ex-mobile-only { display:grid } .deft-experience .ex-mobile-only.ex-stack-horizontal,.deft-experience .ex-mobile-only.ex-stack-toolbar,.deft-experience .ex-mobile-only.ex-stack-workspace { display:flex } .deft-experience .ex-stack-panel { padding:16px } }
@media(max-width:420px) { .deft-experience { padding:12px } .deft-experience table { min-width:510px } .deft-experience .ex-stack-title { font-size:16px } }
@container(max-width:700px) { .deft-experience .ex-stack-document:has(> .ex-field-body) > .ex-stack-toolbar { margin:-24px -20px 12px; padding:12px 16px } .deft-experience .ex-stack-workspace > .ex-stack-split { grid-template-columns:minmax(0,1fr); gap:0 } .deft-experience .ex-stack-document { padding:24px 20px } .deft-experience .ex-stack-sidebar { border-right:0 } .deft-experience .ex-stack-toolbar { padding:12px 16px } .deft-experience .ex-button-list { padding:16px 20px } .deft-experience.ex-workspace { padding:0 } .deft-experience .ex-stack-split { grid-template-columns:minmax(0,1fr); gap:16px } .deft-experience .ex-stack.ex-mobile-hidden { display:none } .deft-experience .ex-mobile-only { display:grid } .deft-experience .ex-mobile-only.ex-stack-horizontal,.deft-experience .ex-mobile-only.ex-stack-toolbar,.deft-experience .ex-mobile-only.ex-stack-workspace { display:flex } }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

const ICON_PATHS = {
  compose: 'M12 20H4V4h8 M16 3l5 5-9 9H7v-5z M14 5l5 5',
  refresh: 'M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 12-2l2 2 M4 17l2 2a7 7 0 0 0 12-2',
  search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  reply: 'M9 4l-6 6 6 6 M3 10h10a8 8 0 0 1 8 8v2',
  archive: 'M3 3h18v4H3z M5 7v14h14V7 M10 11h4',
  back: 'M15 18l-6-6 6-6',
  close: 'M6 6l12 12 M6 18L18 6',
  send: 'M22 2L9 15 M22 2l-7 20-6-7-7-6z',
} as const;

/** Only host-owned paths enter SVG; authors choose a bounded symbolic name. */
function renderIcon(name: keyof typeof ICON_PATHS): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ex-icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON_PATHS[name]); svg.append(path);
  return svg;
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
    const p = el(node.tone === 'heading' ? 'h2' : 'p', `ex-text ex-text-${node.tone ?? 'default'}`);
    p.textContent = node.text;
    return p;
  }
  if (node.kind === 'button') {
    const button = el('button', `ex-button-${node.variant ?? 'primary'}`);
    button.type = 'button';
    if (node.icon) button.append(renderIcon(node.icon));
    if (node.eyebrow !== undefined) {
      const eyebrow = el('span', 'ex-button-eyebrow'); eyebrow.textContent = node.eyebrow; button.append(eyebrow);
    }
    const label = el('span', 'ex-button-label');
    label.textContent = node.label;
    button.append(label);
    if (node.meta !== undefined) {
      const meta = el('span', 'ex-button-meta'); meta.textContent = node.meta; button.append(meta);
    }
    if (node.description !== undefined) {
      const description = el('span', 'ex-button-description');
      description.textContent = node.description; button.append(description);
    }
    if (node.selected !== undefined) button.setAttribute('aria-pressed', String(node.selected));
    button.disabled = node.disabled ?? false;
    button.dataset.focusKey = node.id;
    button.addEventListener('click', () => emit({ kind: 'click', node_id: node.id }));
    return button;
  }
  if (node.kind === 'input') {
    const wrap = el('div', `ex-field${node.appearance ? ` ex-field-${node.appearance}` : ''}`);
    const label = el('label');
    const input = node.multiline ? el('textarea') : el('input');
    input.value = node.value;
    input.placeholder = node.placeholder ?? '';
    input.dataset.focusKey = node.id;
    const labelText = el('span', 'ex-field-label'); labelText.textContent = node.label;
    label.append(labelText);
    if (node.appearance === 'search') label.append(renderIcon('search'));
    input.addEventListener('change', () => emit({ kind: 'input', node_id: node.id, value: input.value }));
    label.append(input);
    wrap.append(label);
    return wrap;
  }
  if (node.kind === 'stack') {
    const wrap = el('section', `ex-stack ex-stack-${node.layout ?? 'vertical'} ex-stack-${node.surface ?? 'plain'}${node.mobile ? ` ex-mobile-${node.mobile}` : ''}`);
    if (node.surface === 'sidebar' || node.surface === 'document') wrap.dataset.scrollKey = node.id;
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
  const scrollPositions = new Map(Array.from(container.querySelectorAll<HTMLElement>('[data-scroll-key]'))
    .map((element) => [element.dataset.scrollKey, element.scrollTop]));
  const focused = document.activeElement instanceof HTMLElement && container.contains(document.activeElement)
    ? document.activeElement.dataset.focusKey : undefined;
  const selection = (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement)
    ? { start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : undefined;
  container.classList.add('deft-experience');
  container.classList.toggle('ex-workspace', view.root.kind === 'stack' && view.root.layout === 'workspace');
  container.replaceChildren(renderNode(view.root, emit));
  container.querySelectorAll<HTMLElement>('[data-scroll-key]').forEach((element) => {
    element.scrollTop = scrollPositions.get(element.dataset.scrollKey) ?? 0;
  });
  if (focused) {
    const candidate = Array.from(container.querySelectorAll<HTMLElement>('[data-focus-key]'))
      .find((element) => element.dataset.focusKey === focused);
    candidate?.focus();
    if ((candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement) && selection?.start !== null
      && selection?.start !== undefined && selection.end !== null && selection.end !== undefined) {
      candidate.setSelectionRange(selection.start, selection.end);
    }
  }
}
