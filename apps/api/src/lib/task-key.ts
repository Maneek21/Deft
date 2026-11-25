import { sql, type SQL } from 'drizzle-orm';
import { projects, tasks } from '@deft/db/schema';

// A task's key is its project's prefix and its number: DEFT-5. A prefix may
// hold digits (R9G-1, RC8-12), so a key is never split by guessing where the
// letters end; it is compared whole against prefix and number.

/**
 * True for the task whose key equals `key`, in any case. `projects` must be
 * joined to `tasks`. The number is compared as written, so a zero-padded key
 * (R9G-01) matches nothing. Search also takes the key without its dash
 * (PREFIXN); `{ exact: true }` takes only PREFIX-N, for a key read out of
 * text, where the dashless form could name a second project (prefix `AB-`,
 * task 1, also reads `AB-1`).
 */
export function taskKeyMatch(key: string, opts: { exact?: boolean } = {}): SQL {
  const wanted = key.trim().toUpperCase();
  const withDash = sql`upper(${projects.prefix}) || '-' || ${tasks.number}::text = ${wanted}`;
  if (opts.exact) return sql`(${withDash})`;
  return sql`(${withDash}
      OR upper(${projects.prefix}) || ${tasks.number}::text = ${wanted})`;
}

// A key written in text (a note, a message): a prefix of capital letters and
// digits holding at least one letter (R9G, 9RC), a dash and the number, as a
// whole word: not inside a longer run of letters and digits (preR9G-1,
// R9G-1draft).
const TASK_KEY_IN_TEXT = /(?<![A-Za-z0-9])(?=[0-9]*[A-Z])[A-Z0-9]+-\d+(?![A-Za-z0-9])/g;

/** The distinct task keys written in `text`, in order of first appearance. */
export function taskKeysIn(text: string): string[] {
  return [...new Set(text.match(TASK_KEY_IN_TEXT) ?? [])];
}

/** True when `text` names at least one task key. */
export function mentionsTaskKey(text: string): boolean {
  return taskKeysIn(text).length > 0;
}
