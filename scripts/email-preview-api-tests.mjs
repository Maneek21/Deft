import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

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
const ordinary=all.filter(name=>!dedicated.includes(name));
assert.equal(new Set([...ordinary,...dedicated]).size,all.length,'Every API test must run exactly once');
const main='postgres://postgres:postgres@localhost:5432/deft_test';
assert.equal(process.env.CI,'true');
assert.equal(process.env.DATABASE_URL,main);
assert.equal(process.env.DEFT_TEST_DATABASE_URL,main);
assert.ok(process.env.npm_execpath,'Invoke through pnpm exec');
const timeout=Number(process.env.DEFT_TEST_TIMEOUT_MS??900000);
assert.ok(Number.isSafeInteger(timeout)&&timeout>0&&timeout<=900000);
let failed=false;
function run(name,args,environment){
 console.log(`[API partition] ${name}: ${name==='ordinary'?ordinary.length:dedicated.length} files`);
 const result=spawnSync(process.execPath,[process.env.npm_execpath,...args],{
  cwd:api,env:{...process.env,...environment},stdio:'inherit',timeout,
 });
 console.log(`[API partition] ${name}: exit=${result.status} error=${result.error?.code??'none'}`);
 if(result.error||result.status!==0)failed=true;
}
run('ordinary',['test',...ordinary.map(name=>'test/'+name)],{});
const target='postgresql://gate_g_test@127.0.0.1:55435/email_stage34_test';
run('mailbox predecessor',['exec','tsx','--tsconfig','../../tsconfig.email-stage34.json','--test',
 '--test-concurrency=1','--test-force-exit',...dedicated.map(name=>'test/'+name)],
 {DATABASE_URL:target,DEFT_TEST_DATABASE_URL:target});
process.exitCode=failed?1:0;
