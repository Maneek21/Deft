import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HumanActionConfirmSchema, HumanActionPrepareSchema, humanActionDigest,
  sealHumanActionTicket, openHumanActionTicket } from '../src/lib/app-experience-human-action-contract.js';
import type { AppRunKeyProvider } from '../src/lib/app-run-keyrings.js';
import { AppExperienceHumanActionService } from '../src/lib/app-experience-human-action-service.js';
import type { AppRunRuntime } from '../src/lib/app-run-runtime.js';
const key = Buffer.alloc(32, 31);
const keys: AppRunKeyProvider = { current: () => ({ key_id: 'v1', key: Buffer.from(key) }),
  read: (_, id) => id === 'v1' ? { key_id: id, key: Buffer.from(key) } : null, keyIds: () => ['v1'] };
const input = { recipient: 'synthetic@example.test', body: 'Private exact text' };
const ticket = { org_id: randomUUID(), user_id: randomUUID(), sid: randomUUID(), session_id: randomUUID(),
  action_key: 'write', runtime_binding_id: randomUUID(), authority_digest: humanActionDigest({ version: 'v1' }),
  input, input_digest: humanActionDigest(input), idempotency_key: 'host:one', expires_at: new Date(Date.now() + 60_000).toISOString() };
test('sealed ticket roundtrip hides exact private input and retains authority', () => {
  const sealed = sealHumanActionTicket(keys, ticket);
  assert(!sealed.includes(input.body)); assert(!sealed.includes(input.recipient));
  assert.deepEqual(openHumanActionTicket(keys, sealed), ticket);
});
test('ticket tampering and foreign encryption keys fail closed', () => {
  const sealed = sealHumanActionTicket(keys, ticket);
  assert.throws(() => openHumanActionTicket(keys, sealed.slice(0, -1) + (sealed.endsWith('A') ? 'B' : 'A')));
  const foreign = { ...keys, read: () => ({ key_id: 'v1', key: Buffer.alloc(32, 23) }) };
  assert.throws(() => openHumanActionTicket(foreign, sealed));
});
test('confirm rejects replacement input, actor and fabricated click facts', () => {
  const request = { ticket: 'opaque', expected_input_digest: ticket.input_digest };
  assert(HumanActionConfirmSchema.safeParse(request).success);
  for (const extra of [{ input }, { initiating_actor: 'human' }, { trusted_click: true }, { policy: 'never' }]) {
    assert(!HumanActionConfirmSchema.safeParse({ ...request, ...extra }).success);
  }
});
test('prepare is closed scalar input; bounded and stable exact digest', () => {
  assert(HumanActionPrepareSchema.safeParse({ input, idempotency_key: 'host:one' }).success);
  assert(!HumanActionPrepareSchema.safeParse({ input: { body: ['unsafe'] }, idempotency_key: 'host:one' }).success);
  assert.notEqual(humanActionDigest(input), humanActionDigest({ ...input, body: 'changed' }));
  assert.equal(humanActionDigest(input), humanActionDigest({ body: input.body, recipient: input.recipient }));
});
test('foreign identity, expired ticket and substituted digest are rejected before authority work', async () => {
  let calls = 0;
  const authority = { async withHumanAction<T>(): Promise<T> { calls++; throw Error('unexpected authority access'); } };
  const service = new AppExperienceHumanActionService(authority, { keys } as AppRunRuntime);
  const caller = { org_id: ticket.org_id, user_id: ticket.user_id, sid: ticket.sid };
  const request = { ticket: sealHumanActionTicket(keys, ticket), expected_input_digest: ticket.input_digest };
  await assert.rejects(async () => service.confirm({ ...caller, sid: randomUUID() }, ticket.session_id, request));
  await assert.rejects(async () => service.confirm({ ...caller, org_id: randomUUID() }, ticket.session_id, request));
  await assert.rejects(async () => service.confirm(caller, ticket.session_id, { ...request, expected_input_digest: humanActionDigest('substitution') }));
  await assert.rejects(async () => service.confirm(caller, ticket.session_id, { ...request,
    ticket: sealHumanActionTicket(keys, { ...ticket, expires_at: new Date(0).toISOString() }) }));
  assert.equal(calls, 0);
});


test('ticket final fence includes database skew and elapsed final authority wait', async () => {
  const {assertHumanActionTicketDeadline}=await import('../src/lib/app-experience-human-action-contract.js');
  const deadline=new Date(1000).toISOString();
  assert.doesNotThrow(()=>assertHumanActionTicketDeadline(deadline,100,900,99));
  assert.throws(()=>assertHumanActionTicketDeadline(deadline,100,900,100));
  assert.throws(()=>assertHumanActionTicketDeadline(deadline,1000,100,0));
});

test('empty retained idempotency candidates cannot broaden the metadata lookup', async()=>{
  let selects=0;
  const authority={withHumanAction:async(_caller:unknown,_session:string,_action:string,use:any)=>use(
    {select:()=>{selects++;throw Error('unexpected unbounded select');}},
    {session:{app_installation_id:'install',app_version_id:'version',grant_snapshot_id:'grant'}},async()=>{})};
  const runtime={liveAuthorization:{captureReviewedRuntimeInTransaction:async()=>({protocol_version:'7',
    binding:{app_installation_id:'install',app_version_id:'version',grant_snapshot_id:'grant'}})},
    service:{retainedIdempotencyCandidates:()=>[]}} as unknown as AppRunRuntime;
  await assert.rejects(new AppExperienceHumanActionService(authority,runtime).lookup(
    {org_id:randomUUID(),user_id:randomUUID(),sid:randomUUID()},randomUUID(),'action',randomUUID()));
  assert.equal(selects,0);
});
