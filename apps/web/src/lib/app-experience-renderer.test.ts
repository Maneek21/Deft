import assert from 'node:assert/strict';
import test from 'node:test';
import { renderExperienceView, clearExperienceView, flushExperienceInputs, suspendExperienceView, type ExperienceUiEvent } from './app-experience-renderer';
import type { ExperienceView } from './app-experience-bridge';

// Minimal DOM seam exercises native event delivery and replacement, rather than CSS.
class Element {
  children: Element[] = []; dataset: Record<string, string> = {}; value = ''; placeholder = '';
  className = ''; textContent = ''; type = ''; disabled = false; scrollTop = 0;
  selectionStart: number | null = 0; selectionEnd: number | null = 0;
  classList = { add() {}, toggle() {} };
  listeners = new Map<string, (() => void)[]>();
  constructor(readonly tag: string) {}
  get tagName() { return this.tag.toUpperCase(); }
  get firstElementChild() { return this.children[0]; }
  replaceChild(next: Element, old: Element) { this.children[this.children.indexOf(old)] = next; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute() {}
  addEventListener(name: string, callback: () => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], callback]); }
  fire(name: string) { this.listeners.get(name)?.forEach(callback => callback()); }
  focus() { dom.activeElement = this; }
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  contains(element: Element): boolean { return this.children.some(child => child === element || child.contains(element)); }
  querySelectorAll(selector: string): Element[] {
    const children = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
    if (selector === '*') return children;
    return children.filter(child => selector === '[data-scroll-key]' ? child.dataset.scrollKey !== undefined
      : selector.startsWith('input[') ? ['input', 'textarea'].includes(child.tag) && child.dataset.focusKey !== undefined
      : child.dataset.focusKey !== undefined);
  }
}
class Input extends Element {}
class Textarea extends Element {}
const dom = { activeElement: null as Element | null,
  createElement: (tag: string) => tag === 'input' ? new Input(tag) : tag === 'textarea' ? new Textarea(tag) : new Element(tag) };
const view = (value: string): ExperienceView => ({ root: { kind: 'stack', id: 'root', children: [
  { kind: 'input', id: 'query', label: 'Query', value }, { kind: 'button', id: 'clear', label: 'Clear' },
] } });

test('native typing coalesces, preserves pending caret, flushes before clear, and retires buffers', async () => {
  const saved = new Map(['document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { document: dom, HTMLElement: Element, HTMLInputElement: Input, HTMLTextAreaElement: Textarea });
  const container = new Element('div') as unknown as HTMLElement;
  const events: ExperienceUiEvent[] = [], emit = (event: ExperienceUiEvent) => events.push(event);
  const field = () => (container as unknown as Element).querySelectorAll('input[data-focus-key]')[0]!;
  try {
    renderExperienceView(container, view(''), emit);
    const originalInput = field(); field().focus(); field().value = 'la'; field().setSelectionRange(2, 2); field().fire('input');
    renderExperienceView(container, view(''), emit);
    assert.equal(field(), originalInput, 'native input DOM identity survives view replacement'); assert.equal(field().value, 'la'); assert.equal(field().selectionStart, 2); assert.equal(dom.activeElement, originalInput);
    field().value = 'lXa'; field().setSelectionRange(2, 2); field().fire('input');
    renderExperienceView(container, view(''), emit);
    assert.equal(field(), originalInput); assert.equal(field().value, 'lXa'); assert.equal(field().selectionStart, 2);
    field().value = 'launch'; field().fire('input');
    await new Promise(resolve => setTimeout(resolve, 240));
    assert.deepEqual(events, [{ kind: 'input', node_id: 'query', value: 'launch' }]);
    field().value = 'draft'; field().fire('input');
    const button = (container as unknown as Element).querySelectorAll('[data-focus-key]').find(element => element.tag === 'button')!;
    button.fire('click');
    assert.deepEqual(events.slice(-2), [{ kind: 'input', node_id: 'query', value: 'draft' }, { kind: 'click', node_id: 'clear' }]);
    renderExperienceView(container, view(''), emit); assert.equal(field().value, '');
    renderExperienceView(container, view('loaded draft'), emit); assert.equal(field().value, 'loaded draft');
    field().value = 'last edit before hiding'; field().fire('input'); flushExperienceInputs(container);
    assert.deepEqual(events.at(-1),{kind:'input',node_id:'query',value:'last edit before hiding'});
    suspendExperienceView(container);
    renderExperienceView(container, view('loaded draft'), emit);
    assert.equal(field().value, 'last edit before hiding', 'held delivery cannot restore an older author value');
    renderExperienceView(container, view('last edit before hiding'), emit);
    field().value = 'continued typing after resume'; field().fire('input'); flushExperienceInputs(container);
    renderExperienceView(container, view('last edit before hiding'), emit);
    assert.equal(field().value, 'continued typing after resume', 'late earlier acknowledgement cannot overwrite a later flushed edit');
    renderExperienceView(container, view('continued typing after resume'), emit);
    renderExperienceView(container, view(''), emit);
    assert.equal(field().value, '', 'matching author acknowledgement releases the overlay for Clear');
    field().value = 'private pending value'; field().fire('input'); flushExperienceInputs(container);
    suspendExperienceView(container); clearExperienceView(container);
    renderExperienceView(container, view('fresh session'), emit);
    assert.equal(field().value, 'fresh session', 'terminal clearing while suspended removes every old-session overlay');
    field().value = 'must retire'; field().fire('input'); clearExperienceView(container);
    const count = events.length; await new Promise(resolve => setTimeout(resolve, 240)); assert.equal(events.length, count);
  } finally {
    clearExperienceView(container); dom.activeElement = null;
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});
