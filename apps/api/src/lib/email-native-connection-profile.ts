import {z} from 'zod';
import type {AppConnectionAdapter} from './app-connection-contract.js';
import type {NativeEmailConnectionBinding,NativeEmailConnectionProvider} from './email-native-connection-contract.js';
const id=z.string().min(1).max(256).refine(v=>v===v.trim()&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v));
export const NativeEmailAccountBridgeSchema=z.strictObject({
 kind:z.literal('native_owner_provider_v1'),scope:z.strictObject({org_id:id,owner_user_id:id,account_id:id}),provider:z.enum(['gmail','microsoft']),
 profile_id:id,profile_revision:z.number().int().positive().max(2147483646),module_sha256:z.string().regex(/^[a-f0-9]{64}$/u),
 credential_namespace_id:id,credential_binding_id:id,credential_action_id:id.nullable(),connection_target:id,authority_epoch:z.number().int().positive().max(2147483646),
});
export type NativeEmailAccountBridge=Readonly<z.infer<typeof NativeEmailAccountBridgeSchema>>;
export type NativeEmailProfileMailboxAdapter=Pick<AppConnectionAdapter,Extract<keyof AppConnectionAdapter,`nativeEmail${string}`>>;
export type NativeEmailProviderProfile=Readonly<{connection:NativeEmailConnectionProvider;mailbox(binding:NativeEmailConnectionBinding):NativeEmailProfileMailboxAdapter}>;
export function nativeEmailAccountBridge(binding:NativeEmailConnectionBinding):NativeEmailAccountBridge{
 if(binding.source!=='native_owner_provider_v1')throw Error('EMAIL_CONNECTION_PROFILE_UNAVAILABLE');
 return NativeEmailAccountBridgeSchema.parse({kind:binding.source,scope:{...binding.scope,account_id:binding.account_id},provider:binding.provider,profile_id:binding.profile_id,profile_revision:binding.profile_revision,module_sha256:binding.module_sha256,credential_namespace_id:binding.credential_namespace_id,credential_binding_id:binding.credential_binding_id,credential_action_id:binding.credential_action_id,connection_target:binding.connection_target,authority_epoch:binding.authority_epoch});
}
