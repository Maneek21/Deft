import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const h=await import(process.env.EMAIL_NATIVE_BUDGET_BASELINE?pathToFileURL(process.env.EMAIL_NATIVE_BUDGET_BASELINE).href:new URL('../src/safe-compose-html.js',import.meta.url).href);
const doc=(text:string)=>({type:'doc',content:[{type:'paragraph',content:[{type:'text',text}]}]});

test('native 20/96/220 KiB text enters rich mode and preserves exact text while legacy limits stay fixed',()=>{
 for(const size of [20,96,220]){
  const text='x'.repeat(size*1024),html=h.plainTextToNativeComposeHtml(text),pair=h.nativeSafeComposeHtmlFromEditorDocument(doc(text));
  assert.equal(html,pair.html);assert.equal(pair.plainText,text);assert.deepEqual(h.parseNativeSafeComposeHtml(html),pair);
  assert.throws(()=>h.plainTextToSafeComposeHtml(text));assert.throws(()=>h.parseSafeComposeHtml(html));assert.throws(()=>h.safeComposeHtmlFromEditorDocument(doc(text)));
 }
});

test('native newline/indentation/tab/entity/link projection remains exact under larger budget',()=>{
 const text='  line\t  \n\n'+ '<&>'.repeat(12000),html=h.plainTextToNativeComposeHtml(text);
 assert.equal(h.parseNativeSafeComposeHtml(html).plainText,text);
 const body='x'.repeat(20000),linked=`<p><a href="https://intranet.test/guide"><strong>${body}</strong></a></p>`;
 assert.equal(h.parseNativeSafeComposeHtml(linked).plainText,body+' (https://intranet.test/guide)');
 assert.throws(()=>h.parseNativeSafeComposeHtml(linked,{maxCharacters:16384,maxBytes:65536}));
});

test('native character and byte upper bounds remain finite; smaller signature profile and legacy caller options remain closed',()=>{
 const exact='<p>'+'a'.repeat(262137)+'</p>';assert.equal(exact.length,262144);assert.equal(h.parseNativeSafeComposeHtml(exact).plainText.length,262137);
 assert.throws(()=>h.parseNativeSafeComposeHtml('<p>'+'a'.repeat(262138)+'</p>'));
 assert.throws(()=>h.parseNativeSafeComposeHtml('<p>x</p>',{maxCharacters:262145}));
 assert.throws(()=>h.parseNativeSafeComposeHtml('<p>x</p>',{maxBytes:491521}));
 const unicode='<p>'+'😀'.repeat(123000)+'</p>';assert.equal(unicode.length<262144,true);assert.equal(Buffer.byteLength(unicode)>491520,true);assert.throws(()=>h.parseNativeSafeComposeHtml(unicode));
 assert.throws(()=>h.parseSafeComposeHtml('<p>x</p>',{maxCharacters:20000}));
 assert.throws(()=>h.nativeComposeDraftFromEditorDocument(doc('x'.repeat(262144))));
});

test('native token/converter/depth bounds allow ordinary long paragraphs and reject pathological trees',()=>{
 const html='<p>x</p>'.repeat(5461),tree={type:'doc',content:Array.from({length:2500},()=>({type:'paragraph',content:[{type:'text',text:'ordinary text '.repeat(5)}]}))};
 assert.equal(h.parseNativeSafeComposeHtml(html).plainText.split('\n').length,5461);
 assert.equal(h.nativeSafeComposeHtmlFromEditorDocument(tree).plainText.split('\n').length,2500);
 assert.throws(()=>h.parseNativeSafeComposeHtml('<p>x</p>'.repeat(5462)));
 assert.throws(()=>h.nativeComposeDraftFromEditorDocument({type:'doc',content:Array.from({length:16384},()=>({type:'paragraph'}))}));
 let nested='<p>x</p>';for(let n=0;n<9;n++)nested='<ul><li>'+nested+'</li></ul>';assert.throws(()=>h.parseNativeSafeComposeHtml(nested));
 assert.throws(()=>h.parseSafeComposeHtml('<p>x</p>'.repeat(1000)));
});

test('native rich cap cannot weaken URL/attribute/tree validation or drop a link destination to fit plain cap',()=>{
 for(const html of ['<p><a href="javascript:alert(1)">bad</a></p>','<p onclick="x">bad</p>','<p><a href="https://example.test/" target="_blank">bad</a></p>'])assert.throws(()=>h.parseNativeSafeComposeHtml(html));
 // URL expansion is part of the plain contract, never truncated or omitted.
 const short='<p><a href="https://example.test/">Guide</a></p>';assert.equal(h.parseNativeSafeComposeHtml(short).plainText,'Guide (https://example.test/)');
 const tree={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'x'.repeat(262140),marks:[{type:'link',attrs:{href:'https://example.test/'}}]}]}]};
 assert.throws(()=>h.nativeSafeComposeHtmlFromEditorDocument(tree));
});


test('native serialization stops at the finite output budget before traversing the remaining large link rows',()=>{
 let visited=0;const href='https://example.test/'+'x'.repeat(4000),content=Array.from({length:5000},()=>({type:'paragraph',content:[{type:'text',get text(){visited++;return 'item';},marks:[{type:'link',attrs:{href}}]}]}));
 assert.throws(()=>h.nativeSafeComposeHtmlFromEditorDocument({type:'doc',content}));assert.ok(visited<500,'bounded serializer must stop instead of materializing all output');
});
