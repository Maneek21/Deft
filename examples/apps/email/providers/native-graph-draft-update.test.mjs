import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createGraphDraftSagaFixture as fixture,graphDraftFixtureMime as mime} from './native-graph-draft-fixture.mjs';
import {readDraftContent} from './native-draft-content.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
test('registered Graph saga patches supported fields and exact file diff while retaining matching IDs/CID/Bcc',async()=>{
 const f=await fixture();assert.deepEqual((await readDraftContent(mime(f.state))).parts,f.state.files.map(part=>({name:part.name,content_type:part.type,disposition:part.inline?'inline':'attachment',content_id:part.cid,content_digest:hash(part.bytes)})));const result=await f.adapter.nativeEmailDraftSync(f.input,f.context);assert.equal(result.outcome,'updated',JSON.stringify(result.limitations));assert.deepEqual(f.effects,['PATCH:immutable-mapped-draft','DELETE:remove-id','DELETE:change-id','POST:attachments','POST:attachments']);assert.equal(f.catalogCount,1);
 assert.equal(f.state.subject,'Updated résumé');assert.equal(f.state.body,'Updated body');assert.deepEqual(f.state.bcc,['blind@example.test']);assert.equal(f.state.files.find(part=>part.name==='keep.txt').id,'keep-id');assert.equal(f.state.files.find(part=>part.name==='inline.txt').id,'cid-id');assert.equal(f.state.files.find(part=>part.name==='inline.txt').cid,'logo');assert.equal(Buffer.from(f.state.files.find(part=>part.name==='add.txt').bytes).toString(),'Added exact ✓');assert.equal(f.state.files.some(part=>part.name==='remove.txt'),false);
 assert.deepEqual(Buffer.from(result.mime_bytes),mime(f.state));assert.equal(result.baseline_digest,hash(mime(f.state)));assert.ok(f.journal.values.get(f.input.operation_id).steps.every(step=>step.state==='applied'));assert.equal(f.reservations.length,5);
 const count=f.effects.length,reopened=await f.open();assert.equal((await reopened.nativeEmailDraftSync(f.input,f.context)).outcome,'updated');assert.equal(f.effects.length,count,'Settled saga never repeats writes');
});
test('restart proves lost attachment POST applied from exact expected content, then continues without duplicate',async()=>{
 const f=await fixture();f.losePost='after';assert.equal((await f.adapter.nativeEmailDraftSync(f.input,f.context)).outcome,'unknown');assert.equal(f.effects.filter(value=>value==='POST:attachments').length,1);assert.equal(f.journal.values.get(f.input.operation_id).steps[3].state,'unknown');
 f.unblock();const reopened=await f.open(),result=await reopened.nativeEmailDraftSync(f.input,f.context);assert.equal(result.outcome,'updated');assert.equal(f.effects.filter(value=>value==='POST:attachments').length,2,'Only remaining planned second attachment POST executes');assert.equal(f.state.files.filter(part=>part.name==='change.txt').length,1);assert.equal(f.state.files.filter(part=>part.name==='add.txt').length,1);
});
test('unknown POST with observed before-state never retries; changed pinned desired digest cannot resume',async()=>{
 const f=await fixture();f.losePost='before';assert.equal((await f.adapter.nativeEmailDraftSync(f.input,f.context)).outcome,'unknown');f.unblock();const reopened=await f.open();assert.equal((await reopened.nativeEmailDraftSync(f.input,f.context)).outcome,'unknown');assert.equal(f.effects.filter(value=>value==='POST:attachments').length,1);
 const changed=Buffer.from(f.input.desired.mime_bytes.toString().replace('Updated body','Changed local revision'));f.replaceDesired(changed);assert.equal((await reopened.nativeEmailDraftSync(f.input,f.context)).outcome,'conflict');assert.equal(f.effects.filter(value=>value==='POST:attachments').length,1);
});
test('external edit during saga stops without attachment deletion; unsupported types and divergent catalog never write',async()=>{
 const f=await fixture();f.externalAfterPatch=true;assert.equal((await f.adapter.nativeEmailDraftSync(f.input,f.context)).outcome,'conflict');assert.deepEqual(f.effects,['PATCH:immutable-mapped-draft']);assert.equal(f.state.subject,'External edit preserved');assert.equal(f.state.files.length,4);
 const unsupported=await fixture();unsupported.nonFile=true;assert.equal((await unsupported.adapter.nativeEmailDraftSync(unsupported.input,unsupported.context)).outcome,'unsupported');assert.equal(unsupported.effects.length,0);
 const divergent=await fixture();divergent.corruptCatalog=true;assert.equal((await divergent.adapter.nativeEmailDraftSync(divergent.input,divergent.context)).outcome,'conflict');assert.equal(divergent.effects.length,0);
});
test('reply-header change and independent plain/HTML alternatives refuse before any provider effect',async()=>{
 const f=await fixture();f.replaceDesired(Buffer.from(f.input.desired.mime_bytes.toString().replace('Subject:','In-Reply-To: <other@example.test>\r\nSubject:')));const result=await f.adapter.nativeEmailDraftSync(f.input,f.context);assert.equal(result.outcome,'unsupported');assert.ok(result.limitations.includes('reply_header_change_not_patchable'));assert.equal(f.effects.length,0);
 const dual=await fixture(),original=Buffer.from(dual.input.desired.mime_bytes).toString(),replacement='--saga\r\nContent-Type: multipart/alternative; boundary=alt\r\n\r\n--alt\r\nContent-Type: text/plain\r\n\r\nIndependent text\r\n--alt\r\nContent-Type: text/html\r\n\r\n<p>HTML body</p>\r\n--alt--\r\n';dual.replaceDesired(Buffer.from(original.replace('--saga\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nUpdated body\r\n',replacement)));const alternatives=await dual.adapter.nativeEmailDraftSync(dual.input,dual.context);assert.equal(alternatives.outcome,'unsupported');assert.ok(alternatives.limitations.includes('independent_plain_html_alternatives_not_patchable'));assert.equal(dual.effects.length,0);
});
