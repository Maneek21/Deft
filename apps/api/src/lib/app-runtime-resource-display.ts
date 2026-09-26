import type { ResourceRefV2 } from '@deft/shared/resources-v2';
import { AppError } from './app-errors.js';
import { AppResourcePrivateReadError, AppResourcePrivateReadService } from './app-resource-private-read.js';
import { getAppRunRuntime } from './app-run-runtime.js';
import { resourceSyncWebAuthority, ResourceSyncWebAuthenticationError } from './app-resource-sync-web-authority.js';
import { isAppResourceSyncChannelEnabled } from './env.js';
import type { NativeResourceWebCaller } from './native-resource-service.js';
import { ResourceAuthorizationError } from './resource-authorization.js';

/** Closed host adapter, never selected from App-supplied code or a provider URL. */
export async function resolveAppRuntimeDisplay(caller: NativeResourceWebCaller, ref: ResourceRefV2,
  authorization: string | undefined): Promise<Readonly<{ label: string; href: string }> | null> {
  if (!isAppResourceSyncChannelEnabled()) return null;
  try {
    const { actor, guard } = await resourceSyncWebAuthority(authorization, caller);
    const runtime = await getAppRunRuntime();
    const reader = new AppResourcePrivateReadService(runtime.keys, () => new Date(), runtime.repository, guard);
    const display = await reader.resolveOwnerPrivateDisplay({ kind: 'human', org_id: actor.org_id,
      user_id: actor.actor_id }, ref);
    return { ...display, href: `/app-resources/${encodeURIComponent(ref.provider.provider_instance_id)}/${encodeURIComponent(ref.resource_type)}/${encodeURIComponent(ref.resource_id)}` };
  } catch (error) {
    if (error instanceof AppResourcePrivateReadError && error.code === 'APP_RESOURCE_PRIVATE_UNAVAILABLE') return null;
    if (error instanceof ResourceSyncWebAuthenticationError || error instanceof AppError) {
      throw new ResourceAuthorizationError('Resource access denied', 'RESOURCE_ACCESS_DENIED', 403);
    }
    throw error;
  }
}
