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
