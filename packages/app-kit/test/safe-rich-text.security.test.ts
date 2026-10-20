import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {parseTrustedRichtextHtml,canonicalRichtextLink,richtextImageReference} from '../dist/experience-core.js';
import {parseNativeSafeComposeHtml,canonicalNativeComposeLink} from '../dist/examples/email/safe-compose-html.js';

test('Host independently rejects active markup, malformed URLs and unscoped image references',()=>{
 const unsafe=['<script>alert(1)</script>','<p onclick="run()">x</p>','<p><a href="javascript:alert(1)">x</a></p>',
  '<p><a href="data:text/html,x">x</a></p>','<p><img src="https://remote.test/a.png"></p>',
  '<p><a href="https://example.test/%0a">x</a></p>','<p><a href="mailto:Owner&lt;a@example.test&gt;">x</a></p>',
  '<p><a href="mailto:a@example.test,b@example.test">x</a></p>','<p><a href="mailto:a@example.test?subject=x">x</a></p>'];
 // Even an app parser that accepts everything cannot weaken this independent gate.
 const appParser=(html:string)=>({html,plainText:'app supplied'});
 for(const html of unsafe){assert.ok(appParser(html));assert.throws(()=>parseTrustedRichtextHtml(html),html);}
 const id='11111111-1111-4111-8111-111111111111';
 assert.throws(()=>parseTrustedRichtextHtml(`<p><img src="cid:${richtextImageReference(id)}" alt="image"></p>`));
});

test('Host safety preserves the frozen accepted URL, CID and plain-projection contract',()=>{
 for(const uri of ['HTTPS://EXAMPLE.test/path?q=one','https://example.test/a%20b','mailto:User@EXAMPLE.test','mailto:first+last@example.test']){
  assert.equal(canonicalRichtextLink(uri),canonicalNativeComposeLink(uri));
 }
 for(const uri of ['mailto:a..b@example.test','mailto:.a@example.test','mailto:a@-example.test','mailto:a@example..test','mailto:a@example','mailto:a@example.test;','https://user@example.test/','https://example.test/%ff']){
  assert.throws(()=>canonicalRichtextLink(uri));assert.throws(()=>canonicalNativeComposeLink(uri));
 }
 const file={file_id:'11111111-1111-4111-8111-111111111111',filename:'image.png',media_type:'image/png',size_bytes:100,sha256:'a'.repeat(64)};
 for(const html of ['', '<p>A &amp; B</p>','<p><a href="https://example.test/">Read</a></p>',`<p><img src="cid:${richtextImageReference(file.file_id)}" alt="diagram"></p>`]){
  assert.deepEqual(parseTrustedRichtextHtml(html,{inlineAttachments:[file]}),parseNativeSafeComposeHtml(html,{inlineAttachments:[file]}));
 }
 assert.throws(()=>parseTrustedRichtextHtml('<p>x</p>',{inlineAttachments:Array(33).fill(file)}));
 assert.throws(()=>parseTrustedRichtextHtml('<p>x</p>',{inlineAttachments:[{...file,size_bytes:25*1024*1024+1}]}));
});

test('a fresh core process has no implicit private operation registration or domain exports',()=>{
 const code=`import * as core from './dist/core.js'; import * as leaf from './dist/experience-core.js';
 if(core.DEFT_APP_PROTOCOL_SUPPORT['1'].private_interfaces.length)throw Error('implicit registration');
 for(const kit of [core,leaf]) for(const key of Object.keys(kit)) if(/Mailbox|SandboxEmail|NativeCompose/.test(key))throw Error(key);
 if(JSON.stringify(core.REVIEWED_AUTOMATION_POLICY).includes('sandbox'))throw Error('implicit policy');`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});
