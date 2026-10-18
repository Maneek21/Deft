import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {Node as TiptapNode} from '@tiptap/core';
import test from 'node:test';
import assert from 'node:assert/strict';
import {getSchema} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {EditorState,NodeSelection} from '@tiptap/pm/state';
import {closeHistory,history,undo} from '@tiptap/pm/history';
import {nativeComposeImageCid,nativeSafeComposeHtmlFromEditorDocument,parseNativeSafeComposeHtml} from '../../../../packages/app-kit/src/safe-compose-html';
import {inlineImageExtension,createInlinePreviews} from './app-experience-inline-images';
import {richEditorView} from './app-experience-rich-mode';
const id='11111111-1111-4111-8111-111111111111';
const png=(width=1,height=1)=>{const bytes=new Uint8Array(33);bytes.set([137,80,78,71,13,10,26,10]);new DataView(bytes.buffer).setUint32(8,13);bytes.set([73,72,68,82],12);new DataView(bytes.buffer).setUint32(16,width);new DataView(bytes.buffer).setUint32(20,height);return bytes;};
const file={file_id:id,filename:'Photo.png',media_type:'image/png',size_bytes:33,sha256:'0'.repeat(64)};
const content=()=>{const html='<p><strong>Before</strong><img src="cid:'+nativeComposeImageCid(id)+'" alt="Phone photo"> after</p>';return {body_html:html,body:parseNativeSafeComposeHtml(html,{inlineAttachments:[file]}).plainText,attachments:[file]};};
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
test('real installed native image schema inserts, edits, removes and undoes with canonical paired projection',()=>{
 const extension=inlineImageExtension({files:()=>[file],preview:()=>({ready:Promise.resolve(null),release(){}})});
 const schema=getSchema([StarterKit.configure({link:false}),extension]);let state=EditorState.create({schema,plugins:[history()],doc:schema.nodes.doc!.create(null,[schema.nodes.paragraph!.create(null,schema.text('Before'))])});
 state=state.apply(state.tr.insert(7,schema.nodes.nativeInlineImage!.create({fileId:id,alt:'Phone photo'})));
 let pair=nativeSafeComposeHtmlFromEditorDocument(state.doc.toJSON(),{inlineAttachments:[file]});assert.equal(pair.plainText,'Before[Image: Phone photo]');assert.match(pair.html,/cid:deft-/);assert.equal(richEditorView(pair,{inlineAttachments:[file]}),pair);assert.equal(richEditorView(pair),null);
 state=state.apply(state.tr.setNodeMarkup(7,undefined,{fileId:id,alt:'Edited description'}));pair=nativeSafeComposeHtmlFromEditorDocument(state.doc.toJSON(),{inlineAttachments:[file]});assert.match(pair.plainText,/Edited description/);
 state=state.apply(closeHistory(state.tr).setSelection(NodeSelection.create(state.doc,7)).deleteSelection());assert.equal(nativeSafeComposeHtmlFromEditorDocument(state.doc.toJSON(),{inlineAttachments:[file]}).plainText,'Before');assert.ok(undo(state,tr=>{state=state.apply(tr);}));assert.match(nativeSafeComposeHtmlFromEditorDocument(state.doc.toJSON(),{inlineAttachments:[file]}).plainText,/Image:/);
 assert.throws(()=>nativeSafeComposeHtmlFromEditorDocument(state.doc.toJSON()));assert.throws(()=>nativeSafeComposeHtmlFromEditorDocument({type:'doc',content:[{type:'paragraph',content:[{type:'nativeInlineImage',attrs:{fileId:id,alt:'x',src:'https://remote.invalid'}}]}]},{inlineAttachments:[file]}));
});

test('previews use two readers and disposal discards held bytes without publishing URL',async()=>{let active=true,calls=0;const releases:Array<(bytes:Uint8Array)=>void>=[],buffers:Uint8Array[]=[];const original=URL.createObjectURL;let urls=0;URL.createObjectURL=()=>{urls++;return 'blob:test';};
 const previews=createInlinePreviews({current:()=>active,read:()=>{calls++;return new Promise<Uint8Array>(resolve=>releases.push(resolve));},denied(){assert.fail('optional failure is not denial');}});
 try{const leases=[1,2,3].map(index=>previews.acquire({...file,file_id:`0000000${index}-1111-4111-8111-111111111111`}));await tick();assert.equal(calls,2);active=false;previews.dispose();for(const resolve of releases){const bytes=png();buffers.push(bytes);resolve(bytes);}assert.deepEqual(await Promise.all(leases.map(lease=>lease.ready)),[null,null,null]);assert.equal(calls,2);assert.equal(urls,0);assert.ok(buffers.every(bytes=>bytes.every(byte=>byte===0)));}finally{previews.dispose();URL.createObjectURL=original;}
});

test('preview encoded and decoded aggregate budgets produce placeholders without altering body',async()=>{const originalURL=URL.createObjectURL,originalRevoke=URL.revokeObjectURL;let urls=0,revokes=0,calls=0;URL.createObjectURL=()=>`blob:${++urls}`;URL.revokeObjectURL=()=>{revokes++;};
 const previews=createInlinePreviews({current:()=>true,read:async()=>{calls++;return png(7000,2000);},denied(){}});try{const first=previews.acquire(file),second=previews.acquire({...file,file_id:'22222222-1111-4111-8111-111111111111'}),third=previews.acquire({...file,file_id:'33333333-1111-4111-8111-111111111111'});assert.ok(await first.ready);assert.ok(await second.ready);assert.equal(await third.ready,null);assert.equal(calls,3);assert.equal(urls,2);first.release();second.release();third.release();assert.equal(revokes,2);
 const big=previews.acquire({...file,size_bytes:9*1024*1024});assert.equal(await big.ready,null);assert.equal(calls,3);assert.match(content().body,/Image: Phone photo/);}finally{previews.dispose();URL.createObjectURL=originalURL;URL.revokeObjectURL=originalRevoke;}
});

test('preview denial has no replay and source generation cannot publish a late stream',async()=>{let denied=0,calls=0;const previews=createInlinePreviews({current:()=>true,read:async()=>{calls++;throw {kind:'denied'};},denied(){denied++;}});const lease=previews.acquire(file);assert.equal(await lease.ready,null);assert.equal(denied,1);assert.equal(await previews.acquire(file).ready,null);assert.equal(calls,1);previews.dispose();});


test('actual PM hydration skips an ordinary opaque file and binds only its canonical owned image',()=>{const source=ts.createSourceFile('images.ts',readFileSync(process.env.EMAIL_INLINE_EXTENSION_SOURCE??new URL('./app-experience-inline-images.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);const declaration=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='inlineImageExtension');assert.ok(declaration);const create=runInNewContext(ts.transpileModule('('+declaration.getText(source).replace('export ','')+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{TiptapNode,nativeComposeImageCid});const ordinary={...file,file_id:'old-ordinary-file',media_type:'application/pdf'},extension=create({files:()=>[ordinary,file],preview:()=>{assert.fail('HTML parsing cannot fetch bytes');}}),rule=extension.config.parseHTML.call(extension)[0],element=(src:string)=>({getAttribute:(key:string)=>key==='src'?src:key==='alt'?'Phone photo':null});assert.deepEqual(JSON.parse(JSON.stringify(rule.getAttrs(element('cid:'+nativeComposeImageCid(id))))),{fileId:id,alt:'Phone photo'});assert.equal(rule.getAttrs(element('https://remote.invalid/image.png')),false);assert.equal(rule.getAttrs(element('cid:deft-22222222-1111-4111-8111-111111111111@deft.invalid')),false);});


test('actual native NodeView decoder error restores meaningful placeholder and releases its URL lease once without document edits',async()=>{const originalDocument=globalThis.document;class Element{contentEditable='';className='';textContent='';src='';alt='';onerror:(()=>void)|null=null;children:Element[]=[];append(child:Element){this.children.push(child);}replaceChildren(...children:Element[]){this.children=children;}removeAttribute(name:string){if(name==='src')this.src='';}}const created:Element[]=[];globalThis.document={createElement:()=>{const element=new Element();created.push(element);return element;}} as unknown as Document;
 try{for(const end of ['error','destroy','scope'] as const){let current=true,releases=0;const candidate=process.env.EMAIL_INLINE_EXTENSION_SOURCE?(()=>{const source=ts.createSourceFile('images.ts',readFileSync(process.env.EMAIL_INLINE_EXTENSION_SOURCE!,'utf8'),ts.ScriptTarget.Latest,true);const declaration=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='inlineImageExtension')!;return runInNewContext(ts.transpileModule('('+declaration.getText(source).replace('export ','')+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{TiptapNode,nativeComposeImageCid,document:globalThis.document});})():inlineImageExtension;const extension=candidate({files:()=>[file],preview:()=>({ready:Promise.resolve('blob:owned'),current:()=>current,release(){releases++;}})}),create=(extension.config.addNodeView as ()=> (input:{node:{attrs:{fileId:string;alt:string}}})=>{dom:Element;destroy:()=>void}).call(extension),node={attrs:{fileId:id,alt:'Phone photo'}},view=create({node}),original=JSON.stringify(node);await tick();const image=view.dom.children[0] as Element;assert.equal(image.src,'blob:owned');assert.equal(typeof image.onerror,'function','decoder failure must retain an explicit placeholder');const captured=image.onerror!;if(end==='destroy')view.destroy();if(end==='scope')current=false;captured();if(end==='error'){assert.equal(view.dom.children[0].textContent,'[Image: Phone photo] · preview unavailable');}else assert.equal(view.dom.children[0],image,'late callback cannot replace a disposed/foreign view');assert.equal(releases,1);view.destroy();assert.equal(releases,1);assert.equal(JSON.stringify(node),original);}}
 finally{globalThis.document=originalDocument;}
});
