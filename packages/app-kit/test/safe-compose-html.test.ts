import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSafeComposeHtml,plainTextToSafeComposeHtml,safeComposeHtmlFromEditorDocument,RuntimeObjectSchema,parseRuntimeObjectInput} from '../dist/index.js';
test('closed rich grammar projects exact text and canonical entity/list formatting',()=>{
 const html='<p>Hello <strong>team &amp; friends</strong><br><em>Next</em></p><ul><li><p>One</p></li><li><p>Two</p><ol><li><p>Nested</p></li></ol></li></ul>';
 assert.deepEqual(parseSafeComposeHtml(html),{html,plainText:'Hello team & friends\nNext\n- One\n- Two\n  1. Nested'});
 for(const text of ['', 'Hello\n\nWorld', '<script>& 🌿'])assert.equal(parseSafeComposeHtml(plainTextToSafeComposeHtml(text)).plainText,text);
});
test('attributes, active markup, noncanonical entities, malformed nesting and document overflow fail closed',()=>{
 for(const html of ['<p onclick="x">Hello</p>','<img src="https://remote.test">','<p><a>Link</a></p>','<p>&#60;script&#62;</p>','<p>&nbsp;</p>',
 '<p><ul><li><p>x</p></li></ul></p>','<ul></ul>','<li><p>x</p></li>','<p>raw > bracket</p>','<p>\0</p>','<p>\ud800</p>','<p>x</p>'.repeat(3000)])assert.throws(()=>parseSafeComposeHtml(html));
 assert.throws(()=>parseSafeComposeHtml('<p>🌿🌿</p>',{maxBytes:8}));
});
test('host editor normalization accepts only bounded closed node/mark types',()=>{
 assert.deepEqual(safeComposeHtmlFromEditorDocument({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'A & B',marks:[{type:'italic'},{type:'bold'}]}]}]}),
 {html:'<p><strong><em>A &amp; B</em></strong></p>',plainText:'A & B'});
 assert.deepEqual(safeComposeHtmlFromEditorDocument({type:'doc',content:[{type:'orderedList',attrs:{start:1,type:null},content:[{type:'listItem',content:[{type:'paragraph',content:[{type:'text',text:'Item'}]}]}]}]}),
 {html:'<ol><li><p>Item</p></li></ol>',plainText:'1. Item'});
 for(const value of [{type:'doc',content:[{type:'image',attrs:{src:'https://remote.test'}}]},
 {type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'x',marks:[{type:'link',attrs:{href:'https://remote.test'}}]}]}]},
 {type:'doc',content:[{type:'orderedList',attrs:{start:99},content:[]}]}])assert.throws(()=>safeComposeHtmlFromEditorDocument(value));
});
test('reviewed paired rich scalar enforces exact plain counterpart, without adopting a legacy draft implicitly',()=>{
 const contract=RuntimeObjectSchema.parse({type:'object',properties:{rich:{type:'string',maxLength:16384,format:'safe_html',plainTextKey:'plain'},
 plain:{type:'string',maxLength:4096,readOnly:true}},required:['rich','plain'],additionalProperties:false});
 assert.deepEqual(parseRuntimeObjectInput(contract,{rich:'<p><strong>Hello</strong></p>',plain:'Hello'}),{rich:'<p><strong>Hello</strong></p>',plain:'Hello'});
 assert.deepEqual(parseRuntimeObjectInput(contract,{rich:'',plain:'Legacy plain'}),{rich:'',plain:'Legacy plain'});
 assert.throws(()=>parseRuntimeObjectInput(contract,{rich:'<p>Hello</p>',plain:'Changed'}));
 assert.throws(()=>parseRuntimeObjectInput(contract,{plain:'Legacy plain'}));
 assert.throws(()=>RuntimeObjectSchema.parse({...contract,properties:{...contract.properties,rich:{type:'string',maxLength:100,format:'safe_html'}}}));
 assert.throws(()=>RuntimeObjectSchema.parse({...contract,properties:{...contract.properties,plain:{type:'string',maxLength:100}}}));
});
