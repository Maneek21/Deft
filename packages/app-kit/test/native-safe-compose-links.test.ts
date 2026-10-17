import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalNativeComposeLink,parseNativeSafeComposeHtml,nativeSafeComposeHtmlFromEditorDocument,nativeComposeDraftFromEditorDocument,parseSafeComposeHtml,safeComposeHtmlFromEditorDocument} from '../src/safe-compose-html.js';
const link=(href:string)=>({type:'link',attrs:{href,target:null,rel:null,class:null,title:null}});
const text=(value:string,marks:unknown[]=[])=>({type:'text',text:value,marks});
const doc=(...content:unknown[])=>({type:'doc',content:[{type:'paragraph',content}]});
test('explicit native destinations canonicalize only safe absolute HTTP(S)/single mailbox without I/O',()=>{
 for(const [raw,canonical]of [['HTTPS://EXAMPLE.test/path?a=1&b=2','https://example.test/path?a=1&b=2'],['http://localhost:8080','http://localhost:8080/'],['https://127.0.0.1/','https://127.0.0.1/'],['https://例え.test/🌿','https://xn--r8jz45g.test/%F0%9F%8C%BF'],['mailto:User@EXAMPLE.test','mailto:User@example.test'],['mailto:first+last@example.test','mailto:first%2Blast@example.test']])assert.equal(canonicalNativeComposeLink(raw),canonical);
 for(const raw of ['javascript:alert(1)','data:text/plain,x','file:///tmp/x','ftp://example.test','/relative','//example.test','https://user@example.test/','https://@example.test/','https://a:secret@example.test/','https:\\example.test','https://example.test/a b','https://example.test/%0a','https://example.test/%C2%85','https://example.test/%E2%80%AE','https://example.test/%FF','https://example.test/%','https://example.test/\ud800','mailto:a@example.test,b@example.test','mailto:a@example.test?subject=x','mailto:a@example.test#x','mailto:Owner<a@example.test>','https://example.test/'+'x'.repeat(4096)])assert.throws(()=>canonicalNativeComposeLink(raw),raw);
});
test('native canonical anchors retain descriptive destination, entities, nesting, lists/breaks and URL-only dedup',()=>{
 const href='https://example.test/?a=1&b=2';
 const html='<p>Read <a href="https://example.test/?a=1&amp;b=2"><strong>A &amp; B</strong><em> now</em></a><br>Next</p><ul><li><p><a href="mailto:a@example.test">Contact</a></p></li></ul>';
 assert.equal(parseNativeSafeComposeHtml(html).plainText,`Read A & B now (${href})\nNext\n- Contact (mailto:a@example.test)`);
 assert.equal(parseNativeSafeComposeHtml('<p><a href="https://example.test/">https://example.test/</a></p>').plainText,'https://example.test/');
 assert.throws(()=>parseSafeComposeHtml(html));
 for(const bad of ['<p><a>missing</a></p>','<p><a href="HTTPS://example.test/">noncanonical</a></p>','<p><a href="https://example.test/" target="_blank">extra</a></p>','<p><a href="https://example.test/"> </a></p>','<p><a href="https://example.test/"><a href="https://other.test/">nested</a></a></p>','<p><a href="https://example.test/?a=1&b=2">bad amp</a></p>','<p><a href="javascript:alert(1)">unsafe</a></p>','<p><a href="https://example.test/">x</p></a>'])assert.throws(()=>parseNativeSafeComposeHtml(bad),bad);
});
test('actual editor marks coalesce adjacent mixed-format runs to one destination and preserve separate links',()=>{
 const href='https://example.test/',tree=doc(text('Read '),text('A',[link(href),{type:'bold'}]),text(' & B',[{type:'italic'},link(href)]),text(' now'));
 assert.deepEqual(nativeSafeComposeHtmlFromEditorDocument(tree),{html:'<p>Read <a href="https://example.test/"><strong>A</strong><em> &amp; B</em></a> now</p>',plainText:'Read A & B (https://example.test/) now'});assert.throws(()=>safeComposeHtmlFromEditorDocument(tree));
 assert.equal(nativeSafeComposeHtmlFromEditorDocument(doc(text('A',[link(href)]),{type:'hardBreak',marks:[link(href)]},text('B',[link(href)]))).plainText,'A\nB (https://example.test/)');
 assert.equal(nativeSafeComposeHtmlFromEditorDocument(doc(text('A',[link(href)]),text(' '),text('B',[link(href)]))).plainText,'A (https://example.test/) B (https://example.test/)');
 for(const marks of [[link(href),link(href)],[{type:'link',attrs:{href,target:'_blank'}}],[{type:'link',attrs:{href,title:'external'}}],[{type:'link',attrs:{href,onclick:null}}],[{type:'link',attrs:{href:'HTTPS://EXAMPLE.test/'}}],[{type:'bold',attrs:{}}]])assert.throws(()=>nativeSafeComposeHtmlFromEditorDocument(doc(text('A',marks))));
 const plain=doc(text('A',[{type:'bold'}]),text(' & B',[{type:'italic'}]));assert.deepEqual(nativeSafeComposeHtmlFromEditorDocument(plain),safeComposeHtmlFromEditorDocument(plain));
});
test('legacy cap remains unchanged while native body budget accepts longer descriptive links and retains finite guards',()=>{
 const href='https://example.test/',tree=doc(text('x'.repeat(20000),[link(href)]));const kept=nativeComposeDraftFromEditorDocument(tree);
 assert.equal(kept.plainText,'x'.repeat(20000)+' (https://example.test/)');assert.deepEqual(nativeSafeComposeHtmlFromEditorDocument(tree),kept);assert.deepEqual(parseNativeSafeComposeHtml(kept.html),kept);assert.throws(()=>parseSafeComposeHtml(kept.html));
 const exact='<p>'+ 'a'.repeat(16377)+'</p>';assert.equal(exact.length,16384);assert.equal(parseSafeComposeHtml(exact).plainText.length,16377);assert.throws(()=>parseSafeComposeHtml(exact+' '));
 assert.throws(()=>parseSafeComposeHtml('<p>x</p>',{maxCharacters:16385}));assert.throws(()=>nativeComposeDraftFromEditorDocument(doc(text('x'.repeat(256*1024),[link(href)]))));
 assert.throws(()=>nativeComposeDraftFromEditorDocument({type:'doc',content:Array.from({length:16384},()=>({type:'paragraph'}))}));
});
