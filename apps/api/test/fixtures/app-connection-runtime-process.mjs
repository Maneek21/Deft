// Synthetic integration driver only: production never imports this fixture.
import {readFile} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root = process.env.DEFT_E2_RUNTIME_ROOT;
if (!root || !isAbsolute(root) || !process.env.EMAIL_RUNTIME_CONFIG_FILE) throw Error('E2_FIXTURE_CONFIG_REQUIRED');
const {startRuntime} = await import(pathToFileURL(join(root, 'server.mjs')).href);
const {twoAccountProviderFixture} = await import(pathToFileURL(join(root, 'test-support.mjs')).href);
const providerFixture = twoAccountProviderFixture();
const config = JSON.parse(await readFile(process.env.EMAIL_RUNTIME_CONFIG_FILE, 'utf8'));
const instance = await startRuntime(config, {allow_windows_fixture: true, allow_loopback_fixture: true,
  start_send_workers:process.env.EMAIL_RUNTIME_MANUAL_SEND!=='true',
  fetch: async (url, options) => {
    process.send({event: 'provider_request', url});
    return providerFixture(url, options);
  }});
// Diagnostic fixture uses the same public SDK and exported runner, exposing
// only stage/code/elapsed counters that production runOnce intentionally hides.
// It never emits a claim, input, credential, error message or provider body.
async function runDiagnosticSend() {
  const startedAt = Date.now();let phase='claim',authorizeCalls=0;
  const channel=JSON.parse(await readFile(config.runtime_channel_files[0],'utf8'));
  const {createAppRuntimeClient}=await import(pathToFileURL(join(root,'node_modules/@deft/app-kit/dist/index.js')).href);
  const {createSendRunner}=await import(pathToFileURL(join(root,'send-runner.mjs')).href);
  const sdk=createAppRuntimeClient({channel_url:channel.channel_url,credential:channel.credential});
  const runtime_client={...sdk,async authorize(claim){phase='authorize';authorizeCalls++;const authorized=await sdk.authorize(claim);phase='execute';return authorized;}};
  const key=Buffer.from(config.encryption_key_hex,'hex');
  try {
    const runner=createSendRunner({runtime_client,registration:channel.registration,client:JSON.parse(await readFile(config.gmail_client_file,'utf8')),store:instance.store,encryption_key:key,key_id:config.key_id,
      fetch:async(url,options)=>{phase='provider';process.send({event:'provider_request',url});const result=await providerFixture(url,options);phase='execute';return result;}});
    const claim=await sdk.claim();if(!claim)return null;
    let result;
    try{phase='start';const started=await sdk.start(claim);phase='execute';result=await runner.executeClaim(claim,started,AbortSignal.timeout(30000));}
    catch(error){const code=typeof error?.code==='string'&&/^(?:EMAIL_[A-Z0-9_]+|APP_RUNTIME_[A-Z0-9_]+)$/.test(error.code)?error.code:'SYNTHETIC_SEND_UNCLASSIFIED';process.send({event:'send_diagnostic',phase,code,elapsed_ms:Date.now()-startedAt,authorize_calls:authorizeCalls});result={status:'not_attempted',error_code:'APP_RUN_PROVIDER_UNAVAILABLE'};}
    phase='result';await sdk.result(claim,result);process.send({event:'send_diagnostic',phase:'completed',elapsed_ms:Date.now()-startedAt,authorize_calls:authorizeCalls});return result;
  }finally{key.fill(0);}
}
process.send({port: instance.server.address().port});
process.on('message', async message => {
  if (message === 'shutdown') {await instance.close(); process.exit(0);}
  if(message==='run-send'&&process.env.EMAIL_RUNTIME_MANUAL_SEND==='true'){
    try{const result=await runDiagnosticSend();process.send({event:'send_result',result});}
    catch{process.send({event:'send_result',error:'SYNTHETIC_SEND_DRIVER_UNAVAILABLE'});}
  }
});
