import { sql, type SQL } from 'drizzle-orm';
import { projects, tasks } from '@deft/db/schema';

// A task's key is its project's prefix and its number: DEFT-5. A prefix may
// hold digits (R9G-1, RC8-12), so a key is never split by guessing where the
// letters end; it is compared whole against prefix and number.

/**
 * True for the task whose key equals `key`, written PREFIX-N or PREFIXN, in
 * any case. `projects` must be joined to `tasks`. The number is compared as
 * written, so a zero-padded key (R9G-01) matches nothing.
 */
export function taskKeyMatch(key: string): SQL {
  const wanted = key.trim().toUpperCase();
  return sql`(upper(${projects.prefix}) || '-' || ${tasks.number}::text = ${wanted}
      OR upper(${projects.prefix}) || ${tasks.number}::text = ${wanted})`;
}

// A key written in text (a note, a message): capital letters and digits,
// starting with a letter, then a dash and the number.
const TASK_KEY_IN_TEXT = /[A-Z][A-Z0-9]*-\d+/g;

/** The distinct task keys written in `text`, in order of first appearance. */
export function taskKeysIn(text: string): string[] {
  return [...new Set(text.match(TASK_KEY_IN_TEXT) ?? [])];
}

/** True when `text` names at least one task key. */
export function mentionsTaskKey(text: string): boolean {
  return taskKeysIn(text).length > 0;
}
