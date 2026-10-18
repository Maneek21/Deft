import { z } from 'zod';

const id = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
// Single unmodified keys only. Browser/system/Deft command chords stay with the host.
const key = z.string().regex(/^[a-z/]$/);
export const DeftExperienceKeyboardSchema = z.strictObject({
  schema_version: z.literal('deft.experience_keyboard.v1'),
  bindings: z.array(z.strictObject({
    key, target_id: id, behavior: z.enum(['activate', 'focus']),
    focus_after: id.optional(),
  }).refine(value => !value.focus_after || value.behavior === 'activate',
    'Focus handoff requires activation')).max(8),
  navigation: z.strictObject({ previous_key: key, next_key: key, list_id: id }).optional(),
}).refine(value => {
  const keys = [...value.bindings.map(binding => binding.key),
    ...(value.navigation ? [value.navigation.previous_key, value.navigation.next_key] : [])];
  return new Set(keys).size === keys.length;
}, 'Shortcut keys must be unique');
export type DeftExperienceKeyboard = z.infer<typeof DeftExperienceKeyboardSchema>;
