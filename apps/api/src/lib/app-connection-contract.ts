import { z } from 'zod';
import type { ActionPayloadBinding, PrivateFileReference, PrivateFilePolicy } from './app-private-file-contract.js';
import type { ResourceContentPolicy } from '@deft/app-kit';
import type { HumanActionSourceRecord } from './app-experience-human-action-service.js';

const key = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
export const AppConnectionPinsSchema = z.strictObject({
  org_id: z.string().uuid(), owner_user_id: z.string().uuid(), installation_id: z.string().uuid(),
  app_version_id: z.string().uuid(), grant_snapshot_id: z.string().uuid(), target_key: key,
  resource_key: key, resource_binding_id: z.string().uuid(),
  action_key: key.nullable(), action_binding_id: z.string().uuid().nullable(),
}).refine(value => Boolean(value.action_key) === Boolean(value.action_binding_id));
export type AppConnectionPins = z.infer<typeof AppConnectionPinsSchema>;
export const AppConnectionPurposeSchema = z.enum(['connect', 'status', 'disconnect', 'read_document', 'read_source', 'triage_options', 'browse_resource']);
export type AppConnectionPurpose = z.infer<typeof AppConnectionPurposeSchema>;
export type AppConnectionProjection = Readonly<AppConnectionPins & {
  // Cleanup carries immutable custody nominations, never live action admission.
  purpose: AppConnectionPurpose;
  web_session_id: string; experience_session_id: string; runtime_registration_id: string;
  descriptor_digest: string; allowed_operations: readonly ('list_summary' | 'read_one' | 'search')[];
  content_policy?: ResourceContentPolicy;
  /** Current reviewed actions anchored to this exact owner resource; absent means none. */
  reviewed_action_keys?: readonly string[];
  lifecycle_epoch: number; grant_epoch: number; runtime_epoch: number; expires_at: number; checked_at: number;
}>;

export const AppConnectionCallbackSchema = z.strictObject({
  state: z.string().min(16).max(1024), code: z.string().min(1).max(4096).optional(),
  error: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/).optional(),
}).refine(value => Boolean(value.code) !== Boolean(value.error));
export const AppConnectionManageSchema = z.strictObject({ operation: z.enum(['status', 'disconnect']).optional() });
export type AppConnectionContext = Readonly<{
  projection: AppConnectionProjection;
  recheck: () => Promise<AppConnectionProjection>;
  signal?: AbortSignal;
  /** Trusted current descriptor fields; never nominated by Worker input. */
  search_fields?: readonly string[];
}>;
export interface AppConnectionAdapter {
  handle(request: Request, context: AppConnectionContext): Promise<Response>;
  /** Provider locators are private adapter output; the host discloses scoped UUID handles. */
  browseResource?(input: Readonly<{ operation: 'list' | 'search' | 'conversation'; folder: string;
    query: string;filters?:Readonly<Record<string,string|boolean>>; cursor: string | null; source: Readonly<Record<string, unknown>> | null; limit: number }>,
    context: AppConnectionContext): Promise<Readonly<{ schema_version: string; items: readonly Readonly<{
      revision: string; label: string; data: Readonly<Record<string, string | number | boolean>>;
      provider_source: Readonly<Record<string, unknown>> }>[]; next_cursor: string | null;
      complete: boolean; observed_at: string; count: Readonly<{ returned: number; exact_total: null }>; failure_count: number }>>;
  /** Exact retained record nominated by the host, never a browser provider ID. */
  readResource?(input: Readonly<{ operation: 'read_document'; record: Readonly<{
    record_id: string; revision: string; label: string; data: Readonly<Record<string, string | number | boolean>>;
    provider_source?: Readonly<Record<string, unknown>> }>; }>,
    context: AppConnectionContext): Promise<Readonly<{ format: 'plain' | 'html'; content: string; truncated: boolean; plain_text?: string;
      metadata?: Readonly<Record<string, string | number | boolean>> }>>;
  readSource?(input: Readonly<{record: Readonly<{record_id:string;revision:string;label:string;data:Readonly<Record<string,string|number|boolean>>;provider_source?:Readonly<Record<string,unknown>>}>}>,context:AppConnectionContext):Promise<Readonly<{bytes:Uint8Array;media_type:string;filename:string}>>;
  /** Source-derived hosted inspection. Opaque part selectors confer no authority. */
  readSourceFiles?(input: Readonly<{record:Readonly<{record_id:string;revision:string;label:string;data:Readonly<Record<string,string|number|boolean>>;provider_source?:Readonly<Record<string,unknown>>}>;file_ref?:string;image_ref?:string;presentation?:true}>,context:AppConnectionContext):Promise<unknown>;
  readTriageOptions?(input: Readonly<{record:Readonly<{record_id:string;revision:string;label:string;data:Readonly<Record<string,string|number|boolean>>;provider_source?:Readonly<Record<string,unknown>>}>}>,context:AppConnectionContext):Promise<unknown>;
  /** Server-only builder selected by deployment pins, never Worker input. */
  buildActionPayload?(input: Readonly<{
    binding: ActionPayloadBinding; input: Readonly<Record<string, string | number | boolean>>;
    draft_value: Readonly<Record<string, string | number | boolean>>;
    draft_updated_at: string;
    files: readonly Readonly<{ reference: PrivateFileReference; bytes: Uint8Array }>[];
    files_policy?: PrivateFilePolicy; max_payload_bytes: number; expires_at: string;
    source_records?: Readonly<Record<string, readonly HumanActionSourceRecord[]>>;
  }>, context: AppConnectionContext): Promise<Readonly<{ metadata: Record<string, unknown>; bytes: Uint8Array }>>;
}
