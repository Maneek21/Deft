import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const TEST_POSTGRES_IMAGE='pgvector/pgvector@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b';
const identity='SELECT current_database(),current_user,inet_server_port(),host(inet_server_addr())';
const ledger="SELECT version,checksum,kind FROM deft_schema_migrations ORDER BY version";
const fingerprint=value=>createHash('sha256').update(value).digest('hex');
const waitBuffer=new Int32Array(new SharedArrayBuffer(4));

/** Destructive operations are confined to named ephemeral databases in the
 * exact GitHub service container. Never disconnect clients or disable guards. */
export function testDatabaseIsolation({docker,mainContainer,predecessorContainer,runId,attempt,record=()=>{},
 now=Date.now,pause=ms=>Atomics.wait(waitBuffer,0,0,ms)}){
 assert.match(mainContainer??'',/^[a-f0-9]{64}$/);
 assert.match(runId??'',/^\d+$/);assert.match(attempt??'',/^\d+$/);
 assert.equal(predecessorContainer,`email-mailbox-predecessor-${runId}-${attempt}`);
 const template=`deft_preview_template_${runId}_${attempt}`;
 assert.ok(template.length<=63);
 const query=(container,user,port,database,sql)=>docker(['exec',...(container===mainContainer?['--env','PGPASSWORD=postgres']:[]),container,'psql','-h','127.0.0.1','-p',port,
  '-U',user,'-d',database,'--set','ON_ERROR_STOP=1','-AtF','|','-c',sql]);
 const main=(database,sql)=>query(mainContainer,'postgres','5432',database,sql);
 let ledgerDigest;
 function assertMainIdentity(){
  const [current]=JSON.parse(docker(['inspect',mainContainer]));
  assert.equal(current.Id,mainContainer);assert.equal(current.State.Running,true);
  assert.equal(current.Config.Image,TEST_POSTGRES_IMAGE);
  for(const value of ['POSTGRES_USER=postgres','POSTGRES_PASSWORD=postgres','POSTGRES_DB=deft_test'])assert.ok(current.Config.Env.includes(value));
  assert.equal(current.Config.Labels['deft.test_fixture'],'email-preview-api');
  assert.equal(current.Config.Labels['deft.test_run'],runId);
  assert.equal(current.Config.Labels['deft.test_attempt'],attempt);
  assert.deepEqual(current.HostConfig.PortBindings['5432/tcp'],[{HostIp:'',HostPort:'5432'}]);
  assert.equal(main('deft_test',identity),'deft_test|postgres|5432|127.0.0.1');
 }
 function assertMain(){
  const deadline=now()+5000;
  while(true){
   assertMainIdentity();
   // Every Docker call also checks the runner's unchanged aggregate deadline.
   const clients=main('postgres',`SELECT count(*) FROM pg_stat_activity WHERE datname IN ('deft_test','${template}')`);
   assert.match(clients,/^\d+$/,'invalid active-client count');
   if(clients==='0')return;
   const remaining=deadline-now();
   assert.ok(remaining>0,'never force-disconnect another client during CI isolation');
   pause(Math.min(100,remaining));
  }
 }
 function verifyLedger(database){
  const actual=fingerprint(main(database,ledger));
  if(ledgerDigest)assert.equal(actual,ledgerDigest,'clones must retain the reviewed immutable migration ledger');
  return actual;
 }
 function createTemplate(){
  assertMain();
  assert.equal(main('postgres',`SELECT count(*) FROM pg_database WHERE datname='${template}'`),'0');
  assert.equal(main('deft_test','SELECT count(*) FROM deft_schema_migrations'),'113');
  assert.equal(main('deft_test','SELECT (SELECT count(*) FROM app_runs)+(SELECT count(*) FROM app_run_secret_payloads)+(SELECT count(*) FROM app_run_receipts)'),'0',
   'the seeded template must contain no retained Run authority or ciphertext');
  ledgerDigest=verifyLedger('deft_test');
  const start=Date.now();
  main('postgres',`CREATE DATABASE ${template} TEMPLATE deft_test OWNER postgres`);
  verifyLedger(template);
  record({phase:'template',elapsed_ms:Date.now()-start,ledger_sha256:ledgerDigest,
   size_bytes:Number(main(template,'SELECT pg_database_size(current_database())'))});
 }
 function restoreMain(file,phase){
  assert.ok(ledgerDigest,'create and verify the seeded template first');
  assertMain();verifyLedger(template);
  const start=Date.now();
  main('postgres','DROP DATABASE deft_test');
  main('postgres',`CREATE DATABASE deft_test TEMPLATE ${template} OWNER postgres`);
  assert.equal(main('deft_test',identity),'deft_test|postgres|5432|127.0.0.1');
  verifyLedger('deft_test');
  record({phase,file,elapsed_ms:Date.now()-start,ledger_sha256:ledgerDigest});
 }
 function prepareAutomation(){
  assert.ok(ledgerDigest);assertMain();verifyLedger(template);
  const [current]=JSON.parse(docker(['inspect',predecessorContainer]));
  assert.equal(current.Config.Image,TEST_POSTGRES_IMAGE);assert.equal(current.State.Running,true);
  assert.equal(current.Config.Labels['deft.test_fixture'],'email-mailbox-predecessor');
  assert.equal(current.Config.Labels['deft.test_run'],runId);assert.equal(current.Config.Labels['deft.test_attempt'],attempt);
  assert.equal(current.HostConfig.NetworkMode,'host');
  assert.deepEqual(current.Config.Cmd,['postgres','-c','listen_addresses=127.0.0.1','-p','55435']);
  const target='gate_g_20260926_automation_renewal';
  const remote=(database,sql)=>query(predecessorContainer,'gate_g_test','55435',database,sql);
  assert.equal(remote('postgres',identity),'postgres|gate_g_test|55435|127.0.0.1');
  assert.equal(remote('postgres',`SELECT count(*) FROM pg_database WHERE datname='${target}'`),'0');
  assert.equal(remote('postgres',`SELECT count(*) FROM pg_stat_activity WHERE datname='${target}'`),'0');
  const start=Date.now();
  remote('postgres',`CREATE DATABASE ${target} OWNER gate_g_test`);
  const dump=docker(['exec','--env','PGPASSWORD=postgres',mainContainer,'pg_dump','-h','127.0.0.1','-p','5432','-U','postgres',
   '--no-owner','--no-acl','-d',template]);
  assert.ok(Buffer.byteLength(dump)<128*1024*1024,'bounded synthetic seeded template only');
  docker(['exec','-i',predecessorContainer,'psql','-h','127.0.0.1','-p','55435','-U','gate_g_test',
   '-d',target,'--set','ON_ERROR_STOP=1'],{input:dump});
  assert.equal(remote(target,identity),`${target}|gate_g_test|55435|127.0.0.1`);
  assert.equal(fingerprint(remote(target,ledger)),ledgerDigest);
  record({phase:'automation-schema',elapsed_ms:Date.now()-start,ledger_sha256:ledgerDigest});
 }
 return {assertMain,createTemplate,restoreMain,prepareAutomation};
}
