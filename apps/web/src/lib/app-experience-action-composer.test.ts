import assert from 'node:assert/strict';
import test from 'node:test';
import { composerCompletion, composerFields, composerRecoveryMode, createComposerSaver, mergeComposerDraft } from './app-experience-action-composer.js';

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
