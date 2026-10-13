import assert from 'node:assert/strict';
import test from 'node:test';
import { renderExperienceView, clearExperienceView, flushExperienceInputs, suspendExperienceView, type ExperienceUiEvent } from './app-experience-renderer';
import type { ExperienceView } from './app-experience-bridge';

// Minimal DOM seam exercises native event delivery and replacement, rather than CSS.
class Element {
  children: Element[] = []; dataset: Record<string, string> = {}; value = ''; placeholder = '';
  className = ''; textContent = ''; type = ''; disabled = false; scrollTop = 0;
  style: Record<string,string> = {};
  selectionStart: number | null = 0; selectionEnd: number | null = 0;
  classList = { add() {}, toggle() {} };
  listeners = new Map<string, (() => void)[]>();
  constructor(readonly tag: string) {}
  get tagName() { return this.tag.toUpperCase(); }
  get firstElementChild() { return this.children[0]; }
  replaceChild(next: Element, old: Element) { this.children[this.children.indexOf(old)] = next; }
  append(...children: Element[]) { this.children.push(...children); }
  prepend(...children: Element[]) { this.children.unshift(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  attributes = new Map<string,string>();
  setAttribute(name:string,value:string) { this.attributes.set(name,value); }
  removeAttribute(name:string) { this.attributes.delete(name); }
  getAttribute(name:string) { return this.attributes.get(name) ?? null; }
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

test('trusted field mounts are negotiated and callbacks are fenced on replacement, suspension and clear',()=>{
  const saved=new Map(['document','HTMLElement','HTMLInputElement','HTMLTextAreaElement'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  Object.assign(globalThis,{document:dom,HTMLElement:Element,HTMLInputElement:Input,HTMLTextAreaElement:Textarea});
  try{
    const container=new Element('div') as unknown as HTMLElement,contexts:Array<{signal:AbortSignal;current:()=>boolean}>=[];
    let mounts=0,disposed=0;const selected:ExperienceView={schema_version:'deft.experience_view.v2',capabilities:['richtext_field.v1'],root:{kind:'richtext_field',id:'body',label:'Body',
      profile:{profile_version:'deft.richtext_field.v1',format:'safe_compose_html',max_characters:4096,max_bytes:16384,links:'host_validated',inline_images:'none'},value:{html:'<p>  text</p>',plain_text:'  text'}}};
    const options={capabilities:['richtext_field.v1'] as const,mountControl:(_node:unknown,_wrap:HTMLElement,_emit:unknown,context:{signal:AbortSignal;current:()=>boolean})=>{mounts++;contexts.push(context);return()=>{disposed++;};}};
    renderExperienceView(container,selected,()=>{},options);assert.equal(mounts,1);assert.equal(contexts[0].current(),true);
    renderExperienceView(container,selected,()=>{},options);assert.equal(disposed,1);assert.equal(contexts[0].current(),false);assert.equal(contexts[0].signal.aborted,true);
    suspendExperienceView(container);assert.equal(contexts[1].current(),false);assert.equal(disposed,2);
    renderExperienceView(container,selected,()=>{},options);clearExperienceView(container);assert.equal(disposed,3);assert.equal(contexts[2].signal.aborted,true);
    renderExperienceView(container,selected,()=>{},{});assert.equal(mounts,3);
    renderExperienceView(container,{...selected,root:{...selected.root,value:{html:'<p>other</p>',plain_text:'different'}}} as ExperienceView,()=>{},options);assert.equal(mounts,3);
  }finally{for(const [key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});

test('resource documents resolve through the host, reject late bodies and dispose on suspension and clear', async () => {
  const saved = new Map(['document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { document: dom, HTMLElement: Element, HTMLInputElement: Input, HTMLTextAreaElement: Textarea });
  const container = new Element('div') as unknown as HTMLElement;
  const recordId = '11111111-1111-4111-8111-111111111111';
  const resourceView: ExperienceView = { schema_version: 'deft.experience_view.v2', capabilities: ['resource_document.v1'],
    root: { kind: 'resource_document', id: 'body', profile_version: 'deft.resource_document.v1', resource_key: 'messages', record_id: recordId } };
  let resolve!: (document: Extract<ExperienceView['root'], { kind: 'document' }>) => void;
  const body = { kind: 'document' as const, id: 'resolved_body', format: 'plain' as const, content: '<script>literal body</script>' };
  let signal!: AbortSignal, disposed = 0, enhanced = 0;
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    const options = { capabilities: ['resource_document.v1'] as const, resourceKeys: ['messages'],
      resolveResourceDocument: async (node: any, context: any) => {
        assert.equal(node.record_id, recordId); assert.equal(node.resource_key, 'messages'); signal = context.signal;
        return new Promise<Extract<ExperienceView['root'], { kind: 'document' }>>(done => { resolve = done; });
      },
      enhanceResourceDocument: (_node: any, resolved: any, wrapper: HTMLElement, context: any) => {
        assert.equal(resolved.content, body.content); assert.equal(context.current(), true);
        assert.equal((wrapper as unknown as Element).children[0].textContent, body.content);
        enhanced++; return () => { disposed++; };
      } };
    renderExperienceView(container, resourceView, () => undefined, options); await tick();
    const retired = (container as unknown as Element).children[0];
    renderExperienceView(container, view('New view'), () => undefined);
    assert.equal(signal.aborted, true); resolve(body); await tick();
    assert.equal(enhanced, 0); assert.equal(retired.textContent, 'Loading document…');
    renderExperienceView(container, resourceView, () => undefined, options); await tick(); resolve(body); await tick();
    assert.equal(enhanced, 1); suspendExperienceView(container); assert.equal(signal.aborted, true); assert.equal(disposed, 1);
    renderExperienceView(container, resourceView, () => undefined, options); await tick(); resolve(body); await tick();
    clearExperienceView(container); assert.equal(disposed, 2); clearExperienceView(container); assert.equal(disposed, 2);
    renderExperienceView(container, resourceView, () => undefined); assert.equal((container as unknown as Element).children.length, 0);
  } finally {
    clearExperienceView(container);
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});

test('native click acknowledges authority wait immediately and unlocks after failure without changing body', async () => {
  const saved=new Map(['document','HTMLElement','HTMLInputElement','HTMLTextAreaElement'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  Object.assign(globalThis,{document:dom,HTMLElement:Element,HTMLInputElement:Input,HTMLTextAreaElement:Textarea});
  const container=new Element('div') as unknown as HTMLElement;
  let reject!: (reason: Error) => void;
  const pending=new Promise<void>((_resolve,fail)=>{reject=fail;});
  try {
    renderExperienceView(container,view('Kept text'),()=>pending);
    const nodes=(container as unknown as Element).querySelectorAll('[data-focus-key]');
    const button=nodes.find(node=>node.tag==='button')!; const input=nodes.find(node=>node.tag==='input')!;
    button.fire('click'); assert.equal(button.disabled,true); assert.equal(button.getAttribute('aria-busy'),'true'); assert.equal(input.value,'Kept text');
    reject(Error('APP_STALE')); await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(button.disabled,false); assert.equal(button.getAttribute('aria-busy'),null); assert.equal(input.value,'Kept text');
  } finally { clearExperienceView(container);for(const[key,descriptor]of saved)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key); }
});

test('resource print controls never print cached private bytes without current host authority', async () => {
  const saved = new Map(['document', 'window', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let frames = 0, prints = 0, opened = 0, denied = 0;
  const printDom = { ...dom, body: { append(frame: Element) { frame.fire('load'); } },
    createElement(tag: string) {
      const element = dom.createElement(tag);
      if (tag === 'iframe') {
        frames++;
        Object.assign(element, { contentWindow: { addEventListener() {}, focus() {}, print() { prints++; } } });
      }
      return element;
    } };
  Object.assign(globalThis, { document: printDom, window: { open() { opened++; }, setTimeout() { return 0; } },
    HTMLElement: Element, HTMLInputElement: Input, HTMLTextAreaElement: Textarea });
  const container = new Element('div') as unknown as HTMLElement;
  try {
    for (const linked of [false, true]) for (const rejected of [false, true]) {
      const resource = { kind: 'resource_document' as const, id: 'body', profile_version: 'deft.resource_document.v1' as const,
        resource_key: 'messages', record_id: '11111111-1111-4111-8111-111111111111', printable: true,
        ...(linked ? { print_control_id: 'print_body' } : {}) };
      const current: ExperienceView = { schema_version: 'deft.experience_view.v2', capabilities: ['resource_document.v1'],
        root: linked ? { kind: 'stack', id: 'root', children: [{ kind: 'button', id: 'print_body', label: 'Print' }, resource] } : resource };
      renderExperienceView(container, current, () => assert.fail('Printing must not emit an app action'), {
        capabilities: ['resource_document.v1'], resourceKeys: ['messages'],
        resolveResourceDocument: async () => ({ kind: 'document', id: 'resolved', format: 'plain', content: 'Private cached body' }),
        ...(rejected ? { printDocument: () => { denied++; return false; } } : {}),
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      const button = (container as unknown as Element).querySelectorAll('*').find(element => element.tag === 'button');
      assert.ok(button); button.fire('click');
      assert.equal(frames, 0); assert.equal(prints, 0); assert.equal(opened, 0);
    }
    assert.equal(denied, 2, 'Both direct and linked controls defer to the host denial');
    // Exercise the real print sink too: legacy authored documents retain their
    // ordinary printable fallback, proving the frame/print spies are live.
    renderExperienceView(container, { root: { kind: 'document', id: 'legacy', format: 'plain', content: 'Authored receipt', printable: true } }, () => undefined);
    (container as unknown as Element).querySelectorAll('*').find(element => element.tag === 'button')!.fire('click');
    assert.equal(frames, 1); assert.equal(prints, 1); assert.equal(opened, 0);
  } finally {
    clearExperienceView(container);
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});

test('linked native print uses only current validated view and never emits an App event', () => {
 const saved=new Map(['document','HTMLElement','HTMLInputElement','HTMLTextAreaElement'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 Object.assign(globalThis,{document:dom,HTMLElement:Element,HTMLInputElement:Input,HTMLTextAreaElement:Textarea});
 const container=new Element('div') as unknown as HTMLElement; let prints=0,events=0;
 const document={kind:'document' as const,id:'body',format:'plain' as const,content:'Current receipt',printable:true,print_control_id:'print_body'};
 const current:ExperienceView={root:{kind:'stack',id:'root',children:[{kind:'button',id:'print_body',label:'Print'},document]}};
 try {
  const options={printDocument:(node:{content:string})=>{assert.equal(node.content,'Current receipt');prints++;return true;}};
  renderExperienceView(container,current,()=>{events++;},options);
  const button=(container as unknown as Element).querySelectorAll('[data-focus-key]').find(node=>node.tag==='button')!;
  button.fire('click');assert.equal(prints,1);assert.equal(events,0);
  renderExperienceView(container,view('different document'),()=>{events++;});button.fire('click');assert.equal(prints,1,'retired print controls cannot print a stale snapshot');
  renderExperienceView(container,{root:document},()=>{events++;},options);assert.equal((container as unknown as Element).children.length,0,'mismatched linked view fails closed');
 }finally{clearExperienceView(container);for(const[key,descriptor]of saved)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
});

test('plain document rendering uses literal text and never creates executable or remote media elements',()=>{
 const saved=new Map(['document','HTMLElement','HTMLInputElement','HTMLTextAreaElement'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 Object.assign(globalThis,{document:dom,HTMLElement:Element,HTMLInputElement:Input,HTMLTextAreaElement:Textarea});
 const container=new Element('div') as unknown as HTMLElement,content='<img src="https://tracker.example.test/pixel" onerror="alert(1)"><script>alert(1)</script>\nSecond line';
 try{
  renderExperienceView(container,{root:{kind:'document',id:'body',format:'plain',content,truncated:true}},()=>undefined);
  const nodes=(container as unknown as Element).querySelectorAll('*');assert.equal(nodes.find(node=>node.className==='ex-safe-document')?.textContent,content);
  assert.equal(nodes.some(node=>['img','script','iframe','a'].includes(node.tag)),false);assert.ok(nodes.some(node=>/partial|truncat|part/i.test(node.textContent)));
 }finally{clearExperienceView(container);for(const [key,descriptor]of saved)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
});

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


test('closed select/check/more icons render native buttons and retain metadata-only click routing',async()=>{
 const original=globalThis.document;Object.assign(globalThis,{document:{...dom,createElementNS:(_namespace:string,tag:string)=>new Element(tag)},HTMLElement:Element,HTMLInputElement:Input,HTMLTextAreaElement:Textarea});
 const container=new Element('div') as unknown as HTMLElement,events:ExperienceUiEvent[]=[];
 try{for(const icon of ['select','check','more'] as const){
  renderExperienceView(container,{root:{kind:'button',id:'selection',label:'Select record',variant:'list',eyebrow:'Sender',meta:'Today',description:'Snippet',icon,selected:icon==='check'}},event=>{events.push(event);});
  const button=(container as unknown as Element).querySelectorAll('*').find(element=>element.tag==='button')!;
  const svg=button.children.find(element=>element.tag==='svg')!;assert.equal(svg.getAttribute('aria-hidden'),'true');assert.ok(svg.children[0].getAttribute('d'));assert.equal(button.dataset.icon,icon);assert.equal(button.getAttribute('aria-pressed'),String(icon==='check'));
  button.fire('click');await Promise.resolve();assert.deepEqual(events.at(-1),{kind:'click',node_id:'selection'});
 }}finally{clearExperienceView(container);Object.assign(globalThis,{document:original});}
});

test('toolbar buttons retain descriptions and disabled reasons as tooltips without expanding compact labels',()=>{
 const original=globalThis.document;Object.assign(globalThis,{document:dom,HTMLElement:Element,HTMLInputElement:Input,HTMLTextAreaElement:Textarea});
 const container=new Element('div') as unknown as HTMLElement;
 try{for(const disabled of [false,true]){
  renderExperienceView(container,{root:{kind:'stack',id:'toolbar',layout:'toolbar',children:[{kind:'button',id:'compose',label:'Compose',description:disabled?'Choose a connected account first.':'Start a new message.',disabled},{kind:'button',id:'row',label:'Saved message',variant:'list',description:'Keep this visible snippet.'}]}},()=>{});
  const buttons=(container as unknown as Element).querySelectorAll('*').filter(element=>element.tag==='button');
  assert.equal(buttons[0].children.some(child=>child.className==='ex-button-description'),false);assert.equal(buttons[0].getAttribute('aria-description'),disabled?'Choose a connected account first.':'Start a new message.');assert.equal((buttons[0] as unknown as HTMLButtonElement).title,`Compose: ${buttons[0].getAttribute('aria-description')}`);assert.equal(buttons[0].disabled,disabled);
  assert.equal(buttons[1].children.find(child=>child.className==='ex-button-description')?.textContent,'Keep this visible snippet.');
 }
 renderExperienceView(container,{root:{kind:'button',id:'card',label:'Message card',description:'Keep the card description.'}},()=>{});assert.equal((container as unknown as Element).querySelectorAll('*').find(child=>child.className==='ex-button-description')?.textContent,'Keep the card description.');
 }finally{clearExperienceView(container);Object.assign(globalThis,{document:original});}
});
