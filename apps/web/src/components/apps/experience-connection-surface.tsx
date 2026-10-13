import type {ReactNode} from 'react';
/** App-owned record bundles exclusively use their admitted Runtime connections.
 * Retained native/older App settings preserve their existing default surface. */
export function LegacyConnectionSettingsGate({appOwnedRecords,children}:{appOwnedRecords?:boolean;children:ReactNode}){return appOwnedRecords?null:children;}
