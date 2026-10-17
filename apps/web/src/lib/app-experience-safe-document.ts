import createDOMPurify from 'dompurify';
import { experienceDocumentPresentation } from './app-experience-document-presentation';

export type ExperienceDocumentContent = Readonly<{
  format: 'plain' | 'html'; content: string; truncated?: boolean;
}>;
export type ExperienceDocumentMetadata = readonly Readonly<{ label: string; value: string }>[];
export const EXPERIENCE_DOCUMENT_CONTENT_LIMIT = 16384;
export const EXPERIENCE_PRESENTATION_CONTENT_LIMIT = 256 * 1024;
export type ExperiencePresentationImage = Readonly<{ image_ref: string; kind: 'cid' | 'remote'; alt?: string }>;
export type ExperiencePresentationImageState = 'loading' | 'unavailable' | 'unsupported' | 'limit';
const tags = ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'div', 'table',
  'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'hr', 'sub', 'sup', 'center', 'font'] as const;

export function parseExperienceDocumentContent(value: unknown): ExperienceDocumentContent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['format', 'content', 'truncated'].includes(key))
    || (row.format !== 'plain' && row.format !== 'html') || typeof row.content !== 'string'
    || row.content.length > EXPERIENCE_DOCUMENT_CONTENT_LIMIT || row.content.includes('\0')
    || (row.truncated !== undefined && typeof row.truncated !== 'boolean')) return null;
  return { format: row.format as 'plain' | 'html', content: row.content,
    ...(row.truncated === undefined ? {} : { truncated: row.truncated as boolean }) };
}

export function experienceDocumentLink(value: string): string | null {
  if (!value || value.length > 4096 || /[\u0000-\u0020\u007f]/u.test(value) || /%0[ad]/iu.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function escapeExperienceDocumentText(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
}

export function sanitizeExperienceDocument(value: ExperienceDocumentContent): string {
  if (!parseExperienceDocumentContent(value)) throw Error('APP_DOCUMENT_INVALID');
  return sanitizeDocument(value, []);
}

function sanitizeDocument(value: ExperienceDocumentContent, images: readonly ExperiencePresentationImage[]): string {
  if (value.format === 'plain') return escapeExperienceDocumentText(value.content);
  if (typeof document === 'undefined' || typeof window === 'undefined') throw Error('APP_DOCUMENT_RENDERER_UNAVAILABLE');
  // Template content has an inert owner document. Untrusted images/frames never
  // enter a browsing context, including while the sanitizer parses the input.
  const template = document.createElement('template');
  template.innerHTML = value.content;
  const references = new Set(images.map(image => image.image_ref));
  for (const element of template.content.querySelectorAll<HTMLElement>('*')) {
    // No source-authored marker can nominate an image. The source service alone
    // rewrites image nodes to a manifest-bound marker; all other nodes lose it.
    element.removeAttribute('data-deft-image');
    const presentation = experienceDocumentPresentation(element);
    element.removeAttribute('style');
    if (presentation) element.setAttribute('style', presentation);
    if (element.tagName === 'IMG') {
      const marker = /^deft-image:([a-f0-9]{64})$/u.exec(element.getAttribute('src') ?? '');
      if (marker && references.has(marker[1])) {
        const slot = document.createElement('span');
        slot.setAttribute('data-deft-image', marker[1]);
        if (presentation) slot.setAttribute('style', presentation);
        slot.textContent = (element.getAttribute('alt') ?? '').slice(0, 500) || 'Message image';
        element.replaceWith(slot);
      } else element.remove();
    }
  }
  const purifier = createDOMPurify(window);
  const clean = purifier.sanitize(template.content, {
    ALLOWED_TAGS: [...tags], ALLOWED_ATTR: ['href', 'title', 'colspan', 'rowspan', 'style', 'data-deft-image'],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ['style', 'script', 'img', 'iframe', 'svg', 'math', 'form', 'input', 'video', 'audio', 'source', 'link', 'meta', 'base'],
    FORBID_ATTR: ['class', 'src', 'srcset', 'background', 'poster', 'id', 'name'],
  });
  for (const anchor of clean.querySelectorAll('a')) {
    const href = experienceDocumentLink(anchor.getAttribute('href') ?? '');
    if (href === null) anchor.removeAttribute('href');
    else { anchor.setAttribute('href', href); anchor.setAttribute('target', '_blank'); anchor.setAttribute('rel', 'noopener noreferrer'); }
  }
  for (const cell of clean.querySelectorAll('[colspan], [rowspan]')) {
    for (const key of ['colspan', 'rowspan']) {
      const attribute = cell.getAttribute(key);
      if (attribute !== null && (!/^[1-9][0-9]?$/u.test(attribute) || Number(attribute) > 32)) cell.removeAttribute(key);
    }
  }
  const wrapper = document.createElement('div'); wrapper.append(clean);
  return wrapper.innerHTML;
}

export function createExperienceDocumentElement(value: ExperienceDocumentContent): HTMLElement {
  if (!parseExperienceDocumentContent(value)) throw Error('APP_DOCUMENT_INVALID');
  return createDocumentElement(value, []);
}

// A host-only source view uses the separately reviewed original-message ceiling.
// It never enlarges the untrusted App's document leaf or wire budget.
export function createExperiencePresentationElement(value: ExperienceDocumentContent, images: readonly ExperiencePresentationImage[], imageUrls: ReadonlyMap<string, string> = new Map(), imageStates: ReadonlyMap<string, ExperiencePresentationImageState> = new Map()): HTMLElement {
  if (!value || !['plain', 'html'].includes(value.format) || typeof value.content !== 'string'
    || value.content.length > EXPERIENCE_PRESENTATION_CONTENT_LIMIT || value.content.includes('\0')
    || (value.truncated !== undefined && typeof value.truncated !== 'boolean')
    || !Array.isArray(images) || images.length > 32 || images.some(image => !image || !/^[a-f0-9]{64}$/u.test(image.image_ref)
      || !['cid', 'remote'].includes(image.kind) || (image.alt !== undefined && (typeof image.alt !== 'string' || image.alt.length > 500)))) throw Error('APP_DOCUMENT_INVALID');
  return createDocumentElement(value, images, imageUrls, imageStates);
}

function createDocumentElement(value: ExperienceDocumentContent, images: readonly ExperiencePresentationImage[], imageUrls: ReadonlyMap<string, string> = new Map(), imageStates: ReadonlyMap<string, ExperiencePresentationImageState> = new Map()): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'ex-safe-document';
  wrapper.style.cssText = 'min-width:0;max-width:100%;width:100%;box-sizing:border-box;overflow-wrap:anywhere;font:inherit;line-height:1.7';
  if (value.format === 'plain') { wrapper.textContent = value.content; wrapper.style.whiteSpace = 'pre-wrap'; }
  else wrapper.innerHTML = sanitizeDocument(value, images);
  if (images.length || value.format === 'html') {
    wrapper.style.color = '#202124'; wrapper.style.backgroundColor = '#fff';
    wrapper.style.padding = '16px'; wrapper.style.borderRadius = '12px';
  }
  for (const table of wrapper.querySelectorAll<HTMLElement>('table')) {
    table.style.minWidth = '0'; constrainMessageWidth(table);
    // Generic host tables use a workspace surface. Message tables instead
    // inherit their own sanitized presentation, including nested white layouts.
    if (!table.style.background && !table.style.backgroundColor) table.style.backgroundColor = 'transparent';
    if (!table.style.borderCollapse) table.style.borderCollapse = 'collapse';
    if (!table.parentElement?.closest('table')) {
      const scroll = document.createElement('div');
      scroll.style.cssText = 'min-width:0;max-width:100%;width:100%;overflow-x:auto';
      table.replaceWith(scroll); scroll.append(table);
    }
  }
  for (const pre of wrapper.querySelectorAll<HTMLElement>('pre')) pre.style.cssText = 'white-space:pre-wrap;max-width:100%';
  for (const anchor of wrapper.querySelectorAll<HTMLElement>('a[href]')) {
    // Safe sender-authored CTA padding/background/type remain intact.
    if (!anchor.style.color) anchor.style.color = 'inherit';
    if (!anchor.style.textDecoration) anchor.style.textDecoration = 'underline';
    anchor.style.textUnderlineOffset = '2px';
  }
  for (const slot of wrapper.querySelectorAll<HTMLElement>('[data-deft-image]')) {
    const ref = slot.getAttribute('data-deft-image')!;
    const nominated = images.find(image => image.image_ref === ref);
    const url = imageUrls.get(ref);
    if (!nominated) { slot.remove(); continue; }
    if (url && url.startsWith(`blob:${window.location.origin}/`)) {
      const image = document.createElement('img'); image.src = url;
      image.alt = nominated.alt ?? slot.textContent ?? 'Message image';
      image.referrerPolicy = 'no-referrer'; image.decoding = 'async';
      image.style.cssText = slot.style.cssText;
      if (!image.style.display) image.style.display = 'block';
      constrainMessageImage(image, true);
      slot.replaceWith(image);
    } else {
      slot.className = 'ex-message-image-placeholder';
      // Tiny tracking/spacer slots retain their size; a blocked image never
      // becomes a large warning box or an overflowing column of text.
      if (!slot.style.display) slot.style.display = 'inline-block';
      constrainMessageImage(slot, false); slot.style.boxSizing = 'border-box';
      slot.style.overflow = 'hidden';
      if (!slot.style.color) slot.style.color = '#59616d';
      if (!slot.style.fontSize) slot.style.fontSize = '12px';
      if (!slot.style.lineHeight) slot.style.lineHeight = '1.5';
      const state = imageStates.get(ref);
      const status = state === 'unavailable' ? 'Image could not be loaded'
        : state === 'unsupported' ? 'Image format is unsupported'
        : state === 'limit' ? 'Message image limit reached'
        : state === 'loading' ? 'Image loading'
        : nominated.kind === 'remote' ? 'External image blocked until you choose to load it' : 'Embedded image loading';
      const alt = nominated.alt || slot.textContent || 'Message image';
      const detail = `${alt} · ${status}`;
      slot.setAttribute('role', 'img'); slot.setAttribute('aria-label', detail);
      slot.setAttribute('title', detail);
      slot.textContent = `\u25a7 ${alt.length > 60 ? alt.slice(0, 59) + '\u2026' : alt}`;
    }
  }
  return wrapper;
}

// This expression is constructed only from already-sanitized local lengths.
// A responsive image keeps both its sender's cap and its authored aspect ratio.
function constrainMessageImage(element: HTMLElement, loaded: boolean): void {
  const {width,height} = element.style;
  if (/^\d+(?:\.\d+)?px$/u.test(width) && /^\d+(?:\.\d+)?px$/u.test(height) && Number.parseFloat(width)>0 && Number.parseFloat(height)>0) {
    element.style.aspectRatio = `${Number.parseFloat(width)} / ${Number.parseFloat(height)}`;
    element.style.height = 'auto';
  } else if (loaded && Number.parseFloat(height)!==0) element.style.height = 'auto';
  constrainMessageWidth(element);
}

function constrainMessageWidth(element: HTMLElement): void {
  const maxWidth = element.style.maxWidth;
  element.style.maxWidth = maxWidth && maxWidth!=='auto'
    ? maxWidth.endsWith('%') ? maxWidth : `min(100%, ${maxWidth})` : '100%';
}

export function buildExperiencePrintDocument(value: ExperienceDocumentContent, title = 'Document', metadata: ExperienceDocumentMetadata = []): string {
  return buildPrintMarkup(value, sanitizeExperienceDocument(value), title, metadata);
}

export function buildExperiencePresentationPrintDocument(value: ExperienceDocumentContent, title = 'Document', metadata: ExperienceDocumentMetadata = [], images: readonly ExperiencePresentationImage[] = [], imageUrls: ReadonlyMap<string, string> = new Map()): string {
  // Printing never acquires new remote authority or fetches image URLs. Only CID
  // bytes already loaded into host-owned object URLs enter the print document.
  const cidUrls = new Map(images.filter(image => image.kind === 'cid' && imageUrls.has(image.image_ref)).map(image => [image.image_ref, imageUrls.get(image.image_ref)!]));
  const body = createExperiencePresentationElement(value, images, cidUrls).outerHTML;
  return buildPrintMarkup(value, body, title, metadata, true);
}

function buildPrintMarkup(value: ExperienceDocumentContent, body: string, title: string, metadata: ExperienceDocumentMetadata, loadedImages = false): string {
  if (typeof title !== 'string' || title.length > 200 || title.includes('\0') || !Array.isArray(metadata) || metadata.length > 16 || metadata.some(row => !row || typeof row.label !== 'string' || typeof row.value !== 'string' || row.label.length > 200 || row.value.length > 2000 || row.label.includes('\0') || row.value.includes('\0'))) throw Error('APP_DOCUMENT_INVALID');
  const rows = metadata.map(row => `<p><strong>${escapeExperienceDocumentText(row.label)}:</strong> ${escapeExperienceDocumentText(row.value)}</p>`).join('');
  return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; ' + (loadedImages ? 'img-src blob:; ' : '') + 'base-uri \'none\'; form-action \'none\'">'
    + `<title>${escapeExperienceDocumentText(title)}</title><style>body{font:14px/1.6 system-ui,sans-serif;color:#111;margin:32px;overflow-wrap:anywhere}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #aaa;padding:6px}pre{white-space:pre-wrap}p{margin:0 0 12px}.plain{white-space:pre-wrap}</style></head><body>`
    + `<h1>${escapeExperienceDocumentText(title)}</h1>${rows}<div${value.format === 'plain' ? ' class="plain"' : ''}>${body}</div>`
    + (value.truncated ? '<p>Only part of this document is shown.</p>' : '') + '</body></html>';
}

export function printExperienceDocument(value: ExperienceDocumentContent, title?: string, metadata?: ExperienceDocumentMetadata): void {
  printMarkup(buildExperiencePrintDocument(value, title, metadata));
}

export function printExperiencePresentation(value: ExperienceDocumentContent, title?: string, metadata?: ExperienceDocumentMetadata, images: readonly ExperiencePresentationImage[] = [], imageUrls: ReadonlyMap<string, string> = new Map()): void {
  printMarkup(buildExperiencePresentationPrintDocument(value, title, metadata, images, imageUrls));
}

function printMarkup(markup: string): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:600px;border:0';
  frame.srcdoc = markup;
  const cleanup = () => frame.remove();
  frame.addEventListener('load', () => {
    const target = frame.contentWindow;
    if (!target) { cleanup(); return; }
    target.addEventListener('afterprint', cleanup, { once: true });
    try { target.focus(); target.print(); } catch { cleanup(); }
  }, { once: true });
  document.body.append(frame);
  window.setTimeout(cleanup, 60000);
}
