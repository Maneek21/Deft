import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { frameResourceSyncAttachment } from '@deft/app-kit';
import { readAttachmentFrame } from '../src/lib/app-attachment-frame.js';
const header={schema_version:'deft.app_sync_attachment_stage.v1' as const,
  channel_version:'deft.app_runtime_channel.v3' as const,audience:'app_resource_sync' as const,
  session_id:randomUUID(),run_id:randomUUID(),attempt_id:randomUUID(),claim_token:randomUUID(),sequence:1,
  parent_resource_id:'message-1',parent_revision:'1',attachment_key:'report',filename:'report.csv',
  declared_media_type:'text/csv' as const,declared_size_bytes:4};
test('attachment frame reserves before binary consumption and accepts exact split framing',async()=>{
  const framed=frameResourceSyncAttachment(header,new TextEncoder().encode('a,b\n'));
  const headerEnd=4+new DataView(framed.buffer,framed.byteOffset,4).getUint32(0,false);
  let delivered=0;
  const chunks=[framed.slice(0,3),framed.slice(3,headerEnd),framed.slice(headerEnd)];
  const stream=new ReadableStream<Uint8Array>({pull(c){const chunk=chunks.shift();if(chunk){delivered+=chunk.length;c.enqueue(chunk);}else c.close();}},{highWaterMark:0});
  const frame=await readAttachmentFrame(stream,new AbortController().signal,framed.length);
  assert.equal(delivered,headerEnd);assert.deepEqual(frame.header,header);
  assert.equal((await frame.readBytes(new AbortController().signal)).toString(),'a,b\n');
  await frame.close();
});
test('attachment frame rejects truncated, trailing, oversized and declared-length substitution',async()=>{
  const bytes=frameResourceSyncAttachment(header,new TextEncoder().encode('a,b\n'));
  const signal=new AbortController().signal;
  const stream=(value:Uint8Array)=>new ReadableStream<Uint8Array>({start(c){c.enqueue(value);c.close();}});
  await assert.rejects(readAttachmentFrame(stream(bytes),signal,bytes.length+1));
  const short=await readAttachmentFrame(stream(bytes.slice(0,-1)),signal);
  await assert.rejects(short.readBytes(signal));
  const trailing=await readAttachmentFrame(stream(new Uint8Array([...bytes,0])),signal);
  await assert.rejects(trailing.readBytes(signal));
  await assert.rejects(readAttachmentFrame(stream(new Uint8Array([0,0,32,1])),signal));
});
test('attachment frame cancels held binary I/O without partial bytes',async()=>{
  const bytes=frameResourceSyncAttachment(header,new TextEncoder().encode('a,b\n'));
  const end=4+new DataView(bytes.buffer,bytes.byteOffset,4).getUint32(0,false);
  let cancelled=false;
  const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(bytes.slice(0,end));},cancel(){cancelled=true;}},{highWaterMark:0});
  const frame=await readAttachmentFrame(stream,new AbortController().signal);
  const controller=new AbortController();const pending=frame.readBytes(controller.signal);
  controller.abort();await assert.rejects(pending);assert.equal(cancelled,true);
});
