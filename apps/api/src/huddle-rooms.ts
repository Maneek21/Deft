// In-memory huddle room state management

type Participant = {
  user_id: string;
  user_name: string;
  muted: boolean;
  socket_id: string;
};

type HuddleRoom = {
  id: string;
  space_id: string;
  org_id: string;
  created_by: string;
  participants: Map<string, Participant>;
  created_at: Date;
  grace_timer?: ReturnType<typeof setTimeout>;
};

const rooms = new Map<string, HuddleRoom>();

export function createRoom(id: string, spaceId: string, orgId: string, createdBy: string): HuddleRoom {
  const room: HuddleRoom = {
    id,
    space_id: spaceId,
    org_id: orgId,
    created_by: createdBy,
    participants: new Map(),
    created_at: new Date(),
  };
  rooms.set(id, room);
  return room;
}

export function getRoom(id: string): HuddleRoom | undefined {
  return rooms.get(id);
}

export function getRoomBySpace(spaceId: string): HuddleRoom | undefined {
  for (const room of rooms.values()) {
    if (room.space_id === spaceId) return room;
  }
  return undefined;
}

export function addParticipant(roomId: string, participant: Participant): boolean {
  const room = rooms.get(roomId);
  if (!room) return false;
  // Clear grace timer if room was about to close
  if (room.grace_timer) {
    clearTimeout(room.grace_timer);
    room.grace_timer = undefined;
  }
  room.participants.set(participant.user_id, participant);
  return true;
}

export function removeParticipant(roomId: string, userId: string): { empty: boolean; room?: HuddleRoom } {
  const room = rooms.get(roomId);
  if (!room) return { empty: true };
  room.participants.delete(userId);
  return { empty: room.participants.size === 0, room };
}

export function setMuted(roomId: string, userId: string, muted: boolean): void {
  const room = rooms.get(roomId);
  if (!room) return;
  const p = room.participants.get(userId);
  if (p) p.muted = muted;
}

export function destroyRoom(roomId: string): void {
  const room = rooms.get(roomId);
  if (room?.grace_timer) clearTimeout(room.grace_timer);
  rooms.delete(roomId);
}

export function setGraceTimer(roomId: string, callback: () => void, ms = 5000): void {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.grace_timer) clearTimeout(room.grace_timer);
  room.grace_timer = setTimeout(callback, ms);
}

export function getParticipantList(roomId: string): Participant[] {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.participants.values());
}

export function getActiveRooms(): { id: string; space_id: string; participant_count: number }[] {
  const result: { id: string; space_id: string; participant_count: number }[] = [];
  for (const room of rooms.values()) {
    result.push({ id: room.id, space_id: room.space_id, participant_count: room.participants.size });
  }
  return result;
}
