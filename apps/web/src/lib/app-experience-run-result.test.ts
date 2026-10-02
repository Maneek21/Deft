import assert from 'node:assert/strict';
import test from 'node:test';
import { experienceRunResult, readExperienceRunResult, EXPERIENCE_RUN_RESULT_MAX_BYTES } from './app-experience-run-result';
const id = '11111111-1111-4111-8111-111111111111';
const payload = () => ({ run: { id, result_expires_at: new Date(Date.now() + 60000).toISOString(), result_purged_at: null },
  value: { schema_version: 'deft.app_run_provider_result.v1', provider_succeeded: true,
    output: { transport_outcome: 'smtp_accepted', sent_copy_outcome: 'unknown', count: 1, confirmed: false } } });
test('retained result keeps generic transport and copy outcomes distinct as literal fields', () => {
  const result = experienceRunResult(payload(), id);
  assert.equal(result.providerSucceeded, true);
  assert.deepEqual(result.fields.slice(0,2), [{key:'transport_outcome',label:'transport outcome',value:'smtp_accepted'},
    {key:'sent_copy_outcome',label:'sent copy outcome',value:'unknown'}]);
  const literal = payload(); literal.value.output.transport_outcome = '<script>https://example.test</script>';
  assert.equal(experienceRunResult(literal,id).fields[0].value,literal.value.output.transport_outcome);
});
test('retained result rejects widening, nesting, wrong run, expiry and size overflow', () => {
  const valid = payload();
  const invalid = [{...valid,html:'bad'}, {...valid,run:{...valid.run,id:'22222222-2222-4222-8222-222222222222'}},
    {...valid,run:{...valid.run,result_expires_at:'2020-01-01T00:00:00.000Z'}}, {...valid,run:{...valid.run,result_purged_at:new Date().toISOString()}},
    {...valid,value:{...valid.value,schema_version:'other'}}, {...valid,value:{...valid.value,private:'bad'}},
    {...valid,value:{...valid.value,output:{nested:{body:'private'}}}}, {...valid,value:{...valid.value,output:{array:['bad']}}},
    {...valid,value:{...valid.value,output:{count:Infinity}}},
    {...valid,value:{...valid.value,output:Object.fromEntries(Array.from({length:33},(_,i)=>['field'+i,i]))}},
    {...valid,value:{...valid.value,output:{text:'a'.repeat(EXPERIENCE_RUN_RESULT_MAX_BYTES)}}}];
  for (const value of invalid) assert.throws(() => experienceRunResult(value,id));
});
test('result response stream is bounded before JSON decode and refuses aborted delivery', async () => {
  assert.equal((await readExperienceRunResult(new Response(JSON.stringify(payload()),{headers:{'content-type':'application/json'}}),id)).runId,id);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(EXPERIENCE_RUN_RESULT_MAX_BYTES));controller.enqueue(new Uint8Array(1));},cancel(){cancelled=true;}});
  await assert.rejects(readExperienceRunResult(new Response(stream,{headers:{'content-type':'application/json'}}),id));
  assert.equal(cancelled,true);
  const controller = new AbortController();controller.abort();
  await assert.rejects(readExperienceRunResult(new Response('{}',{headers:{'content-type':'application/json'}}),id,controller.signal));
});
