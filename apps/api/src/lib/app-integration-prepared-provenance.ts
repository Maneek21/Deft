import {z} from 'zod';
const digest=z.string().regex(/^sha256:[a-f0-9]{64}$/u);
/** Content-free lineage carried only inside the existing encrypted human
 * ticket. Public tool input and human preparation HTTP schemas have no field
 * capable of constructing this authority. */
export const AppIntegrationPreparedProvenanceSchema=z.strictObject({
 invocation_id:z.uuid(),invocation_digest:digest,prepared_kind:z.enum(['record','resource']),
 snapshot_id:z.uuid(),snapshot_digest:digest,action_key:z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u),
 installation_id:z.uuid(),account_ref:z.string().min(1).max(512),resource_binding_id:z.uuid(),
 store_key:z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u),expires_at:z.iso.datetime(),
});
export type AppIntegrationPreparedProvenance=Readonly<z.infer<typeof AppIntegrationPreparedProvenanceSchema>>;
const minted=new WeakSet<object>();
/** Called by the original completed-invocation loader after fresh exact
 * principal/grant and immutable prepared-byte checks, never by a route parser. */
export function captureAppIntegrationPreparedProvenance(raw:unknown):AppIntegrationPreparedProvenance{
 const value=Object.freeze(AppIntegrationPreparedProvenanceSchema.parse(raw));minted.add(value);return value;
}
export function assertCapturedAppIntegrationPreparedProvenance(value:AppIntegrationPreparedProvenance,kind:'record'|'resource',action:string,installation:string,account:string,binding:string,now:number){
 if(!minted.has(value)||value.prepared_kind!==kind||value.action_key!==action||value.installation_id!==installation||value.account_ref!==account||value.resource_binding_id!==binding||Date.parse(value.expires_at)<=now)throw new Error('APP_INTEGRATION_PREPARED_AUTHORITY_STALE');
 return value;
}
