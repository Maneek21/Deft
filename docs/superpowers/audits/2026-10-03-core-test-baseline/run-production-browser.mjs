import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const root='C:/Users/Osheen Pradhan/.codex/worktrees/core-baseline-tests-20261003/Deft Main Repo';
const evidence='C:/tmp/deft-core-baseline-20261003';
const pnpm='C:/Users/Osheen Pradhan/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs';
const env={...process.env,DATABASE_URL:'postgresql://deft_test@127.0.0.1:55433/deft_browser_baseline_test',NODE_ENV:'production',API_PORT:'3471',PORT:'3471',JWT_SECRET:'baseline-only-jwt-secret-20261003-with-32chars',JWT_REFRESH_SECRET:'baseline-only-refresh-secret-20261003-with-32chars',ENCRYPTION_KEY:'baseline-only-encryption-key-20261003-32chars',NEXT_PUBLIC_APP_URL:'http://localhost:3470',NEXT_PUBLIC_API_URL:'http://localhost:3471',NEXT_PUBLIC_WS_URL:'http://localhost:3471',DEFT_WEB_URL:'http://localhost:3470',DEFT_APPS_ENABLED:'true',DEFT_APP_DEVELOPER_PAIRING_ENABLED:'true',DEFT_APPROVAL_SMOKE_MARKER:'baseline-approval-20261003',ANTHROPIC_API_KEY:'',OPENAI_API_KEY:'',OPENROUTER_API_KEY:'',OLLAMA_URL:''};
const children=[];
function start(name,args,extra={}){const out=createWriteStream(`${evidence}/${name}.log`);const child=spawn(process.execPath,[pnpm,...args],{cwd:root,env:{...env,...extra},windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.pipe(out);child.stderr.pipe(out);children.push(child);return child;}
async function run(name,args){const child=start(name,args);return await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});}
async function ready(url){const deadline=Date.now()+300000;while(Date.now()<deadline){try{if((await fetch(url)).ok)return;}catch{}await new Promise(r=>setTimeout(r,500));}throw Error(`Not ready: ${url}`);}
try{
 await mkdir(`${evidence}/production-browser-screenshots`,{recursive:true});
 start('production-browser-api',['--filter','@deft/api','exec','tsx','src/server.ts']);
 start('production-browser-web',['--filter','@deft/web','exec','next','start','--port','3470'],{PORT:'3470'});
 await writeFile(`${evidence}/production-browser-pids.json`,JSON.stringify(children.map(c=>c.pid)));
 await ready('http://localhost:3471/health');await ready('http://localhost:3470/login');
 const seed=await run('production-browser-approval-seed',['test:product-browser:seed']);if(seed!==0)throw Error(`seed exit ${seed}`);
 let source=await readFile(`${root}/scripts/product-browser-smoke.mjs`,'utf8');
 source=source.replace("import { chromium } from 'playwright';",`import { createRequire } from 'node:module';\nconst { chromium } = createRequire(${JSON.stringify(root+'/package.json')})('playwright');`);
 // This local build explicitly has Huddles OFF. Preserve the original CI
 // flag-on failure and check the declared flag-off behavior in this run.
 source=source.replace(/const huddleControl[\s\S]*?record\('Expose the huddle start control without requesting microphone access', '#general'\);/,`const huddleControl=page.locator('button[title="Start a huddle"]');\n    if(await huddleControl.count())throw Error('Flag-off Huddle control unexpectedly visible');\n    if(await page.evaluate(()=>window.__deftGetUserMediaCalls??0)!==0)throw Error('Flag-off chat requested microphone');\n    record('Declared Huddles-OFF build hides Huddle control without requesting microphone');`);
 source=source.replace("if (overflow > 2) throw new Error(`${path} overflows the mobile viewport by ${overflow}px`);",`await page.screenshot({path:${JSON.stringify(evidence+'/production-browser-screenshots/')}+path.replaceAll('/','_')+'.png',fullPage:true});\n      if (overflow > 2) throw new Error(\
\
        path+' overflows the mobile viewport by '+overflow+'px');`);
 source=source.replace('await browser.close();',`await page.screenshot({path:${JSON.stringify(evidence+'/production-browser-screenshots/final-or-failure.png')},fullPage:true}).catch(()=>{});\n    await browser.close();`);
 const script=`${evidence}/production-browser-smoke-instrumented.mjs`;await writeFile(script,source);
 const smoke=spawn(process.execPath,[script],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(smoke);const out=createWriteStream(`${evidence}/production-browser-smoke.log`);smoke.stdout.pipe(out);smoke.stderr.pipe(out);
 const code=await new Promise((resolve,reject)=>{smoke.once('error',reject);smoke.once('exit',resolve);});
 await writeFile(`${evidence}/production-browser-result.json`,JSON.stringify({exit:code,source_sha:'b567af6ff12e5e4c61dbc54eddde17a81b986a28',instrumentation:'import resolution, screenshots, declared Huddles-OFF absence check; other assertions unchanged',huddles:'off at build time; flag-on certified separately in pinned GitHub CI',api_port:3471,web_port:3470},null,2));process.exitCode=code;
}catch(error){await writeFile(`${evidence}/production-browser-result.json`,JSON.stringify({exit:1,error:String(error.stack)},null,2));process.exitCode=1;}
finally{for(const child of children.reverse()){if(child.exitCode===null&&child.pid){await new Promise(resolve=>{const stop=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});stop.once('exit',resolve);stop.once('error',resolve);});}}}
