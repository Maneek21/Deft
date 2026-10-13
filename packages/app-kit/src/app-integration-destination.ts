import {z} from 'zod';
import {AppIntegrationSourceIdentitySchema} from './app-integration-source.js';
const digest=z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const AppIntegrationDestinationSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('note'),visibility:z.enum(['private','org','space']),space_id:z.uuid().nullable()}).refine(v=>(v.visibility==='space')===(v.space_id!==null)),
 z.strictObject({kind:z.literal('knowledge'),space_id:z.uuid(),type:z.enum(['concept','entity','decision','resource','procedure','preference','fact'])}),
 z.strictObject({kind:z.literal('chat'),space_id:z.uuid()}),
 z.strictObject({kind:z.literal('task'),project_id:z.uuid()}),
]);
export const AppIntegrationDestinationReviewInputSchema=z.strictObject({source:AppIntegrationSourceIdentitySchema,
 destination:AppIntegrationDestinationSchema,title:z.string().trim().min(1).max(512),mode:z.enum(['source_link','excerpt']),
 excerpt:z.string().min(1).max(20000).refine(v=>!v.includes('\0')).optional()})
 .refine(v=>(v.mode==='excerpt')===(v.excerpt!==undefined));
export const AppIntegrationDestinationCommitInputSchema=AppIntegrationDestinationReviewInputSchema.safeExtend({request_id:z.uuid(),review_digest:digest});
export type AppIntegrationDestination=z.infer<typeof AppIntegrationDestinationSchema>;
export type AppIntegrationDestinationReviewInput=z.infer<typeof AppIntegrationDestinationReviewInputSchema>;
export type AppIntegrationDestinationCommitInput=z.infer<typeof AppIntegrationDestinationCommitInputSchema>;
export const AppIntegrationCalendarActionSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('import')}),z.strictObject({kind:z.literal('rsvp'),response:z.enum(['accepted','tentative','declined']),send_response:z.boolean()}),
 z.strictObject({kind:z.literal('cancel')}),
]);
export type AppIntegrationCalendarAction=z.infer<typeof AppIntegrationCalendarActionSchema>;
export const AppIntegrationRecipientAssistanceResultSchema=z.strictObject({items:z.array(z.strictObject({address:z.email().max(320),name:z.string().max(512),provenance:z.array(z.enum(['contacts','recent'])).min(1).max(2)})).max(10),sources:z.strictObject({contacts:z.enum(['available','unavailable','not_installed']),recent:z.enum(['available','unavailable'])}),partial:z.literal(true),has_more:z.boolean()});
export type AppIntegrationRecipientAssistanceResult=z.infer<typeof AppIntegrationRecipientAssistanceResultSchema>;
