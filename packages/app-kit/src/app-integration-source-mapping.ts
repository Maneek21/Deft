import {z} from 'zod';
const key=z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u).refine(value=>!['constructor','prototype','__proto__'].includes(value));
export const AppIntegrationSourceMappingSchema=z.strictObject({sync_descriptor_key:key,record_id_field:key,content_digest_field:key,observed_at_field:key,projection_identity_field:key,navigation_entry_key:key})
 .refine(value=>new Set([value.record_id_field,value.content_digest_field,value.observed_at_field,value.projection_identity_field]).size===4);
export type AppIntegrationSourceMapping=z.infer<typeof AppIntegrationSourceMappingSchema>;
/** Declaration admission only; actual values/authority are checked per read. */
export function appIntegrationSourceMappingIsDeclared(mapping:AppIntegrationSourceMapping,descriptor:{key:string;record_schema:{properties:Record<string,unknown>;required?:string[]}},experienceKeys:readonly string[]){
 if(mapping.sync_descriptor_key!==descriptor.key||!experienceKeys.includes(mapping.navigation_entry_key))return false;
 const fields:[[string,number],[string,number],[string,number],[string,number]]=[[mapping.record_id_field,36],[mapping.content_digest_field,71],[mapping.observed_at_field,64],[mapping.projection_identity_field,256]];
 return fields.every(([name,limit])=>{const value=descriptor.record_schema.properties[name] as {type?:unknown;maxLength?:unknown}|undefined;return descriptor.record_schema.required?.includes(name)&&value?.type==='string'&&Number.isInteger(value.maxLength)&&Number(value.maxLength)>0&&Number(value.maxLength)<=limit;});
}
