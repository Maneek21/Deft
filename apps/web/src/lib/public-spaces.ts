/** Public spaces: what a workspace member can find and join (see GET /api/spaces/browse). */

export type BrowsableSpace = {
  id: string;
  name: string;
  description: string | null;
  topic: string | null;
  member_count: number;
  created_at: string;
  is_member: boolean;
};

export type MemberJoinedEvent = { space_id: string; user_id: string };

type SocketLike = {
  on(event: string, listener: (data: MemberJoinedEvent) => void): unknown;
  off(event: string, listener: (data: MemberJoinedEvent) => void): unknown;
};

/** Guests only see the spaces they are added to; agents are added by a member. */
export function canBrowsePublicSpaces(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin' || role === 'member';
}

export function browsePublicSpacesPath(query: string): string {
  const params = new URLSearchParams({ include_joined: '1', limit: '100' });
  const q = query.trim().slice(0, 100);
  if (q) params.set('q', q);
  return `/api/spaces/browse?${params.toString()}`;
}

export function joinPublicSpacePath(spaceId: string): string {
  return `/api/spaces/${encodeURIComponent(spaceId)}/join`;
}

/** Details of one space: a member may read a public space before joining it. */
export function publicSpaceDetailsPath(spaceId: string): string {
  return `/api/spaces/${encodeURIComponent(spaceId)}`;
}

/** Messages of a space for the read-only preview; `cursor` pages to older messages. */
export function previewMessagesPath(spaceId: string, cursor?: string | null): string {
  const base = `/api/messages/${encodeURIComponent(spaceId)}`;
  return cursor ? `${base}?cursor=${encodeURIComponent(cursor)}` : base;
}

/** Only a public, unarchived space is shown read-only to someone who has not joined it. */
export function canPreviewSpace(space: { type?: string | null; is_archived?: boolean | null } | null | undefined): boolean {
  return !!space && space.type === 'public' && space.is_archived !== true;
}

/**
 * What the chat page shows for the space named in the URL: the normal chat
 * when the viewer has joined it, the read-only preview when they have not,
 * and nothing when no space is named.
 */
export function chatViewFor(urlSpaceId: string | null, joinedSpaceIds: readonly string[], effectiveSpaceId: string | null): 'chat' | 'preview' | 'empty' {
  if (effectiveSpaceId && joinedSpaceIds.includes(effectiveSpaceId)) return 'chat';
  return urlSpaceId ? 'preview' : 'empty';
}

export function leaveSpacePath(spaceId: string): string {
  return `/api/spaces/${encodeURIComponent(spaceId)}/members/me`;
}

/** Calls `onJoined` for each `space:member_joined` the filter accepts; returns the unsubscribe. */
export function onMemberJoined(
  socket: SocketLike,
  filter: (event: MemberJoinedEvent) => boolean,
  onJoined: (event: MemberJoinedEvent) => void,
): () => void {
  const listener = (event: MemberJoinedEvent) => {
    if (event && typeof event.space_id === 'string' && typeof event.user_id === 'string' && filter(event)) onJoined(event);
  };
  socket.on('space:member_joined', listener);
  return () => { socket.off('space:member_joined', listener); };
}
