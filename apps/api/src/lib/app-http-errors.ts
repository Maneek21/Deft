import { z } from 'zod';

/** Fixed enum of recovery steps a Host denial may point at. App-neutral: the
 * owning app supplies the wording and the navigation; the Host only ever emits
 * a bounded, validated step, never free text or provider callbacks. */
export const APP_NEXT_STEP_KINDS = ['restore_access', 'reconnect', 'review_consent'] as const;
export type AppNextStepKind = (typeof APP_NEXT_STEP_KINDS)[number];

export const AppNextStepSchema = z.strictObject({
  kind: z.enum(APP_NEXT_STEP_KINDS),
  installation_id: z.string().uuid().optional(),
  target_key: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u).optional(),
  consent_id: z.string().uuid().optional(),
});
export type AppNextStep = z.infer<typeof AppNextStepSchema>;

/** Validate an untrusted next_step value. Returns undefined when it is
 * malformed or off-whitelist so an invalid payload is silently dropped, never
 * echoed into an owner-facing error body. */
export function appHttpNextStep(value: unknown): AppNextStep | undefined {
  const parsed = AppNextStepSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Sanitize an AppError `details` object: keep everything except a
 * `next_step`, which is replaced only when it validates against the enum/ids.
 * A malformed `next_step` is dropped, never propagated. */
export function appHttpDetails(details: Record<string, unknown>): Record<string, unknown> {
  const next = { ...details };
  if ('next_step' in next) {
    const validated = appHttpNextStep(next.next_step);
    if (validated) next.next_step = validated;
    else delete next.next_step;
  }
  return next;
}

/** Owner-facing error details for a Host denial. `APP_REVIEW_REQUIRED` always
 * carries a concrete next step: a service-supplied, validated step when it has
 * one, otherwise the app-neutral `review_consent` default. Status/error mapping
 * is left to the caller and never changes here. */
export function appHttpFailureDetails(code: string, details?: Record<string, unknown>): Record<string, unknown> | undefined {
  const sanitized = details ? appHttpDetails(details) : {};
  if (code === 'APP_REVIEW_REQUIRED' && !sanitized.next_step) sanitized.next_step = { kind: 'review_consent' };
  return Object.keys(sanitized).length ? sanitized : undefined;
}
