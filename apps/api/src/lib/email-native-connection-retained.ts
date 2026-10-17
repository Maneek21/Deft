import type {NativeEmailConnectionProvider} from './email-native-connection-contract.js';
/** Available only on the exact registered adapter already owning the retained
 * encrypted namespace. No client options or secret bytes cross this port. */
export type RetainedNativeEmailConnectionProfile=Readonly<{
 scope:Readonly<{org_id:string;owner_user_id:string}>;account_id:string;provider:'gmail'|'microsoft';
 credential_namespace_id:string;credential_binding_id:string;credential_action_id:string|null;
 connection_target:string;authority_epoch:number;capability_ceiling:readonly ('read'|'modify'|'send')[];
 principal_digest:string;credential_revision:number;connection:NativeEmailConnectionProvider;
}>;
