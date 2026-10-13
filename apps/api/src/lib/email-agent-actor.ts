import { z } from 'zod';
const id = z.string().min(1).max(256).refine(v => v.trim() === v && !/[\u0000-\u001f\u007f-\u009f]/u.test(v));
export const EmailHumanActorSchema = z.strictObject({ user_id: id, web_session_id: id, access_expires_at: z.number().finite() });
/** Separate native delegation principal. It never represents a browser SID. */
export const EmailAgentActorSchema = z.strictObject({ user_id: id, agent_grant_id: z.string().uuid(),
  principal_kind: z.enum(['defty', 'personal_mcp']), principal_id: id, access_expires_at: z.number().finite(),
  token_authorization_version:z.number().int().positive().optional(),conversation_id:id.optional(),employee_id:id.optional(),
  review_session_id:id.optional(),review_expires_at:z.number().finite().optional() });
export const EmailOperationActorSchema = z.union([EmailHumanActorSchema, EmailAgentActorSchema]);
export type EmailAgentActor = Readonly<z.infer<typeof EmailAgentActorSchema>>;
export type EmailOperationActor = Readonly<z.infer<typeof EmailOperationActorSchema>>;
