import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createAttachmentZip,attachmentArchiveFilename} from './app-experience-attachment-zip';

// Python's independently implemented ZIP decoder checks both CRC and exact bytes.
function inspectAttachmentZip(bytes:Uint8Array):Array<{name:string;bytes:number[];method:number}>{
 return JSON.parse(execFileSync(process.env.DEFT_ZIP_TEST_PYTHON??'python',['-c',
  'import io,json,sys,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; print(json.dumps([{ "name":i.filename,"bytes":list(z.read(i)),"method":i.compress_type} for i in z.infolist()]))'],
  {input:Buffer.from(bytes),maxBuffer:33554432}).toString());
}
test('independent Python unzip confirms exact binary/empty/Unicode bytes and root-only deterministic safe collisions',()=>{
 const input=[{filename:'résumé.pdf',bytes:new Uint8Array([0,255,128,13,10])},{filename:'empty.txt',bytes:new Uint8Array()},
  {filename:'Report.csv',bytes:new Uint8Array([1])},{filename:'report.csv',bytes:new Uint8Array([2])},
  {filename:'CON.txt',bytes:new Uint8Array([3])},{filename:'../unsafe:file?.txt',bytes:new Uint8Array([4])},
  {filename:'résumé.pdf',bytes:new Uint8Array([5])}];
 const extracted=inspectAttachmentZip(createAttachmentZip(input));assert.deepEqual(extracted.map(e=>e.name),['résumé.pdf','empty.txt','Report.csv','report (2).csv','_CON.txt','.._unsafe_file_.txt','résumé (2).pdf']);
 assert.deepEqual(extracted.map(e=>e.bytes),input.map(f=>[...f.bytes]));assert.ok(extracted.every(e=>e.method===0&&!/[\\/]/u.test(e.name)));
 assert.deepEqual(inspectAttachmentZip(createAttachmentZip(input)),extracted);assert.deepEqual([...input[0].bytes],[0,255,128,13,10]);
});
test('ZIP validates count and total payload before encoding, permits exact 25MiB with bounded metadata',()=>{
 assert.throws(()=>createAttachmentZip([]));assert.throws(()=>createAttachmentZip(Array.from({length:33},()=>({filename:'a',bytes:new Uint8Array()}))));
 assert.throws(()=>createAttachmentZip([{filename:'a',bytes:new Uint8Array(25*1024*1024+1)}]));
 const input=new Uint8Array(25*1024*1024).fill(73),zip=createAttachmentZip([{filename:'a',bytes:input}]);assert.ok(zip.length>25*1024*1024&&zip.length<=25*1024*1024+131072);
 const oracle=JSON.parse(execFileSync(process.env.DEFT_ZIP_TEST_PYTHON??'python',['-c','import io,json,sys,zipfile,hashlib; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; b=z.read(z.infolist()[0]); print(json.dumps({"name":z.infolist()[0].filename,"size":len(b),"sha256":hashlib.sha256(b).hexdigest()}))'],{input:Buffer.from(zip),maxBuffer:1024*1024}).toString());
 assert.deepEqual(oracle,{name:'a',size:input.length,sha256:createHash('sha256').update(input).digest('hex')});
 assert.equal(attachmentArchiveFilename('  Quarterly / report: <Q1>  '),'Quarterly _ report_ _Q1_.zip');assert.equal(attachmentArchiveFilename(''),'Attachments.zip');assert.equal(attachmentArchiveFilename('CON'),'_CON.zip');
});
