// Only local presentation values survive. No CSS source is inserted into a
// stylesheet, and no positioning, generated content, URL or inherited class
// authority crosses the message boundary.
const colour = /^(?:#[a-f0-9]{3,8}|(?:rgb|rgba)\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)|black|white|gray|grey|red|green|blue|navy|transparent|currentcolor)$/iu;
const size = /^(?:0|(?:\d{1,3}(?:\.\d{1,2})?)(?:px|pt|em|rem|%))$/u;
const sizing = (value: string) => size.test(value) && Number.parseFloat(value) <= (value.endsWith('%') ? 100 : value.endsWith('em') ? 40 : 960);
const spacing = (value: string) => value.split(/\s+/u).length <= 4 && value.split(/\s+/u).every(part => size.test(part) && Number.parseFloat(part) <= (part.endsWith('em') ? 8 : 80));
const choices: Record<string, readonly string[]> = {
  'display': ['none', 'block', 'inline', 'inline-block', 'table', 'table-row', 'table-cell'],
  'visibility': ['visible', 'hidden'],
  'text-align': ['left', 'right', 'center', 'justify', 'start', 'end'],
  'vertical-align': ['top', 'middle', 'bottom', 'baseline'],
  'font-weight': ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900'],
  'font-style': ['normal', 'italic', 'oblique'],
  'text-decoration': ['none', 'underline', 'line-through'],
  'border-collapse': ['collapse', 'separate'],
  'table-layout': ['auto', 'fixed'],
  'white-space': ['normal', 'pre-wrap', 'pre-line'],
};

export function experienceDocumentStyleValue(property: string, raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (value.length > 180 || /[\\@{};!<>]|(?:url|var|expression|image|attr)\s*\(/iu.test(value)) return null;
  if (Object.hasOwn(choices, property)) return choices[property].includes(value) ? value : null;
  if (['color', 'background', 'background-color', 'border-color'].includes(property)) return colour.test(value) ? value : null;
  if (['width', 'max-width', 'height', 'max-height'].includes(property)) return value === 'auto' || sizing(value) ? value : null;
  if (property === 'font-size') return value === '0' ? '0px' : size.test(value) && Number.parseFloat(value) >= 0 && Number.parseFloat(value) <= 48 && /(?:px|pt)$/u.test(value) ? value : null;
  if (property === 'line-height') {
    if (/^(?:[0-3](?:\.\d{1,2})?|4(?:\.0+)?)$/u.test(value)) return value;
    if (size.test(value) && Number.parseFloat(value) <= (/(?:em|rem)$/u.test(value) ? 4 : value.endsWith('%') ? 300 : 96)) return value;
    return null;
  }
  if (/^margin(?:-(?:top|right|bottom|left))?$/u.test(property)) return value.split(/\s+/u).length<=4 && value.split(/\s+/u).every(part=>part==='auto'||spacing(part)) ? value : null;
  if (/^padding(?:-(?:top|right|bottom|left))?$/u.test(property)) return spacing(value) ? value : null;
  if (/^border(?:-(?:top-left|top-right|bottom-left|bottom-right))?-radius$/u.test(property)) return spacing(value) ? value : null;
  if (property === 'border-spacing') return spacing(value) ? value : null;
  if (/^border(?:-(?:top|right|bottom|left))?$/u.test(property)) {
    const parts = value.split(/\s+/u);
    return parts.length === 3 && /^(?:0|[1-4]px)$/u.test(parts[0]) && ['solid', 'dashed', 'dotted', 'none'].includes(parts[1]) && colour.test(parts[2]) ? value : null;
  }
  if (property === 'font-family') {
    // A small local fallback vocabulary never invokes downloadable fonts.
    return /^(?:arial|helvetica|verdana|georgia|times new roman|courier new|sans-serif|serif|monospace|system-ui)(?:\s*,\s*(?:arial|helvetica|verdana|georgia|times new roman|courier new|sans-serif|serif|monospace|system-ui))*$/u.test(value.replace(/["']/gu, '')) ? value.replace(/["']/gu, '') : null;
  }
  return null;
}

export function experienceDocumentPresentation(element: HTMLElement): string {
  const accepted = new Map<string, string>();
  for (const property of Array.from(element.style)) {
    const value = experienceDocumentStyleValue(property, element.style.getPropertyValue(property));
    if (value !== null) accepted.set(property === 'background' ? 'background-color' : property, value);
  }
  for (const [attribute, property] of [['bgcolor', 'background-color'], ['align', 'text-align'], ['valign', 'vertical-align'], ['width', 'width'], ['height', 'height']] as const) {
    const raw = element.getAttribute(attribute);
    if (raw === null || accepted.has(property)) continue;
    const candidate = /^\d{1,3}$/u.test(raw) && ['width', 'height'].includes(property) ? `${raw}px` : raw;
    const value = experienceDocumentStyleValue(property, candidate);
    if (value !== null) accepted.set(property, value);
  }
  if (element.tagName === 'CENTER' && !accepted.has('text-align')) accepted.set('text-align', 'center');
  if (element.tagName === 'FONT') {
    for (const [attribute, property] of [['color','color'],['face','font-family']] as const) {
      const value = experienceDocumentStyleValue(property, element.getAttribute(attribute) ?? '');
      if (value !== null && !accepted.has(property)) accepted.set(property, value);
    }
    const fontSize = element.getAttribute('size');
    if (fontSize && /^[1-7]$/u.test(fontSize) && !accepted.has('font-size')) accepted.set('font-size', `${[10,13,16,18,24,32,48][Number(fontSize)-1]}px`);
  }
  if (element.tagName === 'TABLE') {
    if (element.getAttribute('align')?.toLowerCase()==='center') {
      if (!accepted.has('margin')&&!accepted.has('margin-left')) accepted.set('margin-left','auto');
      if (!accepted.has('margin')&&!accepted.has('margin-right')) accepted.set('margin-right','auto');
    }
    const padding = element.getAttribute('cellpadding');
    const spacingValue = element.getAttribute('cellspacing');
    if (spacingValue && /^\d{1,2}$/u.test(spacingValue) && Number(spacingValue) <= 32) accepted.set('border-spacing', `${spacingValue}px`);
    if (padding && /^\d{1,2}$/u.test(padding) && Number(padding) <= 32) {
      for (const cell of element.querySelectorAll<HTMLElement>('td,th')) if (cell.closest('table') === element && !cell.style.padding) cell.style.padding = `${padding}px`;
    }
  }
  return [...accepted].map(([property, value]) => `${property}:${value}`).join(';');
}
