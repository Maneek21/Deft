import assert from 'node:assert/strict';
import test from 'node:test';
import * as runner from '../src/lib/agent-runner.js';
import * as worker from '../src/workers/handlers/agent-reply.js';
import { selectReasonProvider } from '../src/lib/org-ai-config.js';

test('system prompt instructs verbatim titles, link-style sources and no headings in chat unless a summary is requested', () => {
  const prompt = (runner as any).buildDeftySystemPrompt({ orgName: 'Deft', spaceType: 'public' });
  assert.ok(prompt.includes('1\u20135 sentences'));
  assert.ok(prompt.includes('KEY "exact title"'));
  assert.ok(prompt.includes('[Author, time](/chat?space=<spaceId>&message=<messageId>)'));
  assert.match(prompt, /headings only when.*summary or report/i);
  assert.match(prompt, /no unrequested extra sections/i);
  assert.match(prompt, /another (?:space|channel).*explicitly/i);
});

for (const fails of [false, true]) {
  test(`agent-reply emits agent:working started then finished${fails ? ' on failure' : ''}`, async () => {
    const events: any[] = [];
    const io = { to(room: string) { return { emit(event: string, payload: unknown) { events.push({ room, event, payload }); } }; } };
    const action = () => (worker as any).withAgentWorkingSignal({
      spaceId: 'space-1', threadId: 'thread-1', agentUserId: 'defty-1', io,
    }, async () => {
      assert.equal(events[0]?.payload.state, 'started');
      if (fails) throw new Error('reasoning failed');
      return 'finished work';
    });
    if (fails) await assert.rejects(action, /reasoning failed/);
    else assert.equal(await action(), 'finished work');
    assert.deepEqual(events.map((event) => [event.room, event.event, event.payload.state]), [
      ['space:space-1', 'agent:working', 'started'],
      ['space:space-1', 'agent:working', 'finished'],
    ]);
    assert.deepEqual(events[0].payload, {
      space_id: 'space-1', thread_id: 'thread-1', agent_user_id: 'defty-1', agent_name: 'Defty',
      state: 'started', label: 'Reading the conversation\u2026',
    });
  });
}

test('empty provider env keys with no org config produce the configure-AI reply', () => {
  for (const apiKey of ['', '   ', '  ']) {
    const selected = selectReasonProvider({ envApiKeys: { openai: apiKey, anthropic: apiKey, openrouter: apiKey } });
    assert.equal(selected.ready, false);
    assert.equal(selected.source, 'none');
  }
  const selectedRoute = selectReasonProvider({ route: { provider: 'openai', model: 'test' }, orgApiKeys: { openai: ' ' }, envApiKeys: { openai: ' ' } });
  assert.equal(selectedRoute.ready, false);
  const reply = (worker as any).deftyReplyForProviderError(new Error('anthropic API key not configured (org or env)'));
  assert.match(reply, /Settings \u2192 AI/);
  assert.doesNotMatch(reply, /retry/i);
});


test('channel conversation searches stay in the invoked room unless another channel is explicitly requested', () => {
  const surface = { type: 'private', name: 'planning' };
  const scope = (runner as any).scopeDeftyMessageSearch;
  assert.deepEqual(scope({query:'demo'}, 'catch me up', surface), {query:'demo',space_name:'planning'});
  assert.equal(scope({space_name:'secret',query:'demo'}, 'catch me up', surface).space_name, 'planning');
  assert.equal(scope({space_name:'release',query:'demo'}, 'what did the team decide in release?', surface).space_name, 'release');
  assert.equal(scope({space_name:'release',query:'demo'}, 'summarize #release', surface).space_name, 'release');
  assert.equal(scope({space_name:'release',query:'demo'}, 'summarize #release-secret', surface).space_name, 'planning');
});


test('chat activity results omit unscoped private-channel counts', () => {
  const safe = (runner as any).formatDeftyChatReadResult('get_user_activity', { user_name: 'Rahul', current_tasks: {todo: 1}, message_counts_by_space: {private: 5} });
  assert.deepEqual(safe, {user_name:'Rahul',current_tasks:{todo:1}});
});


test('a message search cannot bypass the requested room through space_id', () => {
  const surface = {type:'private',name:'planning'};
  assert.deepEqual((runner as any).scopeDeftyMessageSearch({space_id:'private-b',space_name:'other'},'catch me up',surface),{space_name:'planning'});
  assert.deepEqual((runner as any).scopeDeftyMessageSearch({space_id:'private-c',space_name:'launch'},'summarize #launch',surface),{space_name:'launch'});
});

test('chat does not offer org-wide unfiltered summary tools', () => {
  assert.equal((runner as any).isDeftyChatReadAllowed('prep_oneone'),false);
  assert.equal((runner as any).isDeftyChatReadAllowed('search_blockers'),false);
  assert.equal((runner as any).isDeftyChatReadAllowed('search_messages'),true);
});
