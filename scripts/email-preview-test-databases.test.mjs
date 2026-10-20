import assert from 'node:assert/strict';
import test from 'node:test';
import {TEST_POSTGRES_IMAGE,testDatabaseIsolation,waitForNoDatabaseClients} from './email-preview-test-databases.mjs';

const id='a'.repeat(64),runId='1234',attempt='2';
function fixture(overrides={}){
 const commands=[];
 let template=false,automation=false,time=0;
 const pauses=[];
 const main={Id:id,State:{Running:true},Config:{Image:TEST_POSTGRES_IMAGE,Env:['POSTGRES_USER=postgres','POSTGRES_PASSWORD=postgres','POSTGRES_DB=deft_test'],Labels:{
  'deft.test_fixture':'email-preview-api','deft.test_run':runId,'deft.test_attempt':attempt}},
  HostConfig:{PortBindings:{'5432/tcp':[{HostIp:'',HostPort:'5432'}]}}};
 const peer={State:{Running:true},Config:{Image:TEST_POSTGRES_IMAGE,Labels:{
  'deft.test_fixture':'email-mailbox-predecessor','deft.test_run':runId,'deft.test_attempt':attempt},
  Cmd:['postgres','-c','listen_addresses=127.0.0.1','-p','55435']},HostConfig:{NetworkMode:'host'}};
 overrides.edit?.(main,peer);
 const docker=(args,options={})=>{
  commands.push({args,options});
  if(args[0]==='inspect')return JSON.stringify([args[1]===id?main:peer]);
  if(args.includes('pg_dump')){assert.deepEqual(args.slice(0,4),['exec','--env','PGPASSWORD=postgres',id]);return '-- bounded synthetic schema dump\n';}
  if(args[1]==='-i'){assert.equal(options.input,'-- bounded synthetic schema dump\n');return'';}
  const database=args[args.indexOf('-d')+1],sql=args.at(-1),isMain=args.includes(id);
  if(isMain)assert.deepEqual(args.slice(0,4),['exec','--env','PGPASSWORD=postgres',id]);
  else assert.ok(!args.includes('PGPASSWORD=postgres'));
  if(sql.startsWith('SELECT current_database'))return overrides.identity??`${database}|${isMain?'postgres':'gate_g_test'}|${isMain?'5432':'55435'}|127.0.0.1`;
  if(sql.includes('pg_stat_activity'))return String(typeof overrides.clients==='function'?overrides.clients():overrides.clients??0);
  if(sql.includes('pg_database WHERE'))return sql.includes('automation_renewal')?String(overrides.automationExisting??Number(automation)):String(overrides.templateExisting??Number(template));
  if(sql==='SELECT count(*) FROM deft_schema_migrations')return overrides.ledgerCount??'118';
  if(sql.includes('app_run_secret_payloads'))return String(overrides.retained??0);
  if(sql.includes('SELECT version,checksum,kind'))return overrides.corruptTemplate&&database.startsWith('deft_preview_template_')?'wrong ledger':'001|abcd|baseline\n130|def|migration';
  if(sql.startsWith('SELECT pg_database_size'))return'1024';
  if(sql.startsWith('CREATE DATABASE deft_preview_template_'))template=true;
  else if(sql.startsWith('CREATE DATABASE gate_g_'))automation=true;
  else assert.ok(sql==='DROP DATABASE deft_test'||sql==='CREATE DATABASE deft_test TEMPLATE deft_preview_template_1234_2 OWNER postgres',sql);
  return'';
 };
 return {commands,pauses,instance:testDatabaseIsolation({docker,mainContainer:id,
  predecessorContainer:`email-mailbox-predecessor-${runId}-${attempt}`,runId,attempt,
  now:()=>time,pause:ms=>{pauses.push(ms);time+=ms;overrides.onPause?.(main);}})};
}
const destructive=commands=>commands.filter(({args})=>/^(?:DROP|CREATE) DATABASE/.test(args.at(-1)));

test('exact disposable fixture clones preserve the seeded ledger and automation identity',()=>{
 const {instance,commands}=fixture();instance.createTemplate();
 instance.restoreMain('one.test.ts','before');instance.restoreMain('one.test.ts','after');instance.prepareAutomation();
 assert.equal(commands.filter(({args})=>args.at(-1)==='DROP DATABASE deft_test').length,2);
 assert.equal(commands.filter(({args})=>args.includes('pg_dump')).length,1);
 assert.equal(destructive(commands).length,6);
 assert.ok(commands.every(({args})=>!args.some(value=>/FORCE|DISABLE TRIGGER/.test(value))));
});

for(const [name,overrides] of [
 ['wrong image',{edit(main){main.Config.Image='other:latest';}}],
 ['wrong run',{edit(main){main.Config.Labels['deft.test_run']='999';}}],
 ['wrong attempt',{edit(main){main.Config.Labels['deft.test_attempt']='3';}}],
 ['wrong container',{edit(main){main.Id='b'.repeat(64);}}],
 ['wrong port',{edit(main){main.HostConfig.PortBindings['5432/tcp'][0].HostPort='5433';}}],
 ['stopped container',{edit(main){main.State.Running=false;}}],
 ['wrong initialization password',{edit(main){main.Config.Env=['POSTGRES_USER=postgres','POSTGRES_PASSWORD=wrong','POSTGRES_DB=deft_test'];}}],
 ['active clients',{clients:1}],['wrong DB identity',{identity:'production|postgres|5432|127.0.0.1'}],
 ['existing template',{templateExisting:1}],['retained Run keys',{retained:1}],
 ['schema118 ledger',{ledgerCount:'114'}],
 ['schema119 ledger',{ledgerCount:'115'}],
 ['schema120 ledger',{ledgerCount:'116'}],
 ['schema128 ledger',{ledgerCount:'117'}],
 ['unreviewed future ledger',{ledgerCount:'119'}],
])test(`refuses ${name} before any destructive command`,()=>{
 const {instance,commands}=fixture(overrides);assert.throws(()=>instance.createTemplate());assert.equal(destructive(commands).length,0);
});

test('a corrupted template prevents subsequent DROP',()=>{
 const overrides={},state=fixture(overrides);state.instance.createTemplate();
 overrides.corruptTemplate=true;assert.throws(()=>state.instance.restoreMain('one.test.ts','before'));
 assert.equal(state.commands.filter(({args})=>args.at(-1)==='DROP DATABASE deft_test').length,0);
});
test('existing automation target is not overwritten',()=>{
 const {instance,commands}=fixture({automationExisting:1});instance.createTemplate();
 assert.throws(()=>instance.prepareAutomation());
 assert.equal(commands.filter(({args})=>args.at(-1).startsWith('CREATE DATABASE gate_g_')).length,0);
 assert.equal(commands.filter(({args})=>args.includes('pg_dump')).length,0);
});

test('a transient PostgreSQL backend close lag clears before the guarded database reset',()=>{
 const overrides={},state=fixture(overrides);state.instance.createTemplate();
 let observations=0;overrides.clients=()=>++observations===1?1:0;
 const start=state.commands.length;
 state.instance.restoreMain('next.test.ts','before');
 const commands=state.commands.slice(start);
 assert.equal(observations,2);assert.deepEqual(state.pauses,[100]);
 assert.equal(commands.filter(({args})=>args[0]==='inspect').length,2);
 const drop=commands.findIndex(({args})=>args.at(-1)==='DROP DATABASE deft_test');
 const counts=commands.map(({args},index)=>args.at(-1).includes('pg_stat_activity')?index:-1).filter(index=>index>=0);
 assert.ok(counts.every(index=>index<drop));
});

test('persistent clients exhaust the bounded wait without a reset or forced disconnect',()=>{
 const overrides={},state=fixture(overrides);state.instance.createTemplate();overrides.clients=1;
 const start=state.commands.length;
 assert.throws(()=>state.instance.restoreMain('next.test.ts','before'),/never force-disconnect/);
 assert.equal(state.pauses.reduce((sum,ms)=>sum+ms,0),5000);
 assert.equal(destructive(state.commands.slice(start)).length,0);
 assert.ok(state.commands.every(({args})=>!args.some(value=>/FORCE|pg_terminate_backend/.test(value))));
});

test('identity drift while waiting refuses reset even if the client subsequently exits',()=>{
 const overrides={},state=fixture(overrides);state.instance.createTemplate();
 overrides.clients=1;overrides.onPause=main=>{main.Config.Labels['deft.test_run']='999';overrides.clients=0;};
 const start=state.commands.length;
 assert.throws(()=>state.instance.restoreMain('next.test.ts','before'));
 assert.deepEqual(state.pauses,[100]);assert.equal(destructive(state.commands.slice(start)).length,0);
});

test('a client query failure or aggregate deadline expiry never proceeds to reset',()=>{
 for(const message of ['psql failed','Aggregate API test budget expired']){
  const overrides={},state=fixture(overrides);state.instance.createTemplate();
  let observations=0;overrides.clients=()=>{if(++observations===1)return 1;throw new Error(message);};
  const start=state.commands.length;
  assert.throws(()=>state.instance.restoreMain('next.test.ts','before'),{message});
  assert.deepEqual(state.pauses,[100]);assert.equal(destructive(state.commands.slice(start)).length,0);
 }
});

test('an invalid active-client response fails closed before reset',()=>{
 const overrides={},state=fixture(overrides);state.instance.createTemplate();overrides.clients='not a count';
 const start=state.commands.length;
 assert.throws(()=>state.instance.restoreMain('next.test.ts','before'),/invalid active-client count/);
 assert.equal(destructive(state.commands.slice(start)).length,0);
});

test('a persistent backend is diagnosed once after the bounded idle wait',()=>{
 let time=0,identities=0,diagnostics=0;
 assert.throws(()=>waitForNoDatabaseClients({assertIdentity:()=>{identities++;},count:()=> '1',timeoutMs:100,
  now:()=>time,pause:ms=>{time+=ms;},diagnose:()=>{diagnostics++;return 'pid=fixture,state=idle';},
  error:'guarded fixture stayed busy'}),/guarded fixture stayed busy: pid=fixture,state=idle/);
 assert.equal(time,100);assert.equal(identities,2);assert.equal(diagnostics,1);
});
