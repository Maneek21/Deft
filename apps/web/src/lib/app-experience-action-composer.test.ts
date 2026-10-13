import assert from 'node:assert/strict';
import test from 'node:test';
import { composerCompletion, composerFields, composerValidationError, composerRecoveryMode, createComposerSaver, mergeComposerDraft } from './app-experience-action-composer.js';
import { recoveryIdentity } from './app-experience-draft-recovery.js';

test('single-line subject feedback matches host validation without truncation', () => {
  const fields = composerFields({ type: 'object', additionalProperties: false, required: ['subject'],
    properties: { subject: { type: 'string', maxLength: 200, minLength: 1, format: 'single_line' } } });
  for (const subject of ['', 'x'.repeat(201), 'x\r\nBcc: other@example.test', 'x\0y']) {
    assert.ok(composerValidationError(fields, { subject }));
  }
  assert.equal(composerValidationError(fields, { subject: 'x'.repeat(200) }), null);
});

test('Stage1 mailbox scalars and hidden immutable record field retain exact input without normalization',()=>{
 const schema={type:'object',additionalProperties:false,required:['to','cc','parent_record_id'],properties:{to:{type:'string',maxLength:2048,minLength:1,format:'mailbox_list',maxItems:32},cc:{type:'string',maxLength:2048,format:'mailbox_list',maxItems:32},parent_record_id:{type:'string',maxLength:36,minLength:0,format:'resource_record_list',maxItems:1,resourceKey:'inbox',readOnly:true}}};
 const fields=composerFields(schema),parent=fields.find(field=>field.key==='parent_record_id');assert.equal(parent?.readOnly,true);assert.equal(parent?.resourceKey,'inbox');
 const input={to:'"Sender, One" <one@example.test>, Two <two@example.test>',cc:'',parent_record_id:'12345678-1234-4234-8234-123456789012'};const copy={...input};assert.equal(composerValidationError(fields,input),null);assert.deepEqual(input,copy);assert.equal(composerValidationError(fields,{...input,parent_record_id:''}),null);
 for(const to of ['one@example.test\0','x'.repeat(2049),Array.from({length:33},(_,i)=>`person${i}@example.test`).join(', ')])assert.ok(composerValidationError(fields,{...input,to}));
 assert.ok(composerValidationError(fields,{...input,parent_record_id:'provider/42'}));
 for(const property of [{...schema.properties.to,maxItems:33},{...schema.properties.to,maxLength:2049}])assert.throws(()=>composerFields({...schema,properties:{...schema.properties,to:property}}));
 const saved={mode:'reply_all',to:'old@example.test',cc:'',subject:'Subject',body:'Body',reply_record_id:input.parent_record_id};assert.deepEqual(mergeComposerDraft(saved,input),{...saved,to:input.to});
});

test('browser draft keys and encryption AAD separate targets while preserving primary recovery', () => {
  const scope = { orgId: '00000000-0000-4000-8000-000000000001', userId: '00000000-0000-4000-8000-000000000002',
    installationId: '00000000-0000-4000-8000-000000000003', recordId: '00000000-0000-4000-8000-000000000004', stateKey: 'drafts' };
  const primary = recoveryIdentity(scope);
  assert.deepEqual(recoveryIdentity({ ...scope, resourceTargetKey: 'primary' }), primary);
  assert.equal(primary.id, JSON.stringify([scope.orgId, scope.userId, scope.installationId, scope.stateKey, scope.recordId]));
  const personal = recoveryIdentity({ ...scope, resourceTargetKey: 'personal' }), work = recoveryIdentity({ ...scope, resourceTargetKey: 'work' });
  assert.notEqual(personal.owner, work.owner); assert.notEqual(personal.id, work.id); assert.notEqual(personal.id, primary.id);
  assert.throws(() => recoveryIdentity({ ...scope, resourceTargetKey: '../work' }));
});

test('trusted composer retains declared format and read-only source context', () => {
  const fields=composerFields({type:'object',additionalProperties:false,required:['to','parent'],properties:{
    to:{type:'string',maxLength:200,minLength:1,format:'email',title:'Recipient'},parent:{type:'string',maxLength:200,readOnly:true,title:'Source reference'}}});
  assert.equal(fields[0].label,'Recipient');
  assert.equal((fields[0] as unknown as {format:string}).format,'email');
  assert.equal((fields[1] as unknown as {readOnly:boolean}).readOnly,true);
});

test('retired close and confirmed-send callbacks cannot complete a replacement composer', async () => {
  let identity = {active:true,generation:1}, closeCalls = 0, resultCalls = 0;
  let release!:()=>void;
  const held = new Promise<void>(resolve=>{release=resolve;});
  const closeCurrent = composerCompletion(()=>identity), sendCurrent = composerCompletion(()=>identity);
  const closing = held.then(()=>{if(closeCurrent())closeCalls++;});
  const confirming = held.then(()=>{if(sendCurrent()){resultCalls++;closeCalls++;}});
  identity={active:true,generation:2};release();await Promise.all([closing,confirming]);
  assert.equal(closeCalls,0);assert.equal(resultCalls,0);
  const latest = composerCompletion(()=>identity);assert.equal(latest(),true);
  identity={...identity,active:false};assert.equal(latest(),false);
  identity={active:true,generation:3};assert.equal(latest(),false);
  identity={active:false,generation:4};const inactive = composerCompletion(()=>identity);identity={...identity,active:true};assert.equal(inactive(),false);
});

test('host composer preserves opaque draft fields and exposes every execution field', () => {
  const fields = composerFields({ type: 'object', additionalProperties: false, properties: { body: { type: 'string', maxLength: 4096 }, message_id: { type: 'string', maxLength: 200 } }, required: ['body', 'message_id'] });
  assert.deepEqual(fields.map(field => field.key), ['message_id', 'body']);
  assert.equal(fields[0].label, 'Message ID');
  assert.deepEqual(mergeComposerDraft({ mode: 'reply', body: 'old', reply_record_id: 'parent' }, { body: 'new', message_id: 'opaque' }), { mode: 'reply', body: 'new', reply_record_id: 'parent' });
  assert.throws(() => composerFields({ type: 'object', properties: {} }));
});

test('canonical property sorting does not reorder the declared short-field flow or put long text first', () => {
  const fields = composerFields({ type:'object',additionalProperties:false,properties:{ body:{type:'string',maxLength:4096},
    reference:{type:'string',maxLength:200},subject:{type:'string',maxLength:200},to:{type:'string',maxLength:200}},required:['to','subject','body'] });
  assert.deepEqual(fields.map(field=>field.key),['to','subject','reference','body']);
});
test('immediate host saves serialize CAS and persist the latest edit behind an outstanding write', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const calls: Array<{ revision: number; body: unknown }> = [];
  const saver = createComposerSaver(3, async (revision, value) => { calls.push({ revision, body: value.body }); if (calls.length === 1) await held; return revision + 1; });
  saver.change({ body: 'first' }); saver.change({ body: 'last keystroke' });
  assert.equal(calls.length, 1); assert.equal(saver.dirty, true); release(); await saver.flush();
  assert.deepEqual(calls, [{ revision: 3, body: 'first' }, { revision: 4, body: 'last keystroke' }]); assert.equal(saver.dirty, false); assert.equal(saver.revision, 5);
});
test('ambiguous save blocks retries and terminal close prevents late edits', async () => {
  let calls = 0;
  const saver = createComposerSaver(0, async () => { calls++; throw new Error('unconfirmed'); });
  saver.change({ body: 'retained in memory' }); await saver.flush(); saver.change({ body: 'later' }); await saver.flush(true);
  assert.equal(saver.blocked, true); assert.equal(saver.dirty, true); assert.equal(calls, 1);
  saver.close(); saver.change({ body: 'stale' }); await saver.flush(); assert.equal(calls, 1);
});

test('reload restores same-revision local edits without routine recovery prompt; true conflicts remain explicit', () => {
  const saved = { body: 'saved', recipient: 'recipient@example.test' };
  assert.equal(composerRecoveryMode(saved, 4, { baseRevision:4, value:{...saved,body:'last unsaved edit'} }), 'restore');
  assert.equal(composerRecoveryMode(saved, 5, { baseRevision:4, value:{...saved,body:'last unsaved edit'} }), 'conflict');
  assert.equal(composerRecoveryMode(saved, 4, { baseRevision:4, value:saved, submission:{state:'pending'} }), 'submission');
  assert.equal(composerRecoveryMode(saved, 4, { baseRevision:4, value:{recipient:saved.recipient,body:saved.body} }), 'none');
});

test('a save whose response was lost is acknowledged by a current read without repeating its write', async () => {
  let writes = 0;
  const saver = createComposerSaver(3, async () => { writes++; throw Error('response lost'); });
  saver.change({body:'kept'}); await saver.flush(); assert.equal(saver.blocked,true);
  assert.equal(saver.resumeAfterRead(4,true),true);
  await saver.flush(); assert.equal(writes,1); assert.equal(saver.revision,4); assert.equal(saver.dirty,false);
  saver.close(); assert.equal(saver.resumeAfterRead(4,true),false);
});

test('a recovered connection resumes CAS only after the current read agrees with the original revision', async () => {
  let writes = 0;
  const saver = createComposerSaver(3, async revision => { if (++writes === 1) throw Error('offline'); return revision+1; });
  saver.change({body:'kept'}); await saver.flush();
  assert.equal(composerRecoveryMode({body:'old'},3,{baseRevision:saver.revision,value:{body:'kept'}}),'restore');
  assert.equal(saver.resumeAfterRead(3,false),true); await saver.flush();
  assert.equal(writes,2); assert.equal(saver.revision,4); assert.equal(saver.dirty,false);
  assert.equal(saver.resumeAfterRead(2,true),false);
});


test('trusted form validates declared recipient before submission', () => {
  const fields=composerFields({type:'object',additionalProperties:false,required:['to'],properties:{to:{type:'string',maxLength:200,format:'email'}}});
  for (const to of ['not-an-email','a@example.test,b@example.test','a@example.test\r\nBcc:b@example.test']) assert.ok(composerValidationError(fields,{to}));
  assert.equal(composerValidationError(fields,{to:'recipient@example.test'}),null);
});

test('composer rejects unknown schema keys and malformed required or field constraints', () => {
 const schema={type:'object',additionalProperties:false,required:['subject'],properties:{subject:{type:'string',maxLength:200}}};
 for(const value of [{...schema,hidden_authority:true},{...schema,required:['missing']},{...schema,required:['subject','subject']},
  {...schema,properties:{subject:{...schema.properties.subject,pattern:'.*'}}},{...schema,properties:{subject:{...schema.properties.subject,minLength:201}}},
  {...schema,properties:{subject:{...schema.properties.subject,readOnly:'true'}}},{...schema,properties:{subject:{...schema.properties.subject,title:'<script>'}}}])assert.throws(()=>composerFields(value));
});

test('plain editor keeps correctable text while Send rejects unsupported content', () => {
  const fields = composerFields({ type: 'object', properties: { body: { type: 'string', maxLength: 4096 } }, required: ['body'], additionalProperties: false });
  assert.equal(composerValidationError(fields, { body: 'Line one\nLine two\t✓' }), null);
  assert.match(composerValidationError(fields, { body: 'kept\0input' })!, /unsupported control characters/);
  assert.match(composerValidationError(fields, { body: '\ud800' })!, /unsupported control characters/);
  assert.match(composerValidationError(fields, { body: 'a'.repeat(4097) })!, /body/);
});

test('file mutation flushes preceding scalar edits and subsequent edits use the acknowledged file revision', async () => {
  let releaseWrite!: () => void, releaseFile!: () => void;
  const writeHeld = new Promise<void>(resolve => { releaseWrite = resolve; });
  const fileHeld = new Promise<void>(resolve => { releaseFile = resolve; });
  const calls: string[] = [];
  const saver = createComposerSaver(3, async (revision, value) => {
    calls.push(`save:${revision}:${value.body}`); if (calls.length === 1) await writeHeld; return revision + 1;
  });
  saver.change({ body: 'first' }); saver.change({ body: 'before file' });
  const file = saver.mutate(async revision => { calls.push(`file:${revision}`); await fileHeld; return { revision: revision + 1, value: 'ready' }; });
  saver.change({ body: 'after file' }); releaseWrite();
  // Wait for the mutation itself to begin, without a timing-dependent sleep.
  while (!calls.some(call => call.startsWith('file:'))) await Promise.resolve();
  assert.deepEqual(calls, ['save:3:first', 'save:4:before file', 'file:5']);
  assert.equal(saver.saving, true); assert.equal(saver.resumeAfterRead(6, true), false);
  releaseFile(); assert.equal(await file, 'ready'); await saver.flush();
  assert.deepEqual(calls, ['save:3:first', 'save:4:before file', 'file:5', 'save:6:after file']);
  assert.equal(saver.revision, 7); assert.equal(saver.dirty, false);
});

test('lost file response blocks queued autosave until an authenticated current read reconciles it', async () => {
  let calls = 0;
  const saver = createComposerSaver(4, async revision => { calls++; return revision + 1; });
  await assert.rejects(saver.mutate(async () => { saver.change({ body: 'retained' }); throw Error('response lost'); }));
  await saver.flush(); assert.equal(saver.blocked, true); assert.equal(saver.dirty, true); assert.equal(calls, 0);
  await assert.rejects(saver.mutate(async revision => ({ revision: revision + 1, value: null })));
  assert.equal(saver.resumeAfterRead(5, false), true); await saver.flush();
  assert.equal(calls, 1); assert.equal(saver.revision, 6);
});

test('file lane rejects concurrent mutation, stale revisions and late completion after close', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const saver = createComposerSaver(4, async revision => revision + 1);
  const first = saver.mutate(async revision => { await held; return { revision: revision + 1, value: null }; });
  await assert.rejects(saver.mutate(async revision => ({ revision: revision + 1, value: null })));
  saver.close(); release(); await assert.rejects(first); assert.equal(saver.revision, 4);
  const current = createComposerSaver(4, async revision => revision + 1);
  await assert.rejects(current.mutate(async () => ({ revision: 3, value: null })));
  assert.equal(current.blocked, true); assert.equal(current.revision, 4);
});
