import {NATIVE_COMPOSE_BODY_LIMITS,parseSafeComposeHtml} from '../../../../packages/app-kit/src/safe-compose-html';
import test from 'node:test';import assert from 'node:assert/strict';import {plainToRich,richEditorView} from './app-experience-rich-mode';
test('explicit native formatting normalizes CRLF/CR to LF without changing line count, whitespace or text',()=>{
 for(const text of ['  indented  text\t\tend  ','one\r\n\r\n  two\rthree\n','& < >\n\ttext','']){const original=text,next=plainToRich(text);assert.equal(next.plainText,text.replace(/\r\n?/gu,'\n'));assert.equal(text,original);assert.equal(next.plainText.split('\n').length,text.split(/\r\n|\r|\n/u).length);assert.ok(richEditorView(next));}
});
test('a saved rich view is normalized only when its exact paired roundtrip remains true; raw input is retained',()=>{
 const value={html:'<p>  one\r\ntwo\t  </p>',plainText:'  one\r\ntwo\t  '},before=structuredClone(value);assert.deepEqual(richEditorView(value),{html:'<p>  one\ntwo\t  </p>',plainText:'  one\ntwo\t  '});assert.deepEqual(value,before);
 const implicit={html:'<p>one\r</p><p>two</p>',plainText:'one\r\ntwo'};assert.equal(richEditorView(implicit),null);assert.equal(implicit.plainText,'one\r\ntwo');assert.equal(richEditorView({html:'<p>one</p>',plainText:'other'}),null);
});
test('native normalization never enlarges the closed rich grammar or admits remote/style/script markup',()=>{
 const body='x'.repeat(20000),rich=plainToRich(body);assert.equal(rich.plainText,body);assert.ok(richEditorView(rich));assert.throws(()=>parseSafeComposeHtml(rich.html));assert.throws(()=>plainToRich('x'.repeat(NATIVE_COMPOSE_BODY_LIMITS.maxCharacters+1)));for(const html of ['<p style="color:red">x</p>','<img src="https://remote.invalid/x">','<script>x</script>','<p><a href="javascript:alert(1)">x</a></p>','<p><a href="data:text/html,x">x</a></p>','<p><a href="https://user:pass@example.test/">x</a></p>','<p>'+ 'x'.repeat(16384)+'</p>'])assert.equal(richEditorView({html,plainText:'x'}),null);
});
