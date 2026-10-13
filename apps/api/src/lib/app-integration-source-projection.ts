import {z} from 'zod';
import {AppIntegrationSourceMappingSchema,AppIntegrationSourceTargetSchema,AppIntegrationSourceIdentitySchema,type AppIntegrationSourceMapping,type AppIntegrationSourceTarget} from '../../../../packages/app-kit/src/app-integration-source.js';
import {appIntegrationSourceDigest,type AppIntegrationPublishedSource} from './app-integration-source.js';
export function appIntegrationExactLocatorCandidate<T extends {resource_id_hmac_key_version:string;resource_id_hmac:string}>(rows:readonly T[],locators:readonly {key_version:string;fingerprint:string}[]):T{
 if(rows.length>32||locators.length>32)throw new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED');
 const exact=rows.filter(row=>locators.some(locator=>locator.key_version===row.resource_id_hmac_key_version&&locator.fingerprint===row.resource_id_hmac));
 if(exact.length!==1)throw new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED');return exact[0]!;
}

/** The adapter's caller must have loaded the reviewed signed store declaration
 * and decrypted the exact projection under existing binding/checkpoint locks. */
export function appIntegrationPublishedProjection(input:{target:AppIntegrationSourceTarget;
 mapping:AppIntegrationSourceMapping;descriptor_key:string;checkpoint:{id:string;generation:number;cursor_sequence:number;state:string};
 row:{id:string;resource_binding_id:string;checkpoint_id:string;generation:number;state:string;applied_sequence:number};
 record:{revision:string;data:Record<string,string|number|boolean>}}):AppIntegrationPublishedSource{
 const {checkpoint,row,record}=input,target=AppIntegrationSourceTargetSchema.parse(input.target),mapping=AppIntegrationSourceMappingSchema.parse(input.mapping);
 if(mapping.sync_descriptor_key!==input.descriptor_key||row.id!==target.projection_id||row.resource_binding_id!==target.resource_binding_id
  ||row.checkpoint_id!==checkpoint.id||row.generation!==checkpoint.generation||row.state!=='live'||checkpoint.state!=='active'
  ||row.applied_sequence<1||row.applied_sequence>checkpoint.cursor_sequence||checkpoint.generation<1
  ||record.data[mapping.record_id_field]!==target.ref.record_id||record.data[mapping.content_digest_field]!==target.ref.content_digest)
  throw new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED');
 const observed_at=z.iso.datetime().parse(record.data[mapping.observed_at_field]);
 return {target,checkpoint_id:checkpoint.id,generation:checkpoint.generation,cursor_sequence:checkpoint.cursor_sequence,
  projection_revision:record.revision,applied_sequence:row.applied_sequence,payload_digest:appIntegrationSourceDigest(record),observed_at,partial:true};
}

/** The lookup scalar identifies one encrypted row; it never supplies the UUID
 * or digest, which must come from that current reviewed signed projection. */
export function appIntegrationProjectedIdentity(scope:{installation_id:string;account_ref:string;store_key:string;resource_key:string},rawMapping:AppIntegrationSourceMapping,record:{data:Record<string,string|number|boolean>},logical:string){
 const mapping=AppIntegrationSourceMappingSchema.parse(rawMapping);
 if(typeof logical!=='string'||!logical||logical.length>256||record.data[mapping.projection_identity_field]!==logical)throw new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED');
 return AppIntegrationSourceIdentitySchema.parse({installation_id:scope.installation_id,account_ref:scope.account_ref,store_key:scope.store_key,
  ref:{resource_key:scope.resource_key,record_id:record.data[mapping.record_id_field],content_digest:record.data[mapping.content_digest_field]}});
}
