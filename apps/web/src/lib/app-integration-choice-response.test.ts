import assert from 'node:assert/strict';
import {test} from 'node:test';
import {boundedChoiceListJson,boundedConfirmationJson} from './app-experience-action-confirmation';
const rows=[{id:'00000000-0000-4000-8000-000000000001',name:'Project',description:'Extra fields are not authority'}];
test('project and space array catalogs decode separately from confirmation objects',async()=>{
 for(const catalog of [rows,[]])assert.deepEqual(await boundedChoiceListJson(Response.json(catalog)),catalog);
 await assert.rejects(boundedConfirmationJson(Response.json(rows)),/Action unavailable/);
 assert.deepEqual(await boundedConfirmationJson(Response.json({snapshot:'review'})),{snapshot:'review'});
 await assert.rejects(boundedChoiceListJson(Response.json({projects:rows})),/Choices unavailable/);
});
test('both decoders preserve byte limits and reject malformed UTF8 or JSON',async()=>{
 for(const decode of [boundedChoiceListJson,boundedConfirmationJson]){
  await assert.rejects(decode(new Response(' '.repeat(131073))),/Action response limit/);
  await assert.rejects(decode(new Response(new Uint8Array([0xc3,0x28]))));
  await assert.rejects(decode(new Response('[')));
 }
});
test('failed catalog responses are canceled and cannot become choices',async()=>{
 let canceled=false;
 const body=new ReadableStream({cancel(){canceled=true;}});
 await assert.rejects(boundedChoiceListJson(new Response(body,{status:403})),/Action unavailable/);
 assert.equal(canceled,true);
});
