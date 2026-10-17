import test from 'node:test';
import assert from 'node:assert/strict';
const grammar=await import(process.env.EMAIL_INLINE_GRAMMAR_BASELINE??new URL('../src/safe-compose-html.js',import.meta.url).href);
const file={file_id:'12345678-1234-4234-8234-123456789abc',filename:'diagram.png',media_type:'image/png',size_bytes:68,sha256:'a'.repeat(64)};
const cid='deft-'+file.file_id+'@deft.invalid',image=`<img src="cid:${cid}" alt="A &amp; B">`,html='<p>Diagram '+image+'</p>';
const options={inlineAttachments:[file]};
test('native image requires current exact file context; legacy and default native remain closed',()=>{
 assert.deepEqual(grammar.parseNativeSafeComposeHtml(html,options as any),{html,plainText:'Diagram [Image: A & B]'});
 assert.throws(()=>grammar.parseNativeSafeComposeHtml(html));assert.throws(()=>grammar.parseSafeComposeHtml(html));
 assert.equal(grammar.parseNativeSafeComposeHtml('<p>Ordinary draft</p>',{inlineAttachments:[{...file,file_id:'file',filename:'notes.pdf',media_type:'application/pdf'}]}).plainText,'Ordinary draft');
 assert.equal((grammar as any).nativeComposeImageCid(file.file_id),cid);
 assert.deepEqual((grammar as any).nativeComposeInlineFileIds(html,options),[file.file_id]);
 for(const files of [[],[{...file,file_id:'22345678-1234-4234-8234-123456789abc'}],[{...file,media_type:'image/svg+xml'}],[{...file,size_bytes:25*1024*1024+1}],[file,file],[{...file,sha256:'bad'}]])assert.throws(()=>grammar.parseNativeSafeComposeHtml(html,{inlineAttachments:files} as any));
});
test('closed native image attributes, canonical CID, alt and context bounds never repair input',()=>{
 for(const img of ['<img src="https://example.test/a.png" alt="A">','<img src="data:image/png,a" alt="A">','<img src="blob:owned" alt="A">',`<img src="cid:${cid}" alt="">`,`<img src="cid:${cid}" alt="${'a'.repeat(256)}">`,`<img alt="A" src="cid:${cid}">`,`<img src="cid:${cid}" alt="A" width="10">`,`<img src="cid:${cid}" alt="A"/>`,`<img src="cid:${cid}" alt="A"></img>`,`<img src="cid:${cid}" alt="A\nB">`,`<img src="cid:${cid.toUpperCase()}" alt="A">`])assert.throws(()=>grammar.parseNativeSafeComposeHtml('<p>'+img+'</p>',options as any),img);
 assert.throws(()=>grammar.parseNativeSafeComposeHtml(image,options as any));
 assert.throws(()=>grammar.parseNativeSafeComposeHtml('<p><a href="https://example.test/">'+image+'</a></p>',options as any));
 assert.equal(grammar.parseNativeSafeComposeHtml('<p>'+image+image+'</p>',options as any).plainText,'[Image: A & B][Image: A & B]');
});
test('native editor atom and draft converter share current context and plain projection',()=>{
 const doc={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Diagram '},{type:'nativeInlineImage',attrs:{fileId:file.file_id,alt:'A & B'}}]}]};
 assert.deepEqual(grammar.nativeSafeComposeHtmlFromEditorDocument(doc,options as any),{html,plainText:'Diagram [Image: A & B]'});
 assert.deepEqual((grammar.nativeComposeDraftFromEditorDocument as any)(doc,options),{html,plainText:'Diagram [Image: A & B]'});
 assert.throws(()=>grammar.safeComposeHtmlFromEditorDocument(doc));assert.throws(()=>grammar.nativeSafeComposeHtmlFromEditorDocument(doc));
 for(const attrs of [{fileId:file.file_id,alt:'A',src:'data:x'},{fileId:file.file_id,alt:'A',width:null},{fileId:'foreign',alt:'A'},{fileId:file.file_id,alt:''}])assert.throws(()=>grammar.nativeSafeComposeHtmlFromEditorDocument({type:'doc',content:[{type:'paragraph',content:[{type:'nativeInlineImage',attrs}]}]},options as any));
});
test('text-only copy centrally replaces only removed bound image nodes preserving rich formatting and exact pair',()=>{
 const other={...file,file_id:'22345678-1234-4234-8234-123456789abc'};
 const source='<p><strong>Diagram</strong> '+image+'<br>'+`<img src="cid:deft-${other.file_id}@deft.invalid" alt="Second">`+'</p>';
 const copied=(grammar as any).removeNativeComposeInlineFiles(source,[file.file_id],{inlineAttachments:[file,other]});
 assert.deepEqual(copied,{html:'<p><strong>Diagram</strong> [Image: A &amp; B]<br>'+`<img src="cid:deft-${other.file_id}@deft.invalid" alt="Second">`+'</p>',plainText:'Diagram [Image: A & B]\n[Image: Second]'});
 const all=(grammar as any).removeNativeComposeInlineFiles(source,[file.file_id,other.file_id],{inlineAttachments:[file,other]});assert.doesNotMatch(all.html,/<img|cid:/u);assert.equal(grammar.parseNativeSafeComposeHtml(all.html).plainText,all.plainText);
 assert.throws(()=>(grammar as any).removeNativeComposeInlineFiles(source,[file.file_id],{inlineAttachments:[file]}));
});
