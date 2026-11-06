import { z } from 'zod';
import { ExperienceConnectionActionSchema as AppNextStepSchema, EXPERIENCE_CONNECTION_ACTION_KINDS as APP_NEXT_STEP_KINDS } from '@deft/app-kit/experience/core';
export { AppNextStepSchema, APP_NEXT_STEP_KINDS };

/** Fixed enum of recovery steps a Host denial may point at. App-neutral: the
 * owning app supplies the wording and the navigation; the Host only ever emits
 * a bounded, validated step, never free text or provider callbacks. Re-exported
 * from the Kit's `ExperienceConnectionActionSchema` so there is one schema. */
export type AppNextStepKind = (typeof APP_NEXT_STEP_KINDS)[number];

/** Public, stable 403 `details.next_step` contract. A Host denial attaches one
 * validated step; the App performs the navigation and wording. This is the Kit's
 * `ExperienceConnectionActionSchema` re-exported, not a duplicate.
 *
 * - `kind` - always present, one of `reconnect` | `restore_access` | `review_consent`.
 * - `installation_id` - optional UUID; supplied for `reconnect` and
 *   `restore_access` (the Host resolves the exact installation), absent for a
 *   bare `review_consent` default.
 * - `target_key` - optional `^[a-z][a-z0-9_]{0,47}$`; supplied for `reconnect`
 *   and `restore_access`, absent for a bare `review_consent`.
 * - `consent_id` - optional UUID; may accompany `review_consent` when the Host
 *   can point at one exact consent, otherwise absent.
 *
 * Every id is optional so a bare `{ kind: 'review_consent' }` default is valid,
 * but a `reconnect`/`restore_access` step always carries `installation_id` and
 * `target_key` so the App can act without guessing. Unknown kinds, extra keys
 * and malformed ids are dropped by `appHttpNextStep`, never echoed. */
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
