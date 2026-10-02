import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';

test('default-off cold attachment runtime denies before retained key-provider initialization or database connection',async()=>{
  const path=new URL('../src/lib/app-attachment-runtime.ts',import.meta.url).href;
  const cleanup=new URL('../src/lib/app-attachment-cleanup.ts',import.meta.url).href;
  const script=`const {getAppAttachmentRuntime}=await import(${JSON.stringify(path)});
    try { await getAppAttachmentRuntime(); process.exit(2); }
    catch(error) { if(error.code!=='APP_FEATURE_DISABLED') process.exit(3); }
    const {appAttachmentCleanup,AppAttachmentCleanup}=await import(${JSON.stringify(cleanup)});
    const result=await appAttachmentCleanup.run();
    if(result.inspected||result.purged||result.failed) process.exit(4);
    await appAttachmentCleanup.stop();
    const stopped=new AppAttachmentCleanup(()=>true,()=>new Date(),undefined,process.env.DATABASE_URL);
    await stopped.stop();const late=await stopped.run();
    if(late.inspected||late.purged||late.failed)process.exit(5);
    process.exit(0);`;
  const ring=(purpose:string)=>({current:purpose,keys:{[purpose]:createHash('sha256').update(`attachment-off:${purpose}`).digest('base64')}});
  const validKeys=JSON.stringify({schema_version:'deft.app_run_keyring.v1',run_encryption:ring('off-enc'),receipt_signing:ring('off-sign'),fingerprint:ring('off-fp')});
  for(const appsEnabled of [false,true]){
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],{
    cwd:process.cwd(),windowsHide:true,stdio:['ignore','ignore','pipe'],env:{...process.env,
      DEFT_APPS_ENABLED:'true',DEFT_APP_RUNS_ENABLED:String(appsEnabled),DEFT_APP_RUN_APP_ORIGIN_ENABLED:String(appsEnabled),
      DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED:'false',DEFT_APP_AUTOMATIONS_ENABLED:'false',
      DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED:'true',DEFT_APP_ATTACHMENT_BROKER_ENABLED:'false',
      // Runs-on intentionally validates its configured keyring at env load;
      // attachment-off must still avoid initializing a provider/DB pool.
      DEFT_APP_RUN_KEYRINGS:appsEnabled?validKeys:'invalid',DATABASE_URL:'postgresql://gate_g_test@127.0.0.1:1/gate_g_defaultoff'}});
  let diagnostic='';child.stderr.on('data',chunk=>{if(diagnostic.length<8192)diagnostic+=String(chunk).slice(0,8192-diagnostic.length);});
  const timeout=setTimeout(()=>child.kill(),10_000);
  try{const code=await new Promise<number|null>((ready,reject)=>{child.once('error',reject);child.once('exit',ready);});
    const evidence=process.env.DEFT_ATTACHMENT_COLD_DIAGNOSTIC;
    if(code!==0&&evidence&&resolve(evidence).startsWith('C:\\Users\\Osheen Pradhan\\Documents\\Codex\\'))await writeFile(evidence,diagnostic);
    assert.equal(code,0,`Cold runtime exit ${code}; ${diagnostic.match(/(?:^|\n)([A-Za-z]+Error):/u)?.[1]??'early startup failure'}`);}
  finally{clearTimeout(timeout);}
  }
});
