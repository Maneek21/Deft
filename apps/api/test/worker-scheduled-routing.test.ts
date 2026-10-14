import test from 'node:test';
import assert from 'node:assert/strict';

test('retired mailbox jobs have no executable handler even if the old feature flag is enabled',async()=>{
  const old=process.env.DEFT_NATIVE_EMAIL_ENABLED;process.env.DEFT_NATIVE_EMAIL_ENABLED='true';
  try{const workers=await import('../src/workers/index.js');
    for(const name of ['native-email-sync','native-email-outbox','native-email-sent-copy','native-email-draft-sync','native-email-draft-cleanup','native-email-notification-dispatch','native-email-timers','native-email-knowledge','email-knowledge-repair'])assert.equal(await workers._getScheduledJobHandlerForTest(name),null);
  }finally{if(old===undefined)delete process.env.DEFT_NATIVE_EMAIL_ENABLED;else process.env.DEFT_NATIVE_EMAIL_ENABLED=old;}
});

test('scheduled chat-knowledge-batch resolves to a real handler', async () => {
  const workers = await import('../src/workers/index.js');
  const handler = await workers._getScheduledJobHandlerForTest('chat-knowledge-batch');

  assert.equal(typeof handler, 'function');
});

test('scheduled notification-attention-sync resolves to a real handler', async () => {
  const workers = await import('../src/workers/index.js');
  const handler = await workers._getScheduledJobHandlerForTest('notification-attention-sync');

  assert.equal(typeof handler, 'function');
});

test('durable scheduled-message-send resolves to a real handler', async () => {
  const workers = await import('../src/workers/index.js');
  const handler = await workers._getScheduledJobHandlerForTest('scheduled-message-send');

  assert.equal(typeof handler, 'function');
});

test('App automation scan and exact-fire delivery resolve through scheduled jobs', async () => {
  const workers = await import('../src/workers/index.js');
  assert.equal(typeof await workers._getScheduledJobHandlerForTest('app-automation-scan'), 'function');
  assert.equal(typeof await workers._getScheduledJobHandlerForTest('app-automation-fire'), 'function');
});

test('governed App Run attempts resolve through the agent-job worker registry', async () => {
  const workers = await import('../src/workers/index.js');
  const handler = await workers._getAgentJobHandlerForTest('app-run-attempt');

  assert.equal(typeof handler, 'function');
});
