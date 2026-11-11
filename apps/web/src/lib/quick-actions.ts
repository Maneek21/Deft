/**
 * Surface-agnostic action handlers shared by the command palette and the chat
 * slash menu's chat-only commands. Lives outside any one component so both
 * the palette (`>dnd`, `Set status`, …) and chat composer (`/dnd`, `/status`, …)
 * dispatch to one implementation — preventing future field-name drift like
 * the `status_emoji` vs `emoji` bug we just fixed.
 *
 * Functions take their own dependencies (router, api, etc.) so they can run
 * outside React. They never touch React state directly.
 */
import type { api as ApiClient } from './api';
import type { useRouter } from 'next/navigation';

type Api = typeof ApiClient;
type Router = ReturnType<typeof useRouter>;

/**
 * Module-level pubsub for cross-surface dialog opens. We initially used custom
 * DOM events on `document`, but React Strict Mode + Next dev's component
 * lifecycle would intermittently detach the listener (cleanup ran without a
 * matching re-mount), leaving the event unhandled. Module-level callbacks set
 * by `useEffect` are immune — even if cleanup nulls them, the next mount
 * re-assigns them, and the dispatch site does a noop when null.
 */
let openTaskQuickCreateFn: (() => void) | null = null;
let openCreateSpaceFn: (() => void) | null = null;

/**
 * Called by /tasks page's useEffect — registers the callback target.
 *
 * Note: returns a no-op cleanup. With React Strict Mode + Next dev hot
 * reload, the effect cleanup can run without a matching re-mount (we saw
 * this in audits — one UNMOUNT log with no follow-up MOUNT). Nulling on
 * cleanup would then leave the dispatcher pointing at nothing. Each new
 * register simply overwrites; the staleness window is one render.
 */
export function registerOpenTaskQuickCreate(fn: () => void): () => void {
  openTaskQuickCreateFn = fn;
  return () => {};
}

/** Same pattern as `registerOpenTaskQuickCreate` — see its note. */
export function registerOpenCreateSpace(fn: () => void): () => void {
  openCreateSpaceFn = fn;
  return () => {};
}

/**
 * Open the task quick-create dialog. If already on /tasks, fire the
 * registered callback directly. Otherwise, navigate to /tasks?new=1 and let
 * the page open the dialog from its URL handler (no race with mount).
 */
export function openTaskQuickCreate(router: Router, currentPath: string) {
  if (currentPath.startsWith('/tasks')) {
    openTaskQuickCreateFn?.();
  } else {
    router.push('/tasks?new=1');
  }
}

/** Open the new-space modal (sidebar registers on mount). */
export function openCreateSpace() {
  openCreateSpaceFn?.();
}

/**
 * Create a private daily-note and navigate to it. Returns true on success.
 */
export async function createNoteAndOpen(api: Api, router: Router, title = 'Untitled'): Promise<boolean> {
  const res = await api.post('/api/daily-notes', { title, content: '' });
  if (!res.ok) return false;
  const note = await res.json() as { id: string };
  router.push(`/notes?id=${note.id}`);
  return true;
}

/**
 * Toggle Do Not Disturb based on the user's current status. Mirrors the
 * branching in the chat /dnd command (`status_text === 'Do Not Disturb'`).
 * Caller passes the current status_text so this stays stateless.
 */
export async function toggleDnd(api: Api, currentStatusText: string | null): Promise<{ dndOn: boolean }> {
  const isDndNow = currentStatusText === 'Do Not Disturb';
  if (isDndNow) {
    await api.delete('/api/users/status');
    return { dndOn: false };
  }
  await api.patch('/api/users/dnd', { enabled: true });
  return { dndOn: true };
}

/**
 * Parse a "<emoji> <text>" string and PATCH the user's status. Mirrors the
 * chat /status command exactly so behavior matches both entry points.
 */
export async function setStatusFromArgs(api: Api, args: string): Promise<{ emoji: string; text: string }> {
  const trimmed = args.trim();
  const emojiMatch = trimmed.match(/^(\p{Emoji_Presentation}|\p{Emoji}️?)\s*(.*)/u);
  const emoji = emojiMatch?.[1] || '💬';
  const text = emojiMatch?.[2]?.trim() || trimmed || 'Busy';
  await api.patch('/api/users/status', { emoji, text });
  return { emoji, text };
}

/**
 * Parse a "<duration> <text>" string and POST a reminder. Uses the same
 * parseReminderTime helper as the chat /remind command.
 */
export async function createReminderFromArgs(
  api: Api,
  parseDuration: (input: string) => { ms: number; label: string } | null,
  args: string,
): Promise<{ ms: number; label: string; text: string }> {
  const trimmed = args.trim();
  const parts = trimmed.split(/\s+/);
  const timeStr = parts[0] || '20m';
  const text = parts.slice(1).join(' ') || 'Reminder';
  const parsed = parseDuration(timeStr);
  const ms = parsed?.ms || 20 * 60_000;
  const label = parsed?.label || 'in 20m';
  const remindAt = new Date(Date.now() + ms).toISOString();
  await api.post('/api/reminders', { content: text, remind_at: remindAt });
  return { ms, label, text };
}

/**
 * Find Defty (the platform agent) and open a DM. Defty has a fixed system
 * email — same lookup the sidebar uses to pin Defty at the top of DMs.
 */
const DEFTY_EMAIL = 'deft-agent@system.local';

type MemberSummary = { id: string; name?: string; email?: string; kind?: string };

async function fetchMembers(api: Pick<Api, 'get'>): Promise<MemberSummary[] | null> {
  const res = await api.get('/api/members');
  if (!res.ok) return null;
  const data = await res.json() as unknown;
  const list = Array.isArray(data) ? data : (data as { members?: unknown } | null)?.members;
  return Array.isArray(list) ? list as MemberSummary[] : null;
}

/**
 * Open (or reuse) a DM with one member and select it. Returns true only when
 * the DM space exists, is in the reloaded space list, and was selected. It never throws, and it does not need
 * the member to be in a cached list: the name comes from the caller, the
 * cache, or a fresh member read, in that order.
 */
export async function openDirectMessage({
  api,
  currentUserName,
  memberId,
  memberName,
  cachedMembers,
  reloadSpaces,
  selectSpace,
}: {
  api: Pick<Api, 'get' | 'post'>;
  currentUserName: string;
  memberId: string;
  memberName?: string;
  cachedMembers: ReadonlyArray<{ id: string; name: string }>;
  /** Reloads the space list; resolves to the loaded spaces, or null when the reload failed. */
  reloadSpaces: () => Promise<ReadonlyArray<{ id: string }> | null>;
  selectSpace: (spaceId: string) => void;
}): Promise<boolean> {
  try {
    let name = memberName?.trim() || cachedMembers.find((m) => m.id === memberId)?.name;
    if (!name) {
      const members = await fetchMembers(api);
      name = members?.find((m) => m.id === memberId)?.name;
    }
    if (!name) return false;
    // POST /api/spaces with type dm: the API returns the existing DM if one exists.
    const res = await api.post('/api/spaces', {
      name: `${currentUserName}, ${name}`,
      type: 'dm',
      user_ids: [memberId],
    });
    if (!res.ok) return false;
    const space = await res.json() as { id?: unknown } | null;
    if (!space || typeof space.id !== 'string' || !space.id) return false;
    // The chat page renders only a space that is in the loaded list, so
    // report success only once the reload succeeded and includes this DM.
    const spaces = await reloadSpaces();
    if (!spaces?.some((loaded) => loaded.id === space.id)) return false;
    selectSpace(space.id);
    return true;
  } catch {
    return false;
  }
}

/** Find Defty and open its DM. Returns true only when the DM actually opened. */
export async function openDeftyDm(
  api: Api,
  openDmWith: (memberId: string, memberName?: string) => Promise<boolean>,
): Promise<boolean> {
  try {
    const members = await fetchMembers(api);
    const defty = members?.find(m => m.email === DEFTY_EMAIL);
    if (!defty) return false;
    return (await openDmWith(defty.id, defty.name)) === true;
  } catch {
    return false;
  }
}
