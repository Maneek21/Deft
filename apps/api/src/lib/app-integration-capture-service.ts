import {db} from './db.js';
import {createAppIntegrationCaptureRuntime} from './app-integration-capture-runtime.js';
import {getAppIntegrationDataGateway} from './app-integration-runtime-gateway.js';
import type {AppRunTransaction as Tx} from './app-run-repository.js';
import type {JobData} from '../workers/types.js';
let active:Promise<ReturnType<typeof createAppIntegrationCaptureRuntime>>|undefined;
export function getAppIntegrationCaptureRuntime(){
 return active??=(async()=>{const {getAppRunRuntime}=await import('./app-run-runtime.js');const runtime=await getAppRunRuntime();
  const transaction=<T>(fn:(tx:Tx)=>Promise<T>)=>db.transaction(tx=>fn(tx));
  return createAppIntegrationCaptureRuntime({transaction,keys:runtime.keys,gateway:getAppIntegrationDataGateway()});
 })().catch(error=>{active=undefined;throw error;});
}
export async function handleAppIntegrationKnowledge(job:JobData){
 const runtime=await getAppIntegrationCaptureRuntime();
 if(job.name==='app-integration-knowledge-repair'){await runtime.repair();return;}
 await runtime.run(job);
}
