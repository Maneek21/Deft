import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readdir,writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
const root='C:/Users/Osheen Pradhan/.codex/worktrees/core-baseline-tests-20261003/Deft Main Repo';
const evidence='C:/tmp/deft-core-baseline-20261003';
const api=root+'/apps/api';
const requireApi=createRequire(api+'/package.json');
const {Client}=requireApi('pg');
const dbUrl='postgresql://deft_test@127.0.0.1:55433/deft_core_baseline_test';
const pnpm='C:/Users/Osheen Pradhan/AppData/Local/pnpm/.tools/pnpm/11.10.0/node_modules/pnpm/bin/pnpm.mjs';
const env={...process.env,TZ:'UTC',DATABASE_URL:dbUrl,DEFT_TEST_DATABASE_URL:dbUrl,JWT_SECRET:'baseline-test-only-secret-20261003',JWT_REFRESH_SECRET:'baseline-test-only-refresh-20261003',ENCRYPTION_KEY:'baseline-only-encryption-key-20261003-32chars',ANTHROPIC_API_KEY:'sk-ant-ci-dummy-not-a-real-key',OPENAI_API_KEY:'',OPENROUTER_API_KEY:'',OLLAMA_URL:'',DEFT_APPS_ENABLED:'true',DEFT_APP_DEVELOPER_PAIRING_ENABLED:'true',npm_execpath:pnpm};
const client=new Client({connectionString:dbUrl});await client.connect();
const target=(await client.query('SELECT current_database() db')).rows[0].db;if(target!=='deft_core_baseline_test')throw Error('Wrong target');
const tables=(await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(r=>'"'+r.tablename.replaceAll('"','""')+'"');
await client.query('TRUNCATE TABLE '+tables.join(',')+' RESTART IDENTITY CASCADE');await client.end();
const files=(await readdir(api+'/test')).filter(f=>f.endsWith('.test.ts')).sort();
await writeFile(evidence+'/api-utc-inventory.json',JSON.stringify({revision:'b567af6ff12e5e4c61dbc54eddde17a81b986a28',database:'deft_core_baseline_test',timezone:'UTC',files},null,2));
function run(args,name){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{cwd:api,env,windowsHide:true,stdio:['ignore','pipe','pipe']});const out=createWriteStream(evidence+'/'+name+'.log');child.stdout.pipe(out);child.stderr.pipe(out);child.once('error',reject);child.once('exit',code=>resolve(code));writeFile(evidence+'/api-utc-current-process.json',JSON.stringify({pid:child.pid,args,started_at:new Date().toISOString()}));});}
for(const seed of ['src/scripts/seed-test-fixtures.ts','src/scripts/seed-platform-bundles.ts']){const code=await run([pnpm,'exec','tsx',seed],seed.includes('fixtures')?'api-utc-fixture-seed':'api-utc-platform-seed');if(code!==0)throw Error('Seed failed:'+code);}
const started=Date.now();const code=await run([requireApi.resolve('tsx/cli'),'--test','--test-concurrency=1','--test-force-exit','--test-reporter=tap',...files.map(f=>'test/'+f)],'api-utc-suite');
await writeFile(evidence+'/api-utc-result.json',JSON.stringify({exit:code,duration_ms:Date.now()-started,files:files.length,timezone:'UTC',revision:'b567af6ff12e5e4c61dbc54eddde17a81b986a28'},null,2));process.exitCode=code;
