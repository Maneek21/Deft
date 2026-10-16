import { type DeftAppManifestV6 } from '@deft/app-kit';
import { digestAppGrantValue } from './app-grant-service.js';
import { nativeActionDescriptors } from './app-native-contract.js';
import { runtimeActionDescriptors } from './app-runtime-review.js';

export function buildNativeAppReviewedAuthority(manifest: DeftAppManifestV6, pins: {
  lineage_key: string; package_digest: string; manifest_digest: string;
}) {
  return { schema: 'deft.app_native_grant.v1' as const, ...pins,
    native_actions: nativeActionDescriptors(manifest), runtime_actions: runtimeActionDescriptors(manifest),
    sync_descriptors: manifest.sync_descriptors.map(descriptor => ({ ...descriptor, descriptor_digest: digestAppGrantValue(descriptor) })),
    modules: manifest.modules, experiences: manifest.experiences, public_actions: manifest.public_actions };
}
export const NATIVE_APP_EFFECTIVE_CLASSIFICATION = Object.freeze({
  authority_state: 'effective', executable: false, provider_access: false,
  runtime_binding_review_required: true, resource_binding_consent_required: true, native_binding_consent_required: true,
});
