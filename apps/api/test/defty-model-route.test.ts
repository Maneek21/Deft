import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouteSchema } from '@deft/shared';
import { llm } from '../src/lib/llm.js';
test('Sol effort validation is model-specific and leaves other provider tokens alone',()=>{
  for(const reasoning_effort of ['low','medium','high','xhigh','max']) assert.ok(ModelRouteSchema.safeParse({provider:'openai',model:'gpt-6.1-sol',reasoning_effort}).success);
  for(const reasoning_effort of ['none','minimal','invented']) assert.ok(!ModelRouteSchema.safeParse({provider:'openai',model:'gpt-6.1-sol',reasoning_effort}).success);
  assert.ok(ModelRouteSchema.safeParse({provider:'ollama',model:'custom',reasoning_effort:'minimal'}).success);
});
test('generic reason caller shares Responses transport and preserves both system inputs',async(t)=>{
  t.mock.method(globalThis,'fetch',async(url:unknown,init:RequestInit)=>{
    assert.match(String(url),/\/responses$/);const body=JSON.parse(String(init.body));assert.equal(body.instructions,'Outer policy\nInner policy');
    assert.equal(body.reasoning.effort,'low');assert.equal(body.model,'gpt-6.1-sol');
    return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Ready'}]}],usage:{input_tokens:8,output_tokens:2}});
  });
  const result=await llm({task:'reason',orgConfig:{api_keys:{openai:'test'},ai_models:{reason:{provider:'openai',model:'gpt-6.1-sol',reasoning_effort:'low'}}},system:'Outer policy',messages:[{role:'system',content:'Inner policy'},{role:'user',content:'Ping'}]});
  assert.equal(result.text,'Ready');assert.equal(result.toolCalls,undefined);assert.equal(result.model,'gpt-6.1-sol');assert.deepEqual(result.usage,{input:8,output:2});
});
