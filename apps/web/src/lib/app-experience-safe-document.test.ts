import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseExperienceDocumentContent, experienceDocumentLink, escapeExperienceDocumentText, buildExperiencePrintDocument } from './app-experience-safe-document';

test('document contract is closed and bounded with optional truncation', () => {
  assert.deepEqual(parseExperienceDocumentContent({ format: 'html', content: '<p>Body</p>' }), { format: 'html', content: '<p>Body</p>' });
  for (const value of [{ format: 'html', content: 'x', safe: true }, { format: 'html', content: 'x'.repeat(16385) }, { format: 'html', content: 'a\0b' }, { format: 'html', content: 'x', truncated: 'false' }, { format: 'markdown', content: 'x' }, { format: { toString: () => 'plain' }, content: 'x' }]) assert.equal(parseExperienceDocumentContent(value), null);
});
test('links are explicit absolute web/mail addresses without credentials or controls', () => {
  assert.equal(experienceDocumentLink('https://example.test/path?q=1'), 'https://example.test/path?q=1');
  assert.equal(experienceDocumentLink('mailto:person@example.test'), 'mailto:person@example.test');
  for (const value of ['javascript:alert(1)', 'data:text/html,body', '//example.test', '/workspace', ' https://example.test', 'https://user:pass@example.test', 'mailto:person@example.test?body=%0aevil', 'https://example.test\n']) assert.equal(experienceDocumentLink(value), null);
});
test('plain print escapes content/metadata and prevents remote/script/form access', () => {
  const html = buildExperiencePrintDocument({ format: 'plain', content: '<script>bad</script>', truncated: true }, '<img>', [{ label: 'From', value: '<sender>' }]);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/u);
  assert.match(html, /default-src 'none'/u);
  assert.match(html, /&lt;sender&gt;/u);
  assert.match(html, /Only part/u);
  assert.ok(!html.includes('<script>') && !html.includes('<img>'));
  assert.equal(escapeExperienceDocumentText('"<&'), '&quot;&lt;&amp;');
});

import {createExperiencePresentationElement} from './app-experience-safe-document';

// The existing host fixture exercises post-sanitizer presentation. Full
// DOMPurify/browser layout acceptance is separately performed in live Chrome.
function presentationStyle():Record<string,string>{
 const style:Record<string,string>={};Object.defineProperty(style,'cssText',{get:()=>Object.entries(style).map(([key,value])=>`${key.replace(/[A-Z]/gu,c=>'-'+c.toLowerCase())}:${value}`).join(';'),set:(text:string)=>{for(const key of Object.keys(style))delete style[key];for(const row of text.split(';')){const at=row.indexOf(':');if(at>0)style[row.slice(0,at).replace(/-([a-z])/gu,(_,c:string)=>c.toUpperCase())]=row.slice(at+1);}},configurable:true});return style;
}
class PresentationElement {
 style:Record<string,string>=presentationStyle(); attributes:Record<string,string>={}; className='';textContent='';src='';alt='';referrerPolicy='';decoding=''; replacement:PresentationElement|null=null;parentElement:{closest:()=>unknown}|null=null;tables:PresentationElement[]=[];slots:PresentationElement[]=[];anchors:PresentationElement[]=[];
 setAttribute(k:string,v:string){this.attributes[k]=v;if(k==='style')this.style.cssText=v;}
 getAttribute(k:string){return this.attributes[k]??null;}
 removeAttribute(k:string){delete this.attributes[k];}
 querySelectorAll(q:string){return q==='[data-deft-image]'?this.slots:q==='a[href]'?this.anchors:q==='table'?this.tables:[];}
 replaceWith(v:PresentationElement){this.replacement=v;}
 remove(){}
}
function renderFixture(slot?:PresentationElement,anchor?:PresentationElement,loaded=false,state?:'loading'|'unavailable',table?:PresentationElement){
 const wrapper=new PresentationElement();if(slot)wrapper.slots=[slot];if(anchor)wrapper.anchors=[anchor];if(table)wrapper.tables=[table];
 const oldDocument=globalThis.document,oldWindow=globalThis.window;const created:PresentationElement[]=[];
 Object.assign(globalThis,{document:{createElement:(name:string)=>{const node=name==='div'?wrapper:new PresentationElement();created.push(node);return node;}},window:{location:{origin:'https://deft.test'}}});
 const ref='a'.repeat(64);
 try{createExperiencePresentationElement({format:'plain',content:'Newsletter'},slot?[{image_ref:ref,kind:'remote',alt:'Summer collection'}]:[],new Map(loaded?[[ref,'blob:https://deft.test/image']]:[]),new Map(state?[[ref,state]]:[]));return{wrapper,created};}
 finally{Object.assign(globalThis,{document:oldDocument,window:oldWindow});}
}
test('safe CTA anchor presentation survives default link decoration',()=>{
 const anchor=new PresentationElement();anchor.style={cssText:'background-color:#222;padding:12px 24px;color:#fff;font-size:16px;line-height:24px',backgroundColor:'#222',padding:'12px 24px',color:'#fff',fontSize:'16px',lineHeight:'24px'};
 renderFixture(undefined,anchor);assert.ok(anchor.style.cssText.includes('background-color:#222'));assert.ok(anchor.style.cssText.includes('padding:12px 24px'));assert.equal(anchor.style.color,'#fff');assert.equal(anchor.style.textDecoration,'underline');
});
test('loaded owned image keeps sanitized width and height instead of expanding to its natural size',()=>{
 const slot=new PresentationElement();slot.setAttribute('data-deft-image','a'.repeat(64));slot.setAttribute('style','width:240px;height:120px;margin:8px;vertical-align:middle');
 renderFixture(slot,undefined,true);const image=slot.replacement!;assert.equal(image.src,'blob:https://deft.test/image');assert.ok(image.style.cssText.includes('width:240px'));assert.equal(image.style.height,'auto');assert.equal(image.style.aspectRatio,'240 / 120');assert.equal(image.alt,'Summer collection');assert.equal(image.referrerPolicy,'no-referrer');
});
test('blocked/loading/failed image slots use compact truthful text with accessible detail',()=>{
 for(const state of [undefined,'loading','unavailable'] as const){const slot=new PresentationElement();slot.setAttribute('data-deft-image','a'.repeat(64));slot.setAttribute('style','width:240px;height:120px');renderFixture(slot,undefined,false,state);assert.ok(slot.style.cssText.includes('width:240px'));assert.ok(!slot.style.cssText.includes('padding:16px'));assert.ok(slot.textContent.length<50);assert.ok((slot.getAttribute('title')??'').includes(state==='loading'?'loading':state==='unavailable'?'could not be loaded':'blocked'));}
});

test('tracking/spacer slots stay one pixel and unstyled links inherit local foreground',()=>{
 const slot=new PresentationElement();slot.setAttribute('data-deft-image','a'.repeat(64));slot.setAttribute('style','width:1px;height:1px;display:none');
 const anchor=new PresentationElement();renderFixture(slot,anchor);assert.ok(slot.style.cssText.includes('width:1px'));assert.equal(slot.style.height,'auto');assert.equal(slot.style.aspectRatio,'1 / 1');assert.ok(slot.style.cssText.includes('display:none'));assert.equal(slot.style.overflow,'hidden');assert.equal(anchor.style.color,'inherit');
});

test('responsive image and blocked slot retain a smaller authored max-width and ratio',()=>{
 for(const loaded of [false,true]){const slot=new PresentationElement();slot.setAttribute('data-deft-image','a'.repeat(64));slot.setAttribute('style','width:600px;height:300px;max-width:120px');renderFixture(slot,undefined,loaded);const node=loaded?slot.replacement!:slot;assert.equal(node.style.maxWidth,'min(100%, 120px)');assert.equal(node.style.aspectRatio,'600 / 300');assert.equal(node.style.height,'auto');}
});

test('newsletter tables preserve authored width cap while retaining horizontal scroll safety',()=>{
 const table=new PresentationElement();table.parentElement={closest:()=>({})};table.setAttribute('style','width:100%;max-width:540px;height:120px');renderFixture(undefined,undefined,false,undefined,table);assert.equal(table.style.maxWidth,'min(100%, 540px)');assert.equal(table.style.height,'120px');assert.equal(table.style.minWidth,'0');
});
