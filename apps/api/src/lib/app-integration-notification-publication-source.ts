import {z} from 'zod';import {AppIntegrationSourceMappingSchema,type AppIntegrationSourceIdentity} from '../../../../packages/app-kit/src/app-integration-source.js';import {appIntegrationProjectedIdentity} from './app-integration-source-projection.js';
export type RecordRow={id:string;revision:string;data:Record<string,string|number|boolean>};
/** A committed publication supplies the UUID/digest through the signed scalar
 * mapping. Current retained connection metadata supplies its exact account.
 * No browser permission or provider identifiers become notification grants. */
export function appIntegrationNotificationPublicationSources(input:{installation_id:string;resource_key:string;descriptor_key:string;stores:readonly {key:string;resource_key:string;source_projection?:unknown}[];accounts:readonly string[];records:readonly RecordRow[]}):AppIntegrationSourceIdentity[]{
 if(input.accounts.length!==1||input.records.length>1000||input.stores.length>64)throw Error('APP_INTEGRATION_NOTIFICATION_PUBLICATION_DENIED');const account_ref=z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u).parse(input.accounts[0]),result:AppIntegrationSourceIdentity[]=[];
 for(const store of input.stores.filter(row=>row.resource_key===input.resource_key&&row.source_projection)){const mapping=AppIntegrationSourceMappingSchema.parse(store.source_projection);if(mapping.sync_descriptor_key!==input.descriptor_key)throw Error('APP_INTEGRATION_NOTIFICATION_PUBLICATION_DENIED');for(const row of input.records){if(row.data.deleted===true||row.data.seen!==false)continue;result.push(appIntegrationProjectedIdentity({installation_id:input.installation_id,account_ref,store_key:store.key,resource_key:input.resource_key},mapping,row,row.id));}}
 if(result.length>1000)throw Error('APP_INTEGRATION_NOTIFICATION_PUBLICATION_DENIED');return result;
}
