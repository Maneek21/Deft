import { z } from 'zod';
const uuid = z.uuid();
const token = z.string().min(32).max(512).regex(/^[A-Za-z0-9_-]+$/u);
export const ResourceSyncSessionCredentialSchema = z.strictObject({
  session_id: uuid, session_token: token,
});
export type ResourceSyncSessionCredential = z.infer<typeof ResourceSyncSessionCredentialSchema>;

export const ResourceSyncErrorSchema = z.strictObject({
  code: z.enum([
    'APP_RESOURCE_SYNC_DISABLED', 'APP_RESOURCE_SYNC_ACCESS_DENIED',
    'APP_RESOURCE_SYNC_INVALID_REQUEST', 'APP_RESOURCE_SYNC_TOO_LARGE',
    'APP_RESOURCE_SYNC_TIMEOUT', 'APP_RESOURCE_SYNC_FAILURE',
  ]),
  error: z.enum([
    'Resource sync channel unavailable', 'Resource sync credential required',
    'Invalid resource sync request', 'Resource sync request too large',
    'Resource sync request timed out', 'Resource sync request failed',
  ]),
});
