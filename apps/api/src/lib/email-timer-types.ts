import { z } from 'zod';

const Id = z.string().min(1).max(256).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const TimerId = z.string().uuid();
const LogicalMessageId = z.string().regex(/^mail_[a-f0-9]{64}$/u);
export const EmailTimerKindSchema = z.enum(['snooze', 'follow_up']);
export const EmailTimerStateSchema = z.enum(['scheduled', 'firing', 'completed', 'cancelled', 'blocked']);
export const EmailTimerScheduleSchema = z.strictObject({
  wall_time: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u),
  zone: z.string().min(1).max(128),
  ambiguity: z.enum(['reject', 'earlier', 'later']),
});
export const EmailTimerContentSchema = z.strictObject({
  logical_message_id: LogicalMessageId,
  kind: EmailTimerKindSchema,
  reminder_text: z.string().max(2048).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)).optional(),
});
export const EmailTimerWriteSchema = z.union([
  z.strictObject({ expected_revision: z.literal(0), logical_message_id: LogicalMessageId, kind: EmailTimerKindSchema,
    schedule: EmailTimerScheduleSchema, reminder_text: EmailTimerContentSchema.shape.reminder_text }),
  z.strictObject({ expected_revision: z.number().int().min(1).max(2147483646), schedule: EmailTimerScheduleSchema,
    reminder_text: EmailTimerContentSchema.shape.reminder_text }),
]);
export const EmailTimerCancelSchema = z.strictObject({ expected_revision: z.number().int().min(1).max(2147483646) });
export const EmailTimerListQuerySchema = z.strictObject({
  kind: EmailTimerKindSchema.optional(), state: EmailTimerStateSchema.optional(), cursor: z.string().min(1).max(8192).nullable(),
  limit: z.number().int().min(1).max(50),
});
export const EmailTimerScopeSchema = z.strictObject({ org_id: Id, owner_user_id: Id, account_id: Id });
export const EmailTimerActorSchema = z.strictObject({ user_id: Id, web_session_id: Id, access_expires_at: z.number().finite() });
export const EmailTimerJobSchema = EmailTimerScopeSchema.extend({ timer_id: TimerId,
  revision: z.number().int().min(1).max(2147483646), authority_revision: z.number().int().min(1).max(2147483647) });
export const EMAIL_TIMER_JOB = 'native-email-timers' as const;
export type EmailTimerJob = Readonly<z.infer<typeof EmailTimerJobSchema>>;
export type EmailTimerLease = Readonly<{ job_id: string; lock_token: string; lease_expires_at?: Date; job_name: typeof EMAIL_TIMER_JOB; timer_id: string; revision: number }>;
export const EmailTimerIdSchema = TimerId;
export const EmailLogicalMessageIdSchema = LogicalMessageId;

export type EmailTimerKind = z.infer<typeof EmailTimerKindSchema>;
export type EmailTimerState = z.infer<typeof EmailTimerStateSchema>;
export type EmailTimerContent = Readonly<z.infer<typeof EmailTimerContentSchema>>;
export type EmailTimerSchedule = Readonly<z.infer<typeof EmailTimerScheduleSchema>>;
export type EmailTimerWrite = Readonly<z.infer<typeof EmailTimerWriteSchema>>;
export type EmailTimerListQuery = Readonly<z.infer<typeof EmailTimerListQuerySchema>>;
export type EmailTimerView = Readonly<{ timer_id: string; account_id: string; logical_message_id: string; kind: EmailTimerKind;
  scheduled_at: string; display_timezone: string; revision: number; state: EmailTimerState; reminder_text?: string; updated_at: string }>;
export type EmailTimerPage = Readonly<{ items: readonly EmailTimerView[]; next_cursor: string | null; has_more: boolean }>;
export class EmailTimerError extends Error {
  constructor(readonly code: 'EMAIL_TIMER_ACCESS_DENIED' | 'EMAIL_TIMER_INVALID' | 'EMAIL_TIMER_CONFLICT'
    | 'EMAIL_TIMER_NOT_FOUND' | 'EMAIL_TIMER_UNAVAILABLE') { super(code); this.name = 'EmailTimerError'; }
}
