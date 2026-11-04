import { z } from 'zod';

/** App-neutral account-target catalog contract. The Host attaches background
 * lease health and account-connection status to each target it hands an App's
 * Experience Worker; the App owns the wording and the recovery navigation. An
 * absent `health` means "unknown" — a consumer must never treat it as healthy. */

const keySchema = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u);
const uuidSchema = z.string().uuid();

/** Closed background-lease health states. `paused` is a lapsed lease still
 * inside its resume grace window; `ended` is outside it or revoked. */
export const EXPERIENCE_BACKGROUND_HEALTH_STATES = ['healthy', 'paused', 'ended'] as const;
export type ExperienceBackgroundHealthState = (typeof EXPERIENCE_BACKGROUND_HEALTH_STATES)[number];

export const ExperienceBackgroundHealthSchema = z.strictObject({
  state: z.enum(EXPERIENCE_BACKGROUND_HEALTH_STATES),
  /** ISO-8601 instant the reported state began. */
  since: z.iso.datetime(),
  /** Closed reason: `live` | `lapsed` | `expired` | `revoked`. */
  reason: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]{0,63}$/u),
});
export type ExperienceBackgroundHealth = z.infer<typeof ExperienceBackgroundHealthSchema>;

/** Account-connection status for a target, derived from the Host's current
 * connection session. `disconnected` covers never-connected and ended setups. */
export const EXPERIENCE_ACCOUNT_CONNECTION_STATES = ['connected', 'disconnected'] as const;
export type ExperienceAccountConnectionState = (typeof EXPERIENCE_ACCOUNT_CONNECTION_STATES)[number];

export const ExperienceAccountTargetHealthSchema = z.strictObject({
  /** Absent = no background lease, so background sync is off — never healthy. */
  background: ExperienceBackgroundHealthSchema.optional(),
  connection: z.enum(EXPERIENCE_ACCOUNT_CONNECTION_STATES),
});
export type ExperienceAccountTargetHealth = z.infer<typeof ExperienceAccountTargetHealthSchema>;

export const ExperienceAccountTargetSchema = z.strictObject({
  key: keySchema,
  label: z.string().min(1).max(80),
  health: ExperienceAccountTargetHealthSchema.optional(),
});
export type ExperienceAccountTarget = z.infer<typeof ExperienceAccountTargetSchema>;

/** Closed recovery steps a Host-rendered button may request. The Host performs
 * the action; the App only supplies the bounded step and never receives tokens
 * or grants from it. */
export const EXPERIENCE_CONNECTION_ACTION_KINDS = ['reconnect', 'restore_access', 'review_consent'] as const;
export type ExperienceConnectionActionKind = (typeof EXPERIENCE_CONNECTION_ACTION_KINDS)[number];

export const ExperienceConnectionActionSchema = z.strictObject({
  kind: z.enum(EXPERIENCE_CONNECTION_ACTION_KINDS),
  installation_id: uuidSchema.optional(),
  target_key: keySchema.optional(),
  consent_id: uuidSchema.optional(),
});
export type ExperienceConnectionAction = z.infer<typeof ExperienceConnectionActionSchema>;
