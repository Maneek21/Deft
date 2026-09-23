import assert from 'node:assert/strict';
import test from 'node:test';
import { parseModuleCsv, mapModuleImportRows } from './module-import';
import { normalizeModuleManifest } from './modules';

test('CSV accepts BOM, escaped quotes, embedded commas/newlines and CRLF', () => {
  assert.deepEqual(parseModuleCsv('\uFEFFName,Note\r\n"Lee, Ada","Line 1\nLine ""2"""\r\n'), {
    headers: ['Name', 'Note'], rows: [['Lee, Ada', 'Line 1\nLine "2"']],
  });
});
test('CSV rejects malformed rows, stray quotes and oversized batches', () => {
  for (const text of ['Name,Email\nOnly name', 'Name\n"unclosed', 'Name\n"closed"extra', 'Name\nAda"']) assert.throws(() => parseModuleCsv(text));
  assert.throws(() => parseModuleCsv('Name\n' + Array.from({length:101}, (_, index) => `Person${index}`).join('\n')), /100/);
});
test('mapping converts typed values, preserves zero/false, and rejects ambiguous mapping', () => {
  const collection = normalizeModuleManifest({ schema_version:'1', id:'test.import', name:'Import', version:'1.0.0', slug:'import', collections:[{ key:'items',name:'Items', fields:[
    {key:'name',label:'Name',type:'text',required:true}, {key:'amount',label:'Amount',type:'number'}, {key:'active',label:'Active',type:'boolean'},
    {key:'status',label:'Status',type:'single_select',options:[{value:'in_progress',label:'In progress'}]},
  ]}] }).collections[0];
  assert.deepEqual(mapModuleImportRows(collection, ['name','amount','active','status'], [['Ada','0','no','In progress']]), [{name:'Ada',amount:0,active:false,status:'in_progress'}]);
  assert.throws(() => mapModuleImportRows(collection, ['name','name'], [['A','B']]), /only once/);
  assert.throws(() => mapModuleImportRows(collection, ['amount'], [['NaN']]), /number/);
});


test('CSV tag columns become unique tag arrays', () => {
  const collection = normalizeModuleManifest({ schema_version:'1', id:'test.tags', name:'Tags', version:'1.0.0', slug:'tags', collections:[{ key:'items',name:'Items', fields:[
    {key:'name',label:'Name',type:'text',required:true}, {key:'tags',label:'Tags',type:'tags'},
  ]}] }).collections[0];
  assert.deepEqual(mapModuleImportRows(collection, ['name','tags'], [['Ada',' demo ; partner;demo;; ']]), [{name:'Ada',tags:['demo','partner']}]);
});
