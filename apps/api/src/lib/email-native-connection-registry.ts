import {createHash} from 'node:crypto';
import {lstat,readFile,realpath} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {NativeEmailConnectionCapabilitiesSchema,type NativeEmailConnectionBinding} from './email-native-connection-contract.js';
import type {NativeEmailProviderProfile} from './email-native-connection-profile.js';
import {nativeEmailCredentialPolicyDigest,nativeEmailImplementationDigest} from './email-native-connection-implementation.js';
const id=z.string().min(1).max(256),revision=z.number().int().positive().max(2147483646);
const hash=z.string().regex(/^[a-f0-9]{64}$/u);
export const NativeEmailProfileConfigSchema=z.strictObject({schema_version:z.literal('deft.email_native_provider_profiles.v1'),profiles:z.array(z.strictObject({profile_id:id,profile_revision:revision,provider:z.enum(['gmail','microsoft']),capabilities:NativeEmailConnectionCapabilitiesSchema,connect_enabled:z.boolean(),module_path:z.string().min(1).max(2048),module_sha256:hash,options:z.record(z.string(),z.unknown()),implementation:z.strictObject({module_path:z.string().min(1).max(2048),module_sha256:hash,revision,credential_policy_sha256:hash}).optional()})).max(8)});
export type NativeEmailProfileEntry=Readonly<{profile_id:string;profile_revision:number;provider:'gmail'|'microsoft';capabilities:readonly ('read'|'modify'|'send')[];module_sha256:string;connect_enabled:boolean;adapter:NativeEmailProviderProfile;implementation_digest?:string}>;
const unavailable=():never=>{throw Error('EMAIL_CONNECTION_PROFILE_UNAVAILABLE');};
/** Cached verified implementation/configuration only. Every use still requires
 * fresh owner/account/SID or worker-lease and current credential checks. */
export class NativeEmailProfileRegistry{
 private readonly entries:readonly NativeEmailProfileEntry[];
 constructor(entries:readonly NativeEmailProfileEntry[]){
  if(entries.length>8||new Set(entries.map(e=>JSON.stringify([e.profile_id,e.profile_revision,e.module_sha256]))).size!==entries.length||['gmail','microsoft'].some(p=>entries.filter(e=>e.provider===p&&e.connect_enabled).length>1))unavailable();
  this.entries=Object.freeze(entries.map(e=>Object.freeze({...e,capabilities:Object.freeze([...NativeEmailConnectionCapabilitiesSchema.parse(e.capabilities)])})));
 }
 providers(){return this.entries.filter(e=>e.connect_enabled).map(e=>({provider:e.provider,capabilities:e.capabilities}));}
 forConnect(provider:'gmail'|'microsoft'){const entry=this.entries.find(e=>e.provider===provider&&e.connect_enabled);return entry??unavailable();}
 selected(binding:Pick<NativeEmailConnectionBinding,'profile_id'|'profile_revision'|'module_sha256'|'provider'>){const entry=this.entries.find(e=>e.profile_id===binding.profile_id&&e.profile_revision===binding.profile_revision&&e.module_sha256===binding.module_sha256&&e.provider===binding.provider);return entry??unavailable();}
}
export async function loadNativeEmailProfileRegistry(configPath:string|undefined):Promise<NativeEmailProfileRegistry>{
 if(!configPath)return new NativeEmailProfileRegistry([]);
 try{
  if(!isAbsolute(configPath))return unavailable();const stat=await lstat(configPath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>262144||process.platform!=='win32'&&(stat.mode&0o077)!==0)return unavailable();
  const config=NativeEmailProfileConfigSchema.parse(JSON.parse(await readFile(configPath,'utf8'))),entries:NativeEmailProfileEntry[]=[];
  for(const item of config.profiles){
   const selected=item.implementation??item;if(item.implementation&&nativeEmailCredentialPolicyDigest(item.options,item.capabilities)!==item.implementation.credential_policy_sha256)return unavailable();
   if(!isAbsolute(selected.module_path))return unavailable();const moduleStat=await lstat(selected.module_path);if(!moduleStat.isFile()||moduleStat.isSymbolicLink()||moduleStat.size>1048576)return unavailable();
   const modulePath=await realpath(selected.module_path);if(createHash('sha256').update(await readFile(modulePath)).digest('hex')!==selected.module_sha256)return unavailable();
   const loaded=await import(pathToFileURL(modulePath).href) as {createNativeEmailProviderProfile?:(args:{options:Record<string,unknown>})=>Promise<NativeEmailProviderProfile>};
   if(typeof loaded.createNativeEmailProviderProfile!=='function')return unavailable();
   if(item.options.provider!==item.provider)return unavailable();const adapter=await loaded.createNativeEmailProviderProfile({options:item.options});
   if(typeof adapter?.connection?.begin!=='function'||typeof adapter?.connection?.complete!=='function'||typeof adapter?.mailbox!=='function')return unavailable();
   entries.push({profile_id:item.profile_id,profile_revision:item.profile_revision,provider:item.provider,capabilities:item.capabilities,module_sha256:item.module_sha256,connect_enabled:item.connect_enabled,adapter,...(item.implementation?{implementation_digest:nativeEmailImplementationDigest({original_sha256:item.module_sha256,module_sha256:item.implementation.module_sha256,revision:item.implementation.revision,credential_policy_sha256:item.implementation.credential_policy_sha256})}:{})});
  }return new NativeEmailProfileRegistry(entries);
 }catch{return unavailable();}
}
let registry:Promise<NativeEmailProfileRegistry>|undefined;
export function getNativeEmailProfileRegistry(){return registry??=loadNativeEmailProfileRegistry(process.env.DEFT_EMAIL_NATIVE_PROVIDER_PROFILES_CONFIG);}
