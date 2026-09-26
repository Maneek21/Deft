import { ResourceSyncResultRequestV3Schema, parseSyncPageV2 } from '@deft/app-kit';
import { APP_RUN_CONTRACT_VERSIONS,AppRunRetainedProviderResultSchema,assertAppRunOutputWithinBudget } from '@deft/shared';
export type AttachmentSyncResultRequest = ReturnType<typeof ResourceSyncResultRequestV3Schema.parse>;
export function parseAttachmentSyncResult(value: unknown,pin:{descriptor:unknown;starting_request:unknown}) {
  const result=ResourceSyncResultRequestV3Schema.parse(value);
  if (result.status !== 'returned' || !result.provider_succeeded) return result;
  const page=parseSyncPageV2(pin.descriptor,pin.starting_request,result.page);
  assertAppRunOutputWithinBudget(AppRunRetainedProviderResultSchema.parse({
    schema_version:APP_RUN_CONTRACT_VERSIONS.provider_result,provider_succeeded:true,output:page }));
  return {...result,page};
}
