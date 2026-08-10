// In-memory huddle room state management and untrusted socket payload parsing.

import { z } from 'zod';

const identifierSchema = z.string().trim().min(1).max(128);
const huddleIdSchema = z.string().uuid();
const MAX_SIGNAL_BYTES = 64 * 1024;

function isBoundedSignal(value: unknown): boolean {
  try {
    const encoded = JSON.stringify(value);
    return encoded !== undefined && Buffer.byteLength(encoded, 'utf8') <= MAX_SIGNAL_BYTES;
  } catch {
    return false;
  }
}

const createPayloadSchema = z.object({ space_id: identifierSchema }).strict();
const listPayloadSchema = z.object({}).strict();
const roomPayloadSchema = z.object({ huddle_id: huddleIdSchema }).strict();
const signalPayloadSchema = z.object({
  huddle_id: huddleIdSchema,
  target_user_id: identifierSchema,
  signal_data: z.record(z.string(), z.unknown())
    .refine(isBoundedSignal, `signal_data must be valid JSON smaller than ${MAX_SIGNAL_BYTES} bytes`),
}).strict();
const mutePayloadSchema = z.object({
  huddle_id: huddleIdSchema,
  muted: z.boolean(),
}).strict();

export type HuddleCreatePayload = z.infer<typeof createPayloadSchema>;
export type HuddleListPayload = z.infer<typeof listPayloadSchema>;
export type HuddleRoomPayload = z.infer<typeof roomPayloadSchema>;
export type HuddleSignalPayload = z.infer<typeof signalPayloadSchema>;
export type HuddleMutePayload = z.infer<typeof mutePayloadSchema>;

type PayloadResult<T> =
  | { success: true; data: T }
  | { success: false };

function parsePayload<T>(schema: z.ZodType<T>, value: unknown): PayloadResult<T> {
  const parsed = schema.safeParse(value);
  return parsed.success ? { success: true, data: parsed.data } : { success: false };
}

export function parseCreatePayload(value: unknown): PayloadResult<HuddleCreatePayload> {
  return parsePayload(createPayloadSchema, value);
}

export function parseListPayload(value: unknown): PayloadResult<HuddleListPayload> {
  return parsePayload(listPayloadSchema, value ?? {});
}

export function parseRoomPayload(value: unknown): PayloadResult<HuddleRoomPayload> {
  return parsePayload(roomPayloadSchema, value);
}

export function parseSignalPayload(value: unknown): PayloadResult<HuddleSignalPayload> {
  return parsePayload(signalPayloadSchema, value);
}

export function parseMutePayload(value: unknown): PayloadResult<HuddleMutePayload> {
  return parsePayload(mutePayloadSchema, value);
}

export type PublicParticipant = {
  user_id: string;
  user_name: string;
  muted: boolean;
};

type Participant = PublicParticipant & {
  socket_id: string;
};

export type HuddleRoom = {
  id: string;
  space_id: string;
  org_id: string;
  created_by: string;
  participants: Map<string, Participant>;
  created_at: Date;
  grace_timer?: ReturnType<typeof setTimeout>;
};

export type ActiveRoomSnapshot = {
  huddle_id: string;
  space_id: string;
  created_by: string;
  participants: PublicParticipant[];
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

export function reserveRoom(
  id: string,
  spaceId: string,
  orgId: string,
  createdBy: string,
): { room: HuddleRoom; created: boolean } {
  const existing = getRoomBySpace(spaceId, orgId);
  if (existing) return { room: existing, created: false };
  return { room: createRoom(id, spaceId, orgId, createdBy), created: true };
}

export function getRoom(id: string): HuddleRoom | undefined {
  return rooms.get(id);
}

export function getRoomBySpace(spaceId: string, orgId: string): HuddleRoom | undefined {
  for (const room of rooms.values()) {
    if (room.space_id === spaceId && room.org_id === orgId) return room;
  }
  return undefined;
}

export function addParticipant(roomId: string, participant: Participant): boolean {
  const room = rooms.get(roomId);
  if (!room) return false;
  const existing = room.participants.get(participant.user_id);
  if (existing && existing.socket_id !== participant.socket_id) return false;
  // Clear grace timer if room was about to close
  if (room.grace_timer) {
    clearTimeout(room.grace_timer);
    room.grace_timer = undefined;
  }
  room.participants.set(participant.user_id, participant);
  return true;
}

export function isParticipant(roomId: string, userId: string, socketId?: string): boolean {
  const participant = rooms.get(roomId)?.participants.get(userId);
  return Boolean(participant && (!socketId || participant.socket_id === socketId));
}

export function getParticipantSocketId(roomId: string, userId: string): string | undefined {
  return rooms.get(roomId)?.participants.get(userId)?.socket_id;
}

export function isParticipantOnDifferentSocket(roomId: string, userId: string, socketId: string): boolean {
  const participantSocketId = getParticipantSocketId(roomId, userId);
  return Boolean(participantSocketId && participantSocketId !== socketId);
}

export function removeParticipant(
  roomId: string,
  userId: string,
  socketId?: string,
): { removed: boolean; empty: boolean; room?: HuddleRoom } {
  const room = rooms.get(roomId);
  if (!room) return { removed: false, empty: true };
  const participant = room.participants.get(userId);
  if (!participant || (socketId && participant.socket_id !== socketId)) {
    return { removed: false, empty: room.participants.size === 0, room };
  }
  room.participants.delete(userId);
  return { removed: true, empty: room.participants.size === 0, room };
}

export function setMuted(roomId: string, userId: string, socketId: string, muted: boolean): boolean {
  const participant = rooms.get(roomId)?.participants.get(userId);
  if (!participant || participant.socket_id !== socketId) return false;
  participant.muted = muted;
  return true;
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

export function getParticipantList(roomId: string): PublicParticipant[] {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.participants.values(), ({ user_id, user_name, muted }) => ({
    user_id,
    user_name,
    muted,
  })).sort((left, right) => left.user_id.localeCompare(right.user_id));
}

export function getActiveRoomSnapshots(orgId: string, allowedSpaceIds: ReadonlySet<string>): ActiveRoomSnapshot[] {
  const snapshots: ActiveRoomSnapshot[] = [];
  for (const room of rooms.values()) {
    if (room.org_id !== orgId || !allowedSpaceIds.has(room.space_id) || room.participants.size === 0) continue;
    snapshots.push({
      huddle_id: room.id,
      space_id: room.space_id,
      created_by: room.created_by,
      participants: getParticipantList(room.id),
    });
  }
  return snapshots.sort((left, right) => left.space_id.localeCompare(right.space_id));
}

export function getRoomIdsForSocket(socketId: string): string[] {
  const roomIds: string[] = [];
  for (const room of rooms.values()) {
    if (Array.from(room.participants.values()).some((participant) => participant.socket_id === socketId)) {
      roomIds.push(room.id);
    }
  }
  return roomIds;
}

export function getRoomIdsForUser(userId: string, orgId: string): string[] {
  const roomIds: string[] = [];
  for (const room of rooms.values()) {
    if (room.org_id === orgId && room.participants.has(userId)) roomIds.push(room.id);
  }
  return roomIds;
}

export function getRoomIdsForScope(orgId: string, spaceId?: string, userId?: string): string[] {
  const roomIds: string[] = [];
  for (const room of rooms.values()) {
    if (room.org_id !== orgId) continue;
    if (spaceId && room.space_id !== spaceId) continue;
    if (userId && !room.participants.has(userId)) continue;
    roomIds.push(room.id);
  }
  return roomIds;
}

export function getConflictingRoomId(userId: string, orgId: string, allowedRoomId?: string): string | undefined {
  return getRoomIdsForUser(userId, orgId).find((roomId) => roomId !== allowedRoomId);
}
