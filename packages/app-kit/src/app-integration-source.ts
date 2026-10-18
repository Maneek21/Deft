import {z} from 'zod';
import {AppDataSourceReferenceSchema} from './app-data.js';

const key=z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u)
 .refine(value=>!['constructor','prototype','__proto__'].includes(value));
/** Signed mapping into the existing declared scalar sync record. No provider
 * identifier, connection lease or authority is supplied by a citation. */
export {AppIntegrationSourceMappingSchema,type AppIntegrationSourceMapping} from './app-integration-source-mapping.js';
export const AppIntegrationSourceIdentitySchema=z.strictObject({installation_id:z.uuid(),
 account_ref:z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u),store_key:key,
 ref:AppDataSourceReferenceSchema});
export type AppIntegrationSourceIdentity=z.infer<typeof AppIntegrationSourceIdentitySchema>;
export const AppIntegrationSourceTargetSchema=AppIntegrationSourceIdentitySchema.extend({resource_binding_id:z.uuid(),projection_id:z.uuid()});
export type AppIntegrationSourceTarget=z.infer<typeof AppIntegrationSourceTargetSchema>;
export const APP_INTEGRATION_SOURCE_PURPOSES=['read','transfer','knowledge_capture','tool_read','notification_projection'] as const;
export type AppIntegrationSourcePurpose=typeof APP_INTEGRATION_SOURCE_PURPOSES[number];
export const AppIntegrationCapturePolicyInputSchema=z.strictObject({enabled:z.boolean(),
 destination:z.strictObject({scope:z.enum(['user','space']),space_id:z.uuid().nullable()}),
 history_days:z.number().int().min(1).max(365),include_bulk:z.boolean(),
 excluded_senders:z.array(z.string().min(1).max(320)).max(50),
 excluded_folders:z.array(z.string().min(1).max(256)).max(50),
 expected_revision:z.number().int().nonnegative()})
 .refine(value=>(value.destination.scope==='user')===(value.destination.space_id===null));
export type AppIntegrationCapturePolicyInput=z.infer<typeof AppIntegrationCapturePolicyInputSchema>;
export const AppIntegrationCaptureNominationV1Schema=z.strictObject({schema_version:z.literal('deft.app_capture_nomination.v1'),eligible:z.boolean(),
 reason:z.string().regex(/^[a-z_]{1,64}$/u).optional(),body_digest:z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),
 thread_key:z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),sender:z.string().max(320),received_at:z.string().max(64).nullable(),
 is_bulk:z.boolean(),partial:z.literal(true),attachments_processed:z.literal(false)}).refine(row=>!row.eligible||!!row.body_digest&&!!row.thread_key);
export const APP_INTEGRATION_CAPTURE_NOMINATION_BYTES=98304;
/** App-owned source evidence. Host verifies authority/digests; it never derives domain text. */
export const AppIntegrationCaptureNominationV2Schema=z.strictObject({schema_version:z.literal('deft.app_capture_nomination.v2'),eligible:z.boolean(),
 reason:z.string().regex(/^[a-z_]{1,64}$/u).optional(),body:z.string().max(16000).optional(),
 body_digest:z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),thread_key:z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),
 sender:z.string().max(320).regex(/^[^\u0000-\u001f\u007f]*$/u),received_at:z.string().max(64).nullable(),
 folders:z.array(z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/u)).max(16).refine(rows=>new Set(rows).size===rows.length),
 is_bulk:z.boolean(),partial:z.literal(true),attachments_processed:z.literal(false)})
 .refine(row=>!row.eligible||!!row.body&&row.body.length>=40&&!!row.body_digest&&!!row.thread_key)
 .refine(row=>new TextEncoder().encode(JSON.stringify(row)).byteLength<=APP_INTEGRATION_CAPTURE_NOMINATION_BYTES);
export const AppIntegrationCaptureNominationSchema=z.discriminatedUnion('schema_version',[AppIntegrationCaptureNominationV1Schema,AppIntegrationCaptureNominationV2Schema]);
export type AppIntegrationCaptureNomination=z.infer<typeof AppIntegrationCaptureNominationSchema>;
