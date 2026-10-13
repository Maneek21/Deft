import assert from 'node:assert/strict';
import test from 'node:test';
import {parseSourceView,readSourceBinary} from './app-experience-source-view';
const scope={exposure_id:'scope',exposure_epoch:2},base={...scope,expires_at:new Date(Date.now()+60000).toISOString()};
const presentation={format:'plain',content:'Full inert body',plain_text:'Full inert body',truncated:false,images:[],headers:[]};
test('legacy omitted fields are optional bounded integers on inventory and nested presentation',()=>{
 assert.equal(parseSourceView({...base,files:[]},scope).omitted_file_count,0);
 assert.equal(parseSourceView({...base,files:[],omitted_file_count:5},scope).omitted_file_count,5);
 assert.equal(parseSourceView({...base,presentation:{...presentation,omitted_file_count:5,rendering_fallback:'plain_text'}},scope).presentation!.omitted_file_count,5);
 for(const omitted_file_count of [-1,257,0.5,'1',null]){
   assert.throws(()=>parseSourceView({...base,files:[],omitted_file_count},scope));assert.throws(()=>parseSourceView({...base,presentation:{...presentation,omitted_file_count}},scope));}
 for(const p of [{...presentation,rendering_fallback:'html'},{...presentation,rendering_fallback:'plain_text',format:'html'},{...presentation,rendering_fallback:'plain_text',images:[{image_ref:'a'.repeat(64),kind:'remote',index:0,alt:''}]}])assert.throws(()=>parseSourceView({...base,presentation:p},scope));
 assert.throws(()=>parseSourceView({...base,files:[],private_locator:'hidden'},scope));assert.throws(()=>parseSourceView({...base,exposure_epoch:3,files:[],omitted_file_count:1},scope));
});
test('legacy original-source binary validation retains exact exposure, length, nosniff and RFC822 type',async()=>{
 const response=(extra:Record<string,string>={})=>new Response(new Uint8Array(12),{headers:{'content-length':'12','content-type':'message/rfc822','content-disposition':'attachment; filename="message.eml"','x-content-type-options':'nosniff','x-deft-exposure-id':scope.exposure_id,'x-deft-exposure-epoch':'2',...extra}});
 assert.equal((await readSourceBinary(response(),scope,()=>true,{mediaType:'message/rfc822'})).length,12);
 for(const extra of [{'content-type':'text/html'},{'x-content-type-options':'sniff'},{'x-deft-exposure-epoch':'3'},{'content-length':'13'}] as Record<string,string>[])await assert.rejects(readSourceBinary(response(extra),scope,()=>true,{mediaType:'message/rfc822'}));
 await assert.rejects(readSourceBinary(response(),scope,()=>false,{mediaType:'message/rfc822'}));
});
test('legacy source stream cancellation settles a held reader and releases owned bytes',async()=>{
 let cancelled=false;const chunk=new Uint8Array(12).fill(7),controller=new AbortController();
 const response=new Response(new ReadableStream({start(c){c.enqueue(chunk);},cancel(){cancelled=true;}}),{headers:{'content-length':'12','content-type':'message/rfc822','content-disposition':'attachment;','x-content-type-options':'nosniff','x-deft-exposure-id':scope.exposure_id,'x-deft-exposure-epoch':'2'}});
 const pending=readSourceBinary(response,scope,()=>true,{mediaType:'message/rfc822',signal:controller.signal});await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(pending);assert.equal(cancelled,true);assert.ok(chunk.every(byte=>byte===0));
});
