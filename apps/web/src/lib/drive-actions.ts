// Reads and writes the Drive screens make. `api` returns non-OK responses
// instead of throwing, so every write goes through driveWrite, which turns a
// refusal into a message the person can act on and a transport failure into a
// plain one. Nothing here shows an id: hidden names come back null (rule C4).
import { useSWRConfig } from 'swr';
import { api } from '@/lib/api';
import type { DriveListItem } from '@/lib/drive-tree';

export const DRIVES_KEY = '/api/drives';
export const WITHOUT_MANAGER_KEY = '/api/drives/without-manager';
export const driveKey = (driveId: string) => `/api/drives/${driveId}`;
export const driveTreeKey = (driveId: string) => `/api/drives/${driveId}/tree`;
export const driveTrashKey = (driveId: string) => `/api/drives/${driveId}/trash`;
export const driveMembersKey = (driveId: string) => `/api/drives/${driveId}/members`;

/** Everything a member or access change can make stale: the sidebar's list, the drive, its tree, trash and members, and the unmanaged list. */
export const driveKeys = (driveId: string) => [
  DRIVES_KEY, driveKey(driveId), driveTreeKey(driveId), driveTrashKey(driveId), driveMembersKey(driveId), WITHOUT_MANAGER_KEY,
];

/** Revalidates everything an access change can make stale (driveKeys). */
export function useRefreshDrive(driveId: string) {
  const { mutate } = useSWRConfig();
  return () => Promise.all(driveKeys(driveId).map((key) => mutate(key)));
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** 403 and 404 both mean the drive is no longer (or never was) the caller's to see. */
export const isNoAccess = (error: unknown) => error instanceof HttpError && (error.status === 403 || error.status === 404);

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === 'string' && body.error.trim() ? body.error : fallback;
}

export async function fetchJson<T>(path: string): Promise<T> {
  const res = await api.get(path);
  if (!res.ok) throw new HttpError(res.status, await errorMessage(res, `Request failed (${res.status})`));
  return res.json() as Promise<T>;
}

export type WriteOutcome<T = unknown> = { ok: true; body: T } | { ok: false; status: number | null; message: string };

export async function driveWrite<T = unknown>(request: () => Promise<Response>, fallback: string): Promise<WriteOutcome<T>> {
  try {
    const res = await request();
    if (!res.ok) return { ok: false, status: res.status, message: await errorMessage(res, fallback) };
    return { ok: true, body: await res.json().catch(() => ({})) as T };
  } catch {
    return { ok: false, status: null, message: 'Could not reach the server. Check your connection and try again.' };
  }
}

export type DriveClient = Pick<typeof api, 'post' | 'patch' | 'delete'>;
export type MemberRole = 'full' | 'edit' | 'comment' | 'view';

export const changeMemberRole = (client: DriveClient, driveId: string, memberId: string, role: MemberRole) =>
  driveWrite(() => client.patch(`${driveMembersKey(driveId)}/${memberId}`, { role }), 'Could not change that role');

export const removeMember = (client: DriveClient, driveId: string, memberId: string) =>
  driveWrite(() => client.delete(`${driveMembersKey(driveId)}/${memberId}`), 'Could not remove that member');

/** Every person has a My drive; when the list holds none of the caller's own, this makes it (idempotent on the server). */
export async function ensureMyDrive(drives: DriveListItem[], client: DriveClient): Promise<WriteOutcome | null> {
  if (drives.some((d) => d.is_mine && !d.frozen)) return null;
  return driveWrite(() => client.post('/api/drives/mine'), 'Could not open your drive');
}

/** What the caller's role on a drive lets the page show. */
export function pageAccess(role: MemberRole | null): { canEdit: boolean; canManage: boolean } {
  return { canEdit: role === 'edit' || role === 'full', canManage: role === 'full' };
}
