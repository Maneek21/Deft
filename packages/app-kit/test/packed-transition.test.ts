import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,writeFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {seedPackedConsumerLock} from './fixtures/packed-consumer-lock.js';

const kit=resolve(import.meta.dirname,'..');
function run(args:string[],cwd:string){const r=spawnSync(process.execPath,args,{cwd,encoding:'utf8',timeout:180_000});assert.equal(r.status,0,`${r.error??''}\n${r.stdout}\n${r.stderr}`);return r.stdout;}
test('packed alpha.40 preserves old consumer types and a non-mail build has no mailbox or sandbox code',async()=>{
 assert.ok(process.env.npm_execpath,'Run through pnpm');
 const root=await mkdtemp(join(tmpdir(),'deft-kit-transition-')),pack=join(root,'pack'),consumer=join(root,'consumer');
 await mkdir(pack);await mkdir(consumer);
 run([process.env.npm_execpath,'--dir',kit,'pack','--pack-destination',pack,'--json'],kit);
 const archive=join(pack,(await readdir(pack)).find(p=>p.endsWith('.tgz'))!);
 await writeFile(join(consumer,'package.json'),JSON.stringify({name:'non-mail-work-orders',private:true,type:'module',dependencies:{'@deft/app-kit':'file:'+archive.replaceAll('\\','/')}}));
 await seedPackedConsumerLock({packageRoot:kit,consumerDir:consumer,archive});
 run([process.env.npm_execpath,'--dir',consumer,'install','--offline','--frozen-lockfile','--ignore-workspace','--ignore-scripts'],kit);
 await writeFile(join(consumer,'legacy.ts'),await readFile(join(kit,'test/fixtures/alpha38-39-mail-consumer.ts')));
 const tsc=join(dirname(fileURLToPath(import.meta.resolve('typescript'))),'tsc.js');
 run([tsc,'--noEmit','--strict','--skipLibCheck','--module','NodeNext','--target','ES2022','legacy.ts'],consumer);
 const installed=await realpath(join(consumer,'node_modules/@deft/app-kit'));
 const cli=join(installed,'dist/cli.js');run([cli,'app','init','--template','runtime'],consumer);run([cli,'app','build'],consumer);
 await writeFile(join(consumer,'worker.mjs'),"import {createDeftExperienceSdk} from '@deft/app-kit/experience/core'; globalThis.workOrders=createDeftExperienceSdk;\n");
 const bundled=await build({entryPoints:[join(consumer,'worker.mjs')],bundle:true,platform:'browser',format:'esm',write:false,metafile:true});
 const forbidden=/(?:examples[\\/]email|mailbox-list|sandbox|safe-compose-html|native-compose-raster)/i;
 for(const path of Object.keys(bundled.metafile!.inputs))assert.doesNotMatch(path,forbidden);
 for(const file of bundled.outputFiles!)assert.doesNotMatch(file.text,/SandboxEmailSend|MAILBOX_LIST|sandbox_email_send|parseMailboxList/);
 await writeFile(join(consumer,'verify.mjs'),"import {verifyDeftAppPackageJson,checkDeftAppDeveloperContract,DEFT_APP_DEVELOPER_COMPATIBILITY,DEFT_APP_PROTOCOL_SUPPORT} from '@deft/app-kit/core';import {readFileSync} from 'node:fs';if(DEFT_APP_PROTOCOL_SUPPORT['1'].private_interfaces.length)throw Error('example registration');const text=readFileSync('.deft/app.deftapp.json','utf8');await verifyDeftAppPackageJson(text);const checked=await checkDeftAppDeveloperContract({package_json:text,host_compatibility:DEFT_APP_DEVELOPER_COMPATIBILITY});if('sandbox_email_conformance'in checked)throw Error('example conformance');console.log('packed core verified');");
 assert.match(run(['verify.mjs'],consumer),/packed core verified/);
 const declarations=await readFile(join(installed,'dist/compatibility.d.ts'),'utf8');assert.match(declarations,/@deprecated/);assert.match(declarations,/next breaking Kit alpha/);
 console.log(`Packed transition consumer: ${consumer}; Worker inputs: ${Object.keys(bundled.metafile!.inputs).length}`);
});
