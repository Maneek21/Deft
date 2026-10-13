import { createHash } from 'node:crypto';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { AppError } from './app-errors.js';
import { AppConnectionPinsSchema, type AppConnectionAdapter, type AppConnectionPins, type AppConnectionContext,type NativeEmailImapHostFactory } from './app-connection-contract.js';
import {nativeEmailCredentialPolicyDigest,nativeEmailImplementationDigest} from './email-native-connection-implementation.js';

export type AppConnectionEntry = Readonly<{ pins: AppConnectionPins; adapter: AppConnectionAdapter;module_sha256?:string;implementation_digest?:string }>;
const unavailable = () => new AppError('Account connection is not configured for this reviewed source', 'APP_ACTION_UNAVAILABLE', 503);
const ConfigSchema = z.strictObject({ schema_version: z.literal('deft.app_connection_adapters.v1'), entries: z.array(z.strictObject({
  pins: AppConnectionPinsSchema, module_path: z.string().min(1).max(2048),
  module_sha256: z.string().regex(/^[a-f0-9]{64}$/), options: z.record(z.string(), z.unknown()),
  compatible_from:z.strictObject({module_sha256:z.string().regex(/^[a-f0-9]{64}$/),credential_policy_sha256:z.string().regex(/^[a-f0-9]{64}$/),revision:z.number().int().positive().max(2147483646)}).optional(),
})).max(32) });

/** Deployment-owned code registry. Browser inputs can never register an adapter,
 * choose a module path, change binding pins or pass provider configuration. */
export class AppConnectionRegistry {
  private readonly entries: readonly AppConnectionEntry[];
  constructor(entries: readonly AppConnectionEntry[]) {
    this.entries = Object.freeze(entries.map(entry => Object.freeze({
      pins: Object.freeze(AppConnectionPinsSchema.parse(entry.pins)), adapter: entry.adapter,module_sha256:entry.module_sha256,implementation_digest:entry.implementation_digest,
    })));
  }
  select(input: { org_id: string; owner_user_id: string; installation_id: string; target_key: string }) {
    const found = this.entries.filter(entry => Object.entries(input).every(([key, value]) => entry.pins[key as keyof AppConnectionPins] === value));
    if (found.length !== 1) throw unavailable();
    return found[0]!;
  }
  retainedOwnerEntries(input:{org_id:string;owner_user_id:string;installation_id:string}){
    return this.entries.filter(entry=>Object.entries(input).every(([key,value])=>entry.pins[key as keyof AppConnectionPins]===value));
  }
  /** Internal host inventory for owner-scoped navigation checks. Callers must
   * still validate each pin against the current reviewed binding graph. */
  retainedOwnerEntriesForOwner(input:{org_id:string;owner_user_id:string}){
    return this.entries.filter(entry=>entry.pins.org_id===input.org_id&&entry.pins.owner_user_id===input.owner_user_id);
  }
}

export async function loadAppConnectionRegistry(configPath: string | undefined): Promise<AppConnectionRegistry> {
  if (!configPath) return new AppConnectionRegistry([]);
  try {
    if (!isAbsolute(configPath)) throw unavailable();
    const stat = await lstat(configPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262_144) throw unavailable();
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw unavailable();
    const config = ConfigSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
    const entries: AppConnectionEntry[] = [];
    for (const item of config.entries) {
      if(item.compatible_from&&(!Array.isArray(item.options.capabilities)||item.options.capabilities.some(cap=>typeof cap!=='string')||nativeEmailCredentialPolicyDigest(item.options,item.options.capabilities as string[])!==item.compatible_from.credential_policy_sha256))throw unavailable();
      if (!isAbsolute(item.module_path)) throw unavailable();
      const moduleStat = await lstat(item.module_path);
      if (!moduleStat.isFile() || moduleStat.isSymbolicLink() || moduleStat.size > 1_048_576) throw unavailable();
      const modulePath = await realpath(item.module_path);
      if (createHash('sha256').update(await readFile(modulePath)).digest('hex') !== item.module_sha256) throw unavailable();
      const loaded = await import(pathToFileURL(modulePath).href) as { createAppConnectionAdapter?: (args: unknown) => Promise<AppConnectionAdapter> };
      if (typeof loaded.createAppConnectionAdapter !== 'function') throw unavailable();
      const nativeEmailImapHost:NativeEmailImapHostFactory=async constructors=>(await import('./email-imap-runtime.js')).createRegisteredEmailImapHost(item.pins,constructors);
      const host = Object.freeze({
        nativeEmailImapHost,
        resolveContext: async (context: AppConnectionContext) => context.projection,
        assertCurrent: async (context: AppConnectionContext) => context.recheck(),
      });
      const adapter = await loaded.createAppConnectionAdapter({ host, options: item.options });
      if (!adapter || typeof adapter.handle !== 'function') throw unavailable();
      entries.push(Object.freeze({ pins: Object.freeze(item.pins), adapter,module_sha256:item.compatible_from?.module_sha256??item.module_sha256,...(item.compatible_from?{implementation_digest:nativeEmailImplementationDigest({original_sha256:item.compatible_from.module_sha256,module_sha256:item.module_sha256,revision:item.compatible_from.revision,credential_policy_sha256:item.compatible_from.credential_policy_sha256})}:{}) }));
    }
    return new AppConnectionRegistry(entries);
  } catch { throw unavailable(); }
}

let registry: Promise<AppConnectionRegistry> | undefined;
export function getAppConnectionRegistry() {
  registry ??= loadAppConnectionRegistry(process.env.DEFT_APP_CONNECTION_ADAPTERS_CONFIG);
  return registry;
}
