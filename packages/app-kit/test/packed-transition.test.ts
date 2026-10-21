import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,writeFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import ts from 'typescript';
import {seedPackedConsumerLock} from './fixtures/packed-consumer-lock.js';

const kit=resolve(import.meta.dirname,'..');
function run(args:string[],cwd:string){const r=spawnSync(process.execPath,args,{cwd,encoding:'utf8',timeout:180_000});assert.equal(r.status,0,`${r.error??''}\n${r.stdout}\n${r.stderr}`);return r.stdout;}
test('packed alpha.42 preserves old consumer types and a non-mail build has no mailbox or sandbox code',async()=>{
 assert.ok(process.env.npm_execpath,'Run through pnpm');
 // Windows can spell the same temp directory with short and long names. Keep
 // preload resolution and the CLI's real path in the same ESM module identity.
 const root=await realpath(await mkdtemp(join(tmpdir(),'deft-kit-transition-'))),pack=join(root,'pack'),consumer=join(root,'consumer');
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
 const inventory=JSON.parse(await readFile(join(kit,'../../docs/reports/2026-10-20-kit-domain-consumer-inventory.json'),'utf8'));
 for(const [entry,file] of [['@deft/app-kit','index.d.ts'],['@deft/app-kit/experience','experience-sdk.d.ts']]){
  const path=join(installed,'dist',file!),program=ts.createProgram([path],{module:ts.ModuleKind.NodeNext,target:ts.ScriptTarget.ES2022,skipLibCheck:true}),checker=program.getTypeChecker();
  const symbols=checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(path)!)!);
  const names=new Set(symbols.map(s=>s.name));
  for(const name of ['parseMailboxList','NativeComposeOptions',...(entry==='@deft/app-kit'?['SandboxEmailSendInputSchema']:[])]){
   const symbol=symbols.find(s=>s.name===name)!;
   const target=symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
   const tag=target.getJsDocTags(checker).find(tag=>tag.name==='deprecated');
   const text=tag?.text?.map(part=>part.text).join('')??'';
   assert.match(text,/@deft\/app-kit\/examples\/email/);
   assert.match(text,/next breaking Kit alpha/);
  }
  for(const version of ['0.1.0-alpha.38','0.1.0-alpha.39'])for(const symbol of inventory.public_entrypoint_exports[version][entry!] as {name:string}[])assert.ok(names.has(symbol.name),`${version} ${entry} lost ${symbol.name}`);
 }
 const cli=join(installed,'dist/cli.js');run([cli,'app','init','--template','runtime'],consumer);run([cli,'app','build'],consumer);
 const legacyApp=join(consumer,'legacy-example');await mkdir(legacyApp);
 const denied=spawnSync(process.execPath,[cli,'app','init','--template','connected'],{cwd:legacyApp,encoding:'utf8'});
 assert.notEqual(denied.status,0);assert.match(denied.stderr,/optional author-tool extension/);
 const optional=['--import','@deft/app-kit/examples/email/register',cli];
 run([...optional,'app','init','--template','connected'],legacyApp);run([...optional,'app','build'],legacyApp);
 await writeFile(join(consumer,'worker.mjs'),"import {createDeftExperienceSdk} from '@deft/app-kit/experience/core'; globalThis.onmessage=event=>{if(event.data?.type!=='deft.experience_bootstrap.v1')return;const sdk=createDeftExperienceSdk(event.ports[0],event.data.session_id);sdk.render({root:{kind:'text',id:'work_orders',text:'Work orders'}});};\n");
 const bundled=await build({entryPoints:[join(consumer,'worker.mjs')],bundle:true,minify:true,platform:'browser',format:'esm',write:false,metafile:true});
 await writeFile(join(consumer,'build-tool.mjs'),"export {buildDeftAppPackage} from '@deft/app-kit/core';\n");
 const coreBundled=await build({entryPoints:[join(consumer,'build-tool.mjs')],bundle:true,minify:true,platform:'node',format:'esm',write:false,metafile:true});
 const forbidden=/(?:examples[\\/]email|mailbox-list|sandbox|safe-compose-html|native-compose-raster)/i;
 for(const artifact of [bundled,coreBundled]){
  for(const path of Object.keys(artifact.metafile!.inputs))assert.doesNotMatch(path,forbidden);
  for(const file of artifact.outputFiles!)assert.doesNotMatch(file.text,/SandboxEmailSend|MAILBOX_LIST|sandbox_email_send|parseMailboxList/);
 }
 const experienceApp=join(consumer,'installed');await mkdir(experienceApp);run([cli,'app','init','--template','installed'],experienceApp);
 await writeFile(join(consumer,'worker.bundle.js'),bundled.outputFiles![0]!.text);
 await writeFile(join(consumer,'prepare-worker.mjs'),"import {prepareDeftExperienceArtifact} from '@deft/app-kit/core';import {readFileSync,writeFileSync} from 'node:fs';const path='installed/experiences/main.json',source=JSON.parse(readFileSync(path,'utf8'));source.worker_source=readFileSync('worker.bundle.js','utf8');const artifact=await prepareDeftExperienceArtifact('experiences/main.json',source);writeFileSync(path,JSON.stringify(source));const manifest=JSON.parse(readFileSync('installed/deft.app.json','utf8'));manifest.experiences[0].artifact_digest=artifact.digest;writeFileSync('installed/deft.app.json',JSON.stringify(manifest));");
 run(['prepare-worker.mjs'],consumer);run([cli,'app','build'],experienceApp);
 await writeFile(join(consumer,'verify.mjs'),"import {verifyDeftAppPackageJson,checkDeftAppDeveloperContract,DEFT_APP_DEVELOPER_COMPATIBILITY,DEFT_APP_PROTOCOL_SUPPORT} from '@deft/app-kit/core';import {readFileSync} from 'node:fs';if(DEFT_APP_PROTOCOL_SUPPORT['1'].private_interfaces.length)throw Error('example registration');const text=readFileSync('.deft/app.deftapp.json','utf8');await verifyDeftAppPackageJson(text);await verifyDeftAppPackageJson(readFileSync('installed/.deft/app.deftapp.json','utf8'));const checked=await checkDeftAppDeveloperContract({package_json:text,host_compatibility:DEFT_APP_DEVELOPER_COMPATIBILITY});if('sandbox_email_conformance'in checked)throw Error('example conformance');console.log('packed core verified');");
 assert.match(run(['verify.mjs'],consumer),/packed core verified/);
 const declarations=await readFile(join(installed,'dist/compatibility.d.ts'),'utf8');assert.match(declarations,/@deprecated/);assert.match(declarations,/next breaking Kit alpha/);
 console.log(`Packed transition consumer: ${consumer}; Worker inputs: ${Object.keys(bundled.metafile!.inputs).length}; core inputs: ${Object.keys(coreBundled.metafile!.inputs).length}`);
});
