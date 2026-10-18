import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {inspectEmailSourceFiles} from './incoming-source-files.mjs';
import {calendarPartsFromParsed} from './calendar-source-parts.mjs';
const ics='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:calendar-fixture\r\nDTSTAMP:20261004T120000Z\r\nSEQUENCE:1\r\nDTSTART:20261005T120000Z\r\nDTEND:20261005T130000Z\r\nSUMMARY:Réunion 東京\r\nORGANIZER:mailto:sender@example.test\r\nATTENDEE:mailto:owner@example.test\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
export const calendarMime=Buffer.from('From: sender@example.test\r\nTo: owner@example.test\r\nMIME-Version: 1.0\r\nContent-Type: text/calendar; charset=utf-8; method=REQUEST\r\nContent-Transfer-Encoding: base64\r\n\r\n'+Buffer.from(ics).toString('base64')+'\r\n');
test('actual MIME parser extracts exact decoded top-level calendar and source-derived stable reference',async()=>{
 const source=Buffer.from(calendarMime),result=await inspectEmailSourceFiles(source,{calendar_parts:true});
 assert.equal(result.calendar_parts.status,'available');assert.equal(result.calendar_parts.parts.length,1);
 assert.equal(result.calendar_parts.parts[0].ics_text,ics);assert.equal(result.calendar_parts.parts[0].media_type_method,'REQUEST');
 assert.match(result.calendar_parts.parts[0].part_ref,/^[a-f0-9]{64}$/u);assert.deepEqual(source,calendarMime);
 const repeated=await inspectEmailSourceFiles(source,{calendar_parts:true});assert.deepEqual(repeated,result);
 const changed=await inspectEmailSourceFiles(Buffer.from(calendarMime.toString().replace('sender@example','changed@example')),{calendar_parts:true});
 assert.notEqual(changed.calendar_parts.parts[0].part_ref,result.calendar_parts.parts[0].part_ref);
});
test('MIME attachment nomination supports .ics without guessing body/URLs and preserves method',async()=>{
 const source=Buffer.from('MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nhttps://never-fetch.test/invite.ics\r\n--x\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=invite.ics\r\nContent-Transfer-Encoding: base64\r\n\r\n'+Buffer.from(ics).toString('base64')+'\r\n--x--\r\n');
 const result=await inspectEmailSourceFiles(source,{calendar_parts:true});assert.equal(result.calendar_parts.parts.length,1);assert.equal(result.calendar_parts.parts[0].ics_text,ics);
 assert.deepEqual((await inspectEmailSourceFiles(Buffer.from('Content-Type: text/plain\r\n\r\nBEGIN:VCALENDAR'),{calendar_parts:true})).calendar_parts,{status:'available',parts:[]});
});
test('decoded part count, aggregate bytes, charset, malformed UTF8 and method fail without partial invitations',()=>{
 const make=(bytes,charset='utf-8',method='REQUEST')=>({content:bytes,contentType:'text/calendar',headers:new Map([['content-type',{params:{charset,method}}]])});
 const digest=createHash('sha256').update(calendarMime).digest('hex');
 for(const [attachments,reason] of [
  [Array.from({length:9},()=>make(Buffer.from(ics))),'CALENDAR_PART_LIMIT'],
  [[make(Buffer.alloc(140000,97)),make(Buffer.alloc(140000,98))],'CALENDAR_TEXT_LIMIT'],
  [[make(Buffer.from(ics),'iso-8859-1')],'CALENDAR_CHARSET_UNSUPPORTED'],
  [[make(Buffer.from(ics),'us-ascii')],'CALENDAR_TEXT_INVALID'],
  [[make(Buffer.from([0xc3,0x28]))],'CALENDAR_TEXT_INVALID'],
  [[make(Buffer.from(ics),'utf-8','REQUEST;evil')],'CALENDAR_TEXT_INVALID'],
 ])assert.deepEqual(calendarPartsFromParsed({attachments},digest),{status:'unsupported',parts:[],reason});
});
test('identical alternative/download calendar bytes are one nomination while conflicting explicit methods remain visible',()=>{
 const part=method=>({content:Buffer.from(ics),contentType:'text/calendar',headers:new Map([['content-type',{params:{charset:'utf-8',...(method?{method}:{})}}]])});
 const one=calendarPartsFromParsed({attachments:[part(),part('REQUEST')]},'a'.repeat(64));assert.equal(one.parts.length,1);assert.equal(one.parts[0].media_type_method,'REQUEST');
 const conflict=calendarPartsFromParsed({attachments:[part('REQUEST'),part('REPLY')]},'a'.repeat(64));assert.equal(conflict.parts.length,2);
});
test('fresh final MIME authority check denies calendar results after parser work',async()=>{
 let calls=0;await assert.rejects(inspectEmailSourceFiles(calendarMime,{calendar_parts:true,check:async()=>{if(++calls===3)throw Error('revoked');}}),/revoked/);
});
