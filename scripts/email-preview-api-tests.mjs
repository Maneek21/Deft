import assert from 'node:assert/strict';
import {readdirSync,readFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {testDatabaseIsolation} from './email-preview-test-databases.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const api=resolve(root,'apps/api'),directory=resolve(api,'test');
const expected=[
 'email-mailbox-migration63-db.test.ts',
 'email-mailbox-native-imap-db.test.ts',
 'email-mailbox-native-provider-db.test.ts',
 'email-mailbox-scheduler-runtime-db.test.ts',
 'email-mailbox-store-db.test.ts',
];
const all=readdirSync(directory).filter(name=>name.endsWith('.test.ts')).sort();
const dedicated=all.filter(name=>readFileSync(resolve(directory,name),'utf8').includes('./fixtures/email-mailbox-database.js'));
assert.deepEqual(dedicated,expected,'Review every dedicated fixture test before changing the partition');
const automation='app-automation-renewal-acceptance-db.test.ts';
const isolation=JSON.parse(readFileSync(resolve(root,'scripts/email-preview-api-isolation.json'),'utf8'));
const discover=pattern=>all.filter(name=>pattern.test(readFileSync(resolve(directory,name),'utf8')));
assert.deepEqual(discover(/DEFT_APP_RUN_KEYRINGS\s*=/),isolation.keyring_writers,'Review new custom keyring writers');
assert.deepEqual(discover(/(?:purgeExpiredSecrets|purgeExpiredBatch|assertReferencedKeysAvailable|purgeExpiredPrivateAppCustody)\(|AppRunMaintenance/),
 isolation.global_maintenance_consumers,'Review new global maintenance consumers');
assert.deepEqual(discover(/(?:getAppRunRuntime|createAppRunRuntime)\(/),isolation.global_keyring_startup_consumers,
 'Review new startup keyring consumers');
assert.deepEqual([...new Set([...isolation.keyring_writers,...isolation.global_maintenance_consumers,
 ...isolation.global_keyring_startup_consumers])].sort(),isolation.isolated);
const isolated=isolation.isolated.filter(name=>!dedicated.includes(name)&&name!==automation);
const ordinary=all.filter(name=>!dedicated.includes(name)&&!isolated.includes(name)&&name!==automation);
assert.equal(new Set([...ordinary,...isolated,...dedicated,automation]).size,all.length,'Every API test must run exactly once');
assert.equal(ordinary.length+isolated.length+dedicated.length+1,all.length);
const main='postgres://postgres:postgres@localhost:5432/deft_test';
assert.equal(process.env.CI,'true');
assert.equal(process.env.DATABASE_URL,main);
assert.equal(process.env.DEFT_TEST_DATABASE_URL,main);
assert.ok(process.env.npm_execpath,'Invoke through the pnpm test:email-preview-api lifecycle');
const timeout=Number(process.env.DEFT_TEST_TIMEOUT_MS??1800000);
assert.ok(Number.isSafeInteger(timeout)&&timeout>0&&timeout<=1800000);
const deadline=Date.now()+timeout;
function remaining(cap=timeout){const budget=deadline-Date.now();assert.ok(budget>0,'Aggregate API test budget expired');return Math.min(cap,budget);}
process.env.DEFT_APPS_ENABLED='true';process.env.DEFT_APP_DEVELOPER_PAIRING_ENABLED='true';
let failed=false;
function run(name,args,environment,count){
 console.log(`[API partition] ${name}: ${count} files`);
 const result=spawnSync(process.execPath,[process.env.npm_execpath,...args],{
  cwd:api,env:{...process.env,...environment},stdio:'inherit',timeout:remaining(),
 });
 console.log(`[API partition] ${name}: exit=${result.status} error=${result.error?.code??'none'}`);
 if(result.error||result.status!==0)failed=true;
 return !result.error&&result.status===0;
}
const target='postgresql://gate_g_test@127.0.0.1:55435/email_stage34_test';
assert.match(process.env.GITHUB_RUN_ID??'',/^\d+$/);
assert.match(process.env.GITHUB_RUN_ATTEMPT??'',/^\d+$/);
const container=`email-mailbox-predecessor-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
function docker(args,options={}){
 const result=spawnSync('docker',args,{encoding:'utf8',timeout:remaining(30000),maxBuffer:128*1024*1024,...options});
 assert.equal(result.status,0,result.error?.message??result.stderr);
 return result.stdout.trim();
}
function assertPredecessor(){
 const [current]=JSON.parse(docker(['inspect',container]));
 assert.equal(current.Config.Labels['deft.test_fixture'],'email-mailbox-predecessor');
 assert.equal(current.Config.Labels['deft.test_run'],process.env.GITHUB_RUN_ID);
 assert.equal(current.Config.Labels['deft.test_attempt'],process.env.GITHUB_RUN_ATTEMPT);
 assert.equal(current.Config.Image,'pgvector/pgvector@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b');
 assert.equal(current.HostConfig.NetworkMode,'host');
 assert.deepEqual(current.Config.Cmd,['postgres','-c','listen_addresses=127.0.0.1','-p','55435']);
 const query=(database,sql)=>docker(['exec',container,'psql','-h','127.0.0.1','-p','55435','-U','gate_g_test',
  '-d',database,'--set','ON_ERROR_STOP=1','-AtF','|','-c',sql]);
 const identity="SELECT current_database(),current_user,inet_server_port(),host(inet_server_addr())";
 assert.equal(query('email_stage34_test',identity),'email_stage34_test|gate_g_test|55435|127.0.0.1');
 assert.equal(query('postgres',"SELECT count(*) FROM pg_stat_activity WHERE datname='email_stage34_test'"),'0',
  'never force-disconnect another test while resetting this CI-owned fixture');
 return query;
}
function resetPredecessor(){
 const query=assertPredecessor();
 const identity="SELECT current_database(),current_user,inet_server_port(),host(inet_server_addr())";
 query('postgres','DROP DATABASE email_stage34_test');
 query('postgres','CREATE DATABASE email_stage34_test OWNER gate_g_test');
 assert.equal(query('email_stage34_test',identity),'email_stage34_test|gate_g_test|55435|127.0.0.1');
 assert.equal(query('email_stage34_test',"SELECT count(*) FROM pg_tables WHERE schemaname='public'"),'0');
}
// Reject broken infrastructure before the long ordinary suite.
assertPredecessor();
const diagnostics=resolve(root,'.ci-api-diagnostics');mkdirSync(diagnostics,{recursive:true});
const database=testDatabaseIsolation({docker,mainContainer:process.env.DEFT_PREVIEW_POSTGRES_CONTAINER,
 predecessorContainer:container,runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,
 record:value=>{appendFileSync(resolve(diagnostics,'database-isolation.jsonl'),JSON.stringify(value)+'\n');console.log('[API database isolation]',JSON.stringify(value));}});
database.assertMain();
assert.ok(run('seed canonical test fixtures',['exec','tsx','src/scripts/seed-test-fixtures.ts'],{},0));
assert.ok(run('seed canonical platform bundles',['exec','tsx','src/scripts/seed-platform-bundles.ts'],{},0));
database.createTemplate();
database.prepareAutomation();
for(const name of isolated){
 database.restoreMain(name,'before');
 run(`isolated ${name}`,['exec','tsx','--experimental-test-module-mocks','--test',
  '--test-concurrency=1','--test-force-exit','test/'+name],{},1);
 database.restoreMain(name,'after');
}
run('ordinary',['test',...ordinary.map(name=>'test/'+name)],{},ordinary.length);
const automationTarget='postgresql://gate_g_test@127.0.0.1:55435/gate_g_20260926_automation_renewal';
run('dedicated automation renewal',['exec','tsx','--experimental-test-module-mocks','--test',
 '--test-concurrency=1','--test-force-exit','test/'+automation],
 {DATABASE_URL:automationTarget,DEFT_TEST_DATABASE_URL:automationTarget},1);
for(const name of dedicated){
 resetPredecessor();
 run(`mailbox predecessor ${name}`,['exec','tsx','--tsconfig','../../tsconfig.email-stage34.json','--test',
  '--experimental-test-module-mocks','--test-concurrency=1','--test-force-exit','test/'+name],
  {DATABASE_URL:target,DEFT_TEST_DATABASE_URL:target},1);
}
process.exitCode=failed?1:0;
