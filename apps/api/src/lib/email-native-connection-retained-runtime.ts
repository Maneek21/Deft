import {and,eq} from 'drizzle-orm';
import {currentNativeAccountAvailable} from './email-native-adoption-gate.js';
import {emailAccounts,emailAccountConsents} from '@deft/db/schema';
import {db} from './db.js';
import {getAppConnectionRegistry} from './app-connection-registry.js';
import {PostgresEmailAccountConsentStore} from './email-account-consent-store.js';
import type {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import type {NativeEmailConnectionBinding} from './email-native-connection-contract.js';
import type {NativeEmailConnectionContext} from './app-connection-contract.js';
import type {RetainedNativeEmailConnectionProfile} from './email-native-connection-retained.js';
export async function resolveRetainedNativeEmailConnection(input:Pick<NativeEmailConnectionBinding,'scope'|'account_id'|'provider'|'expected_native_revision'|'expected_principal_digest'>,cipher:EmailMailboxCrypto,recheck:()=>Promise<void>,signal?:AbortSignal):Promise<{profile:RetainedNativeEmailConnectionProfile;module_sha256:string}>{
 const callerRecheck=recheck;const scope={...input.scope,account_id:input.account_id};recheck=async()=>{await callerRecheck();await currentNativeAccountAvailable(db,scope);};await recheck();
 const [account]=await db.select().from(emailAccounts).where(and(eq(emailAccounts.org_id,scope.org_id),eq(emailAccounts.owner_user_id,scope.owner_user_id),eq(emailAccounts.account_id,scope.account_id))).limit(1);
 const [row]=await db.select().from(emailAccountConsents).where(and(eq(emailAccountConsents.org_id,scope.org_id),eq(emailAccountConsents.owner_user_id,scope.owner_user_id),eq(emailAccountConsents.account_id,scope.account_id))).limit(1);
 if(!account||!row||account.credential_source!=='retained_registry_v1'||account.provider!==input.provider||account.state==='revoked'||account.authority_revision!==input.expected_native_revision||account.principal_digest!==input.expected_principal_digest)throw Error('EMAIL_ACCESS_DENIED');
 const consent=new PostgresEmailAccountConsentStore(db,cipher).decode(row);if(consent.bridge.kind!=='retained_registry_v1')throw Error('EMAIL_CONNECTION_PROFILE_UNAVAILABLE');
 const pins=consent.bridge.pins,entry=(await getAppConnectionRegistry()).select({org_id:scope.org_id,owner_user_id:scope.owner_user_id,installation_id:pins.installation_id,target_key:pins.target_key});
 if(entry.module_sha256!==consent.bridge.module_sha256||Object.keys(pins).filter(key=>!['app_version_id','grant_snapshot_id'].includes(key)).some(key=>entry.pins[key as keyof typeof pins]!==pins[key as keyof typeof pins])||!entry.adapter.nativeEmailConnectionProfile)throw Error('EMAIL_CONNECTION_PROFILE_UNAVAILABLE');
 const context:NativeEmailConnectionContext={...scope,installation_id:pins.installation_id,resource_binding_id:pins.resource_binding_id,authority_version:'native-owner-reconnect',expires_at:Date.now()+30000,recheck,signal,lifecycle_inspect:true};
 await recheck();const profile=await entry.adapter.nativeEmailConnectionProfile(context);await recheck();
 if(profile.scope.org_id!==scope.org_id||profile.scope.owner_user_id!==scope.owner_user_id||profile.account_id!==scope.account_id||profile.provider!==consent.provider||profile.principal_digest!==consent.principal_digest||profile.credential_namespace_id!==pins.installation_id||profile.credential_binding_id!==pins.resource_binding_id||profile.credential_action_id!==pins.action_binding_id||profile.connection_target!==pins.target_key||profile.credential_revision<consent.credential_revision||!profile.capability_ceiling.includes('read'))throw Error('EMAIL_ACCESS_DENIED');
 return {profile,module_sha256:entry.module_sha256};
}
