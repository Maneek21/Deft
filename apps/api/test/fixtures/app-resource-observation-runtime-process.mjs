// Separate synthetic process: actual public v3 clients and runtime runner.
import {readFile} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.DEFT_E2_RUNTIME_ROOT,configPath=process.env.EMAIL_RUNTIME_CONFIG_FILE;
if(!root||!isAbsolute(root)||!configPath||!isAbsolute(configPath))throw Error('SYNTHETIC_OBSERVATION_CONFIG_REQUIRED');
const {startRuntime}=await import(pathToFileURL(join(root,'server.mjs')).href);
const {twoAccountProviderFixture}=await import(pathToFileURL(join(root,'test-support.mjs')).href);
const provider=twoAccountProviderFixture(),config=JSON.parse(await readFile(configPath,'utf8'));
const instance=await startRuntime(config,{allow_windows_fixture:true,allow_loopback_fixture:true,start_send_workers:false,start_observation_workers:false,
 fetch:async(url,options)=>{process.send({event:'provider_request',url});return provider(url,options);}});
let running=false;
async function observe(){
 const channel=JSON.parse(await readFile(process.env.DEFT_E3_OBSERVATION_CHANNEL_FILE,'utf8'));
 const {createDeftResourceSyncClientV3,createResourceObservationClient}=await import(pathToFileURL(join(root,'node_modules/@deft/app-kit/dist/index.js')).href);
 const {createResourceObservationRunner}=await import(pathToFileURL(join(root,'observation-runner.mjs')).href);
 const key=Buffer.from(config.encryption_key_hex,'hex');let phase='claim',calls=0;
 const raw=createDeftResourceSyncClientV3({channel_url:channel.channel_url,credential:channel.credential});
 const sdk=Object.fromEntries(Object.entries(raw).map(([name,method])=>[name,async(...args)=>{phase=name;try{return await method(...args);}catch(error){
  process.send({event:'observation_diagnostic',phase,code:typeof error.code==='string'&&/^APP_RESOURCE_SYNC_[A-Z0-9_]+$/u.test(error.code)?error.code:'SYNTHETIC_CHANNEL_DENIED'});throw error;}}]));
 const online=createResourceObservationClient({channel_url:channel.observation_authority_url,credential:channel.credential});
 try{const runner=createResourceObservationRunner({runtime_client:sdk,observation_client:{async authorize(...args){phase='authority';calls++;return online.authorize(...args);}},
  registration:channel.registration,client:JSON.parse(await readFile(config.gmail_client_file,'utf8')),store:instance.store,encryption_key:key,key_id:config.key_id,
  fetch:async(url,options)=>{process.send({event:'provider_request',url});return provider(url,options);},
  onPhase:async(name,{run_id})=>{phase=name;process.send({event:'observation_phase',phase:name,run_id});}});
  const result=await runner.runOnce(AbortSignal.timeout(40000));
  process.send({event:'observation_result',status:result?.status??'no_claim',provider_succeeded:result?.provider_succeeded??false,
   upserts:result?.page?.upserts?.length??0,authority_calls:calls});
 }catch(error){process.send({event:'observation_result',status:'driver_denied',phase,
  code:typeof error.code==='string'&&/^EMAIL_[A-Z0-9_]+$/u.test(error.code)?error.code:'SYNTHETIC_OBSERVATION_DENIED'});}finally{key.fill(0);}
}
process.send({port:instance.server.address().port});
process.on('message',async message=>{if(message==='shutdown'){await instance.close();process.exit(0);}if(message==='run-observation'&&!running){running=true;try{await observe();}finally{running=false;}}});
