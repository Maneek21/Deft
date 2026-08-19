import { Server as SocketIOServer } from 'socket.io';
import type { Server as HTTPServer } from 'node:http';
import jwt from 'jsonwebtoken';
import { env } from './lib/env.js';
import { db } from './lib/db.js';
import { users, orgMembers, spaceMembers, spaces } from '@deft/db/schema';
import { eq, and, ne } from 'drizzle-orm';
import * as huddle from './huddle-rooms.js';
import { requireActiveOrgMembership } from './lib/org-membership.js';
import { createNotificationIfAllowed } from './lib/notification-policy.js';

export type SocketUser = {
  id: string;
  email: string;
  org_id: string;
  role?: 'owner' | 'admin' | 'member' | 'guest';
};
type HuddleEventName = 'huddle:create' | 'huddle:list' | 'huddle:join' | 'huddle:leave' | 'huddle:signal' | 'huddle:mute';
type HuddleErrorCode = 'INVALID_PAYLOAD' | 'FORBIDDEN' | 'ROOM_NOT_FOUND' | 'NOT_PARTICIPANT' | 'TARGET_NOT_FOUND' | 'ALREADY_IN_HUDDLE' | 'INTERNAL_ERROR';

export async function getHuddleSpaceAccess(spaceId: string, user: SocketUser) {
  const [access] = await db.select({
    space_id: spaces.id,
    space_name: spaces.name,
    user_name: users.name,
  })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaceMembers.space_id, spaces.id))
    .innerJoin(users, eq(spaceMembers.user_id, users.id))
    .innerJoin(orgMembers, and(
      eq(orgMembers.user_id, spaceMembers.user_id),
      eq(orgMembers.org_id, spaces.org_id),
    ))
    .where(and(
      eq(spaceMembers.space_id, spaceId),
      eq(spaceMembers.user_id, user.id),
      eq(spaces.org_id, user.org_id),
      eq(spaces.is_archived, false),
      eq(orgMembers.is_active, true),
    ))
    .limit(1);
  return access;
}

export async function getAccessibleHuddleSpaceIds(user: SocketUser): Promise<Set<string>> {
  const memberships = await db.select({ space_id: spaceMembers.space_id })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaceMembers.space_id, spaces.id))
    .innerJoin(orgMembers, and(
      eq(orgMembers.user_id, spaceMembers.user_id),
      eq(orgMembers.org_id, spaces.org_id),
    ))
    .where(and(
      eq(spaceMembers.user_id, user.id),
      eq(spaces.org_id, user.org_id),
      eq(spaces.is_archived, false),
      eq(orgMembers.is_active, true),
    ));
  return new Set(memberships.map((membership) => membership.space_id));
}

export async function getAuthorizedHuddleRecipientIds(
  spaceId: string,
  orgId: string,
  excludedUserId: string,
): Promise<string[]> {
  const recipients = await db.select({ user_id: spaceMembers.user_id })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaceMembers.space_id, spaces.id))
    .innerJoin(orgMembers, and(
      eq(orgMembers.user_id, spaceMembers.user_id),
      eq(orgMembers.org_id, orgId),
      eq(orgMembers.is_active, true),
    ))
    .where(and(
      eq(spaceMembers.space_id, spaceId),
      eq(spaces.org_id, orgId),
      eq(spaces.is_archived, false),
      ne(spaceMembers.user_id, excludedUserId),
    ));
  return recipients.map((recipient) => recipient.user_id);
}

function updateLastSeen(userId: string) {
  db.update(users).set({ last_seen_at: new Date() }).where(eq(users.id, userId)).catch(() => {});
}

let io: SocketIOServer | null = null;
let realtimeAccessGeneration = 0;

export function captureRealtimeAccessGeneration(): number {
  return realtimeAccessGeneration;
}

export function isRealtimeAccessGenerationCurrent(generation: number): boolean {
  return generation === realtimeAccessGeneration;
}

export function bumpRealtimeAccessGeneration(_scope: HuddleEvictionScope): number {
  realtimeAccessGeneration += 1;
  return realtimeAccessGeneration;
}

export type HuddleEvictionReason = 'space_membership_revoked' | 'org_membership_revoked' | 'space_archived';

export type HuddleEvictionScope =
  | {
      orgId: string;
      spaceId: string;
      userId: string;
      reason: 'space_membership_revoked';
    }
  | {
      orgId: string;
      spaceId: string;
      reason: 'space_archived';
    }
  | {
      orgId: string;
      userId: string;
      reason: 'org_membership_revoked' | 'org_role_changed';
    };

export type RealtimeRevocationServer = {
  in(room: string): {
    socketsLeave(room: string): void;
    disconnectSockets(close?: boolean): void;
  };
};

/**
 * Remove realtime access after the durable membership/archive mutation has
 * succeeded. This is deliberately independent of active huddle state: a user
 * who is not currently in a huddle must still stop receiving space/org events.
 */
export function revokeRealtimeAccess(
  scope: HuddleEvictionScope,
  server: RealtimeRevocationServer | null = io,
): void {
  if (!server) return;

  try {
    if (scope.reason === 'space_membership_revoked') {
      server
        .in(`org-user:${scope.orgId}:${scope.userId}`)
        .socketsLeave(`space:${scope.spaceId}`);
      return;
    }

    if (scope.reason === 'space_archived') {
      server.in(`space:${scope.spaceId}`).socketsLeave(`space:${scope.spaceId}`);
      return;
    }

    // A revoked org member or a member whose role changed must not retain rooms
    // granted under the old authorization. Reconnect re-resolves current role.
    server.in(`org-user:${scope.orgId}:${scope.userId}`).disconnectSockets(true);
  } catch (error) {
    // The access mutation has already committed. Realtime cleanup is best
    // effort and must not change the route's persistence/error semantics.
    console.error('Failed to revoke realtime socket access:', error);
  }
}

export async function evictActiveHuddleParticipants(scope: HuddleEvictionScope): Promise<number> {
  // This must happen before the first await and before the room scan. A stale
  // async authorization either mutates before this scan (and is evicted) or
  // observes the new generation and rolls itself back.
  bumpRealtimeAccessGeneration(scope);
  let evicted = 0;
  const spaceId = 'spaceId' in scope ? scope.spaceId : undefined;
  const userId = 'userId' in scope ? scope.userId : undefined;
  const roomIds = huddle.getRoomIdsForScope(scope.orgId, spaceId, userId);
  for (const roomId of roomIds) {
    try {
      const room = huddle.getRoom(roomId);
      if (!room) continue;
      const targetUserIds = userId
        ? [userId]
        : huddle.getParticipantList(roomId).map((participant) => participant.user_id);

      for (const targetUserId of targetUserIds) {
        const participantSocketId = huddle.getParticipantSocketId(roomId, targetUserId);
        if (!participantSocketId) continue;
        const removed = huddle.removeParticipant(roomId, targetUserId, participantSocketId);
        if (!removed.removed) continue;
        evicted += 1;

        const participantSocket = io?.sockets.sockets.get(participantSocketId);
        try {
          await participantSocket?.leave(`huddle:${roomId}`);
        } catch (error) {
          console.warn('Failed to remove revoked participant from socket room:', error);
        }

        io?.to(participantSocketId).emit('huddle:ended', {
          huddle_id: roomId,
          space_id: room.space_id,
          reason: scope.reason,
        });
        io?.to(`huddle:${roomId}`).emit('huddle:user_left', {
          huddle_id: roomId,
          user_id: targetUserId,
          participants: huddle.getParticipantList(roomId),
        });
      }

      const participants = huddle.getParticipantList(roomId);
      if (participants.length === 0) {
        huddle.destroyRoom(roomId);
        const ended = { huddle_id: roomId, space_id: room.space_id, reason: scope.reason };
        io?.to(`space:${room.space_id}`).emit('huddle:ended', ended);
        io?.to(`org:${room.org_id}`).emit('huddle:ended', ended);
      } else {
        io?.to(`space:${room.space_id}`).emit('huddle:updated', {
          huddle_id: roomId,
          space_id: room.space_id,
          participants,
        });
      }
    } catch (error) {
      // Revocation already succeeded in the database. Realtime cleanup must not
      // change the route's persistence/error semantics or abort other rooms.
      console.error('Failed to evict revoked huddle participant:', error);
    }
  }

  // Do this after huddle teardown so direct huddle:ended/user_left events can
  // be delivered before an org socket is disconnected or a space room emptied.
  revokeRealtimeAccess(scope);
  return evicted;
}

// Track online users: userId → Set of socket IDs (user can have multiple tabs)
const onlineUsers = new Map<string, Set<string>>();
// Track idle users
const idleUsers = new Set<string>();
// Track user org mapping for room broadcasts
const userOrgs = new Map<string, string>();

export function getIO(): SocketIOServer | null {
  return io;
}

export function emitToUser(userId: string, event: string, data: unknown): void {
  if (io) {
    io.to(`user:${userId}`).emit(event, data);
  }
}

function emitToOrgUser(orgId: string, userId: string, event: string, data: unknown): void {
  io?.to(`org-user:${orgId}:${userId}`).emit(event, data);
}

/** Get all currently online user IDs */
export function getOnlineUserIds(): string[] {
  return Array.from(onlineUsers.keys());
}

/** Get presence status for a user */
export function getUserStatus(userId: string): 'online' | 'idle' | 'offline' {
  if (idleUsers.has(userId)) return 'idle';
  if (onlineUsers.has(userId)) return 'online';
  return 'offline';
}

export function setupSocket(server: HTTPServer) {
  io = new SocketIOServer(server, {
    cors: {
      origin: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
      credentials: true,
    },
    pingInterval: 10000,
    pingTimeout: 5000,
  });

  // Auth middleware
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    try {
      const payload = jwt.verify(token, env.JWT_SECRET) as { id: string; email: string; org_id: string };
      const authorizationGeneration = captureRealtimeAccessGeneration();
      const membership = await requireActiveOrgMembership(payload.org_id, payload.id);
      if (!isRealtimeAccessGenerationCurrent(authorizationGeneration)) {
        return next(new Error('Workspace access changed; reconnect'));
      }
      (socket as any).user = { ...payload, role: membership.role };
      (socket as any).realtimeAccessGeneration = authorizationGeneration;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', async (socket) => {
    const user = (socket as any).user as SocketUser;
    const connectionGeneration = (socket as any).realtimeAccessGeneration as number;
    if (!socket.connected || !isRealtimeAccessGenerationCurrent(connectionGeneration)) {
      socket.disconnect(true);
      return;
    }

    try {
      const initialRooms = [
        `org:${user.org_id}`,
        `user:${user.id}`,
        `org-user:${user.org_id}:${user.id}`,
      ];
      if (user.role !== 'guest') initialRooms.push(`org-members:${user.org_id}`);
      await socket.join(initialRooms);
    } catch (error) {
      console.error('Failed to initialize socket rooms:', error);
      socket.disconnect(true);
      return;
    }
    if (!socket.connected || !isRealtimeAccessGenerationCurrent(connectionGeneration)) {
      socket.disconnect(true);
      return;
    }

    const emitHuddleError = (event: HuddleEventName, code: HuddleErrorCode, message: string) => {
      socket.emit('huddle:error', { event, code, message });
    };

    // Track this socket
    if (!onlineUsers.has(user.id)) {
      onlineUsers.set(user.id, new Set());
    }
    onlineUsers.get(user.id)!.add(socket.id);
    userOrgs.set(user.id, user.org_id);
    idleUsers.delete(user.id);

    // Update last_seen_at on connect
    updateLastSeen(user.id);

    // Broadcast online to org (only if this is the first socket for this user)
    if (onlineUsers.get(user.id)!.size === 1) {
      socket.to(`org:${user.org_id}`).emit('presence:update', {
        user_id: user.id,
        status: 'online',
      });
    }

    // Send current online users to the newly connected client
    const presenceList: { user_id: string; status: 'online' | 'idle' }[] = [];
    for (const [uid] of onlineUsers) {
      if (uid !== user.id) {
        presenceList.push({ user_id: uid, status: idleUsers.has(uid) ? 'idle' : 'online' });
      }
    }
    socket.emit('presence:init', presenceList);

    // Space rooms
    socket.on('space:join', async (spaceId: string) => {
      if (typeof spaceId !== 'string' || spaceId.length === 0 || spaceId.length > 128) return;
      const authorizationGeneration = captureRealtimeAccessGeneration();
      const access = await getHuddleSpaceAccess(spaceId, user).catch(() => undefined);
      if (!access || !isRealtimeAccessGenerationCurrent(authorizationGeneration)) return;
      try {
        await socket.join(`space:${spaceId}`);
      } catch {
        return;
      }
      if (!isRealtimeAccessGenerationCurrent(authorizationGeneration)) {
        try {
          await socket.leave(`space:${spaceId}`);
        } catch {}
        return;
      }
      const room = huddle.getRoomBySpace(spaceId, user.org_id);
      if (!room) return;
      const participants = huddle.getParticipantList(room.id);
      if (participants.length === 0) return;
      socket.emit('huddle:started', {
        huddle_id: room.id,
        space_id: room.space_id,
        created_by: room.created_by,
        participants,
      });
    });

    socket.on('space:leave', (spaceId: string) => {
      socket.leave(`space:${spaceId}`);
    });

    // Typing
    socket.on('typing:start', (data: { space_id: string; user_name: string }) => {
      socket.to(`space:${data.space_id}`).emit('typing:start', {
        user_id: user.id,
        user_name: data.user_name,
        space_id: data.space_id,
      });
    });

    socket.on('typing:stop', (data: { space_id: string }) => {
      socket.to(`space:${data.space_id}`).emit('typing:stop', {
        user_id: user.id,
        space_id: data.space_id,
      });
    });

    // Idle / active
    socket.on('presence:idle', () => {
      if (!idleUsers.has(user.id)) {
        idleUsers.add(user.id);
        socket.to(`org:${user.org_id}`).emit('presence:update', {
          user_id: user.id,
          status: 'idle',
        });
      }
    });

    socket.on('presence:active', () => {
      updateLastSeen(user.id);
      if (idleUsers.has(user.id)) {
        idleUsers.delete(user.id);
        socket.to(`org:${user.org_id}`).emit('presence:update', {
          user_id: user.id,
          status: 'online',
        });
      }
    });

    // ── Huddle signaling ──

    socket.on('huddle:list', async (rawData: unknown) => {
      const parsed = huddle.parseListPayload(rawData);
      if (!parsed.success) {
        emitHuddleError('huddle:list', 'INVALID_PAYLOAD', 'Invalid huddle list request');
        return;
      }
      try {
        const authorizationGeneration = captureRealtimeAccessGeneration();
        const allowedSpaceIds = await getAccessibleHuddleSpaceIds(user);
        if (!isRealtimeAccessGenerationCurrent(authorizationGeneration)) {
          emitHuddleError('huddle:list', 'FORBIDDEN', 'Workspace access changed; retry the request');
          return;
        }
        socket.emit('huddle:snapshot', {
          huddles: huddle.getActiveRoomSnapshots(user.org_id, allowedSpaceIds),
        });
      } catch (error) {
        console.error('Failed to list huddles:', error);
        emitHuddleError('huddle:list', 'INTERNAL_ERROR', 'Unable to list active huddles');
      }
    });

    socket.on('huddle:create', async (rawData: unknown) => {
      const parsed = huddle.parseCreatePayload(rawData);
      if (!parsed.success) {
        emitHuddleError('huddle:create', 'INVALID_PAYLOAD', 'Invalid huddle create request');
        return;
      }
      const data = parsed.data;
      const authorizationGeneration = captureRealtimeAccessGeneration();
      let access: Awaited<ReturnType<typeof getHuddleSpaceAccess>>;
      try {
        access = await getHuddleSpaceAccess(data.space_id, user);
      } catch (error) {
        console.error('Failed to authorize huddle creation:', error);
        emitHuddleError('huddle:create', 'INTERNAL_ERROR', 'Unable to start huddle');
        return;
      }
      if (!isRealtimeAccessGenerationCurrent(authorizationGeneration)) {
        emitHuddleError('huddle:create', 'FORBIDDEN', 'Workspace access changed; retry the request');
        return;
      }
      if (!access) {
        emitHuddleError('huddle:create', 'FORBIDDEN', 'You are not a member of this space');
        return;
      }
      // Check if there's already an active huddle in this space
      let room = huddle.getRoomBySpace(data.space_id, user.org_id);
      const otherRoom = huddle.getConflictingRoomId(user.id, user.org_id, room?.id);
      if (otherRoom) {
        emitHuddleError('huddle:create', 'ALREADY_IN_HUDDLE', 'Leave your current huddle before starting another');
        return;
      }
      if (room) {
        if (huddle.getParticipantList(room.id).length === 0) {
          // Room is empty (grace period) — destroy it and create fresh
          huddle.destroyRoom(room.id);
          io!.to(`space:${room.space_id}`).emit('huddle:ended', { huddle_id: room.id, space_id: room.space_id });
          io!.to(`org:${room.org_id}`).emit('huddle:ended', { huddle_id: room.id, space_id: room.space_id });
        } else {
          // Room has active participants — join it
          socket.emit('huddle:exists', { huddle_id: room.id });
          return;
        }
      }
      const id = crypto.randomUUID();
      const creatorName = access.user_name || user.email;
      const reservation = huddle.reserveRoom(id, data.space_id, user.org_id, user.id);
      if (!reservation.created) {
        socket.emit('huddle:exists', { huddle_id: reservation.room.id });
        return;
      }
      room = reservation.room;
      const participantAdded = huddle.addParticipant(id, {
        user_id: user.id,
        user_name: creatorName,
        muted: false,
        socket_id: socket.id,
      });
      if (!participantAdded) {
        huddle.destroyRoom(id);
        emitHuddleError('huddle:create', 'INTERNAL_ERROR', 'Unable to start huddle');
        return;
      }
      const rollbackReservation = () => {
        const removed = huddle.removeParticipant(id, user.id, socket.id);
        if (removed.empty) huddle.destroyRoom(id);
      };
      try {
        await socket.join(`huddle:${id}`);
      } catch (error) {
        rollbackReservation();
        console.error('Failed to join newly created huddle socket room:', error);
        emitHuddleError('huddle:create', 'INTERNAL_ERROR', 'Unable to start huddle');
        return;
      }
      if (!isRealtimeAccessGenerationCurrent(authorizationGeneration)) {
        rollbackReservation();
        try {
          await socket.leave(`huddle:${id}`);
        } catch {}
        emitHuddleError('huddle:create', 'FORBIDDEN', 'Workspace access changed; retry the request');
        return;
      }
      // Broadcast to the space that a huddle started
      io!.to(`space:${data.space_id}`).emit('huddle:started', {
        huddle_id: id,
        space_id: data.space_id,
        created_by: user.id,
        participants: huddle.getParticipantList(id),
      });
      socket.emit('huddle:joined', { huddle_id: id, participants: huddle.getParticipantList(id) });

      // Propagate room state to every authorized member. Notification policy
      // controls attention/ring delivery, not discovery of the live room.
      (async () => {
        try {
          const fanoutGeneration = captureRealtimeAccessGeneration();
          const spaceName = access.space_name;
          const recipientIds = await getAuthorizedHuddleRecipientIds(data.space_id, user.org_id, user.id);
          if (!isRealtimeAccessGenerationCurrent(fanoutGeneration) || huddle.getRoom(id) !== room) return;
          const participants = huddle.getParticipantList(id);

          for (const recipientId of recipientIds) {
            if (!isRealtimeAccessGenerationCurrent(fanoutGeneration) || huddle.getRoom(id) !== room) return;
            emitToOrgUser(user.org_id, recipientId, 'huddle:started', {
              huddle_id: id,
              space_id: data.space_id,
              created_by: user.id,
              participants,
            });
            const notification = await createNotificationIfAllowed({
              org_id: user.org_id,
              user_id: recipientId,
              type: 'huddle_started',
              title: `${creatorName} started a huddle`,
              body: `#${spaceName}`,
              link: `/chat?space=${data.space_id}`,
              metadata: { huddle_id: id, space_id: data.space_id },
            }, {
              channel: 'chat',
              spaceId: data.space_id,
              isMention: false,
              respectDnd: true,
            }).catch(() => null);
            if (!isRealtimeAccessGenerationCurrent(fanoutGeneration) || huddle.getRoom(id) !== room) return;
            if (!notification) continue;

            emitToOrgUser(user.org_id, recipientId, 'huddle:ring', {
              huddle_id: id,
              space_id: data.space_id,
              space_name: spaceName,
              created_by: user.id,
              created_by_name: creatorName,
              participants,
            });

            emitToOrgUser(user.org_id, recipientId, 'notification:new', notification);
          }
        } catch (err) {
          console.error('Failed to send huddle rings:', err);
        }
      })();
    });

    socket.on('huddle:join', async (rawData: unknown) => {
      const parsed = huddle.parseRoomPayload(rawData);
      if (!parsed.success) {
        emitHuddleError('huddle:join', 'INVALID_PAYLOAD', 'Invalid huddle join request');
        return;
      }
      const data = parsed.data;
      const room = huddle.getRoom(data.huddle_id);
      if (!room || room.org_id !== user.org_id) {
        emitHuddleError('huddle:join', 'ROOM_NOT_FOUND', 'Huddle not found');
        return;
      }
      const authorizationGeneration = captureRealtimeAccessGeneration();
      let access: Awaited<ReturnType<typeof getHuddleSpaceAccess>>;
      try {
        access = await getHuddleSpaceAccess(room.space_id, user);
      } catch (error) {
        console.error('Failed to authorize huddle join:', error);
        emitHuddleError('huddle:join', 'INTERNAL_ERROR', 'Unable to join huddle');
        return;
      }
      if (!isRealtimeAccessGenerationCurrent(authorizationGeneration)) {
        emitHuddleError('huddle:join', 'FORBIDDEN', 'Workspace access changed; retry the request');
        return;
      }
      if (!access) {
        emitHuddleError('huddle:join', 'FORBIDDEN', 'You are not a member of this space');
        return;
      }
      const currentRoom = huddle.getRoom(data.huddle_id);
      if (!currentRoom || currentRoom !== room || currentRoom.org_id !== user.org_id) {
        emitHuddleError('huddle:join', 'ROOM_NOT_FOUND', 'Huddle no longer exists');
        return;
      }
      const otherRoom = huddle.getConflictingRoomId(user.id, user.org_id, data.huddle_id);
      if (otherRoom) {
        emitHuddleError('huddle:join', 'ALREADY_IN_HUDDLE', 'Leave your current huddle before joining another');
        return;
      }
      if (huddle.isParticipantOnDifferentSocket(data.huddle_id, user.id, socket.id)) {
        emitHuddleError('huddle:join', 'ALREADY_IN_HUDDLE', 'This huddle is already active in another tab');
        return;
      }

      try {
        await socket.join(`huddle:${data.huddle_id}`);
      } catch (error) {
        console.error('Failed to join huddle socket room:', error);
        emitHuddleError('huddle:join', 'INTERNAL_ERROR', 'Unable to join huddle');
        return;
      }

      const roomAfterJoin = huddle.getRoom(data.huddle_id);
      const conflictingRoomAfterJoin = huddle.getConflictingRoomId(user.id, user.org_id, data.huddle_id);
      const joinedElsewhereAfterJoin = huddle.isParticipantOnDifferentSocket(data.huddle_id, user.id, socket.id);
      if (
        !isRealtimeAccessGenerationCurrent(authorizationGeneration)
        || !roomAfterJoin
        || roomAfterJoin !== room
        || conflictingRoomAfterJoin
        || joinedElsewhereAfterJoin
      ) {
        try {
          await socket.leave(`huddle:${data.huddle_id}`);
        } catch {}
        if (!isRealtimeAccessGenerationCurrent(authorizationGeneration)) {
          emitHuddleError('huddle:join', 'FORBIDDEN', 'Workspace access changed; retry the request');
        } else if (conflictingRoomAfterJoin || joinedElsewhereAfterJoin) {
          emitHuddleError('huddle:join', 'ALREADY_IN_HUDDLE', 'Huddle state changed; retry the request');
        } else {
          emitHuddleError('huddle:join', 'ROOM_NOT_FOUND', 'Huddle no longer exists');
        }
        return;
      }

      const alreadyJoinedOnThisSocket = huddle.isParticipant(data.huddle_id, user.id, socket.id);
      if (alreadyJoinedOnThisSocket) {
        socket.emit('huddle:joined', {
          huddle_id: data.huddle_id,
          participants: huddle.getParticipantList(data.huddle_id),
        });
        return;
      }
      const added = huddle.addParticipant(data.huddle_id, {
        user_id: user.id,
        user_name: access.user_name || user.email,
        muted: false,
        socket_id: socket.id,
      });
      if (!added) {
        try {
          await socket.leave(`huddle:${data.huddle_id}`);
        } catch {}
        emitHuddleError('huddle:join', 'ROOM_NOT_FOUND', 'Huddle no longer exists');
        return;
      }
      const participants = huddle.getParticipantList(data.huddle_id);
      socket.to(`huddle:${data.huddle_id}`).emit('huddle:user_joined', {
        huddle_id: data.huddle_id,
        user_id: user.id,
        participants,
      });
      io!.to(`space:${room.space_id}`).emit('huddle:updated', {
        huddle_id: data.huddle_id,
        space_id: room.space_id,
        participants,
      });
      socket.emit('huddle:joined', { huddle_id: data.huddle_id, participants });
    });

    socket.on('huddle:leave', (rawData: unknown) => {
      const parsed = huddle.parseRoomPayload(rawData);
      if (!parsed.success) {
        emitHuddleError('huddle:leave', 'INVALID_PAYLOAD', 'Invalid huddle leave request');
        return;
      }
      const data = parsed.data;
      const existingRoom = huddle.getRoom(data.huddle_id);
      if (!existingRoom || existingRoom.org_id !== user.org_id) {
        emitHuddleError('huddle:leave', 'ROOM_NOT_FOUND', 'Huddle not found');
        return;
      }
      if (!huddle.isParticipant(data.huddle_id, user.id, socket.id)) {
        emitHuddleError('huddle:leave', 'NOT_PARTICIPANT', 'You are not an active participant in this huddle');
        return;
      }
      const { empty, room } = huddle.removeParticipant(data.huddle_id, user.id, socket.id);
      socket.leave(`huddle:${data.huddle_id}`);
      if (empty && room) {
        // Start 30s grace period before destroying
        huddle.setGraceTimer(data.huddle_id, () => {
          const orgId = room.org_id;
          const spaceId = room.space_id;
          const hid = data.huddle_id;
          huddle.destroyRoom(hid);
          io!.to(`space:${spaceId}`).emit('huddle:ended', { huddle_id: hid, space_id: spaceId });
          io!.to(`org:${orgId}`).emit('huddle:ended', { huddle_id: hid, space_id: spaceId });
        });
      }
      socket.to(`huddle:${data.huddle_id}`).emit('huddle:user_left', {
        huddle_id: data.huddle_id,
        user_id: user.id,
        participants: huddle.getParticipantList(data.huddle_id),
      });
      if (room) {
        io!.to(`space:${room.space_id}`).emit('huddle:updated', {
          huddle_id: data.huddle_id,
          space_id: room.space_id,
          participants: huddle.getParticipantList(data.huddle_id),
        });
      }
    });

    socket.on('huddle:signal', (rawData: unknown) => {
      const parsed = huddle.parseSignalPayload(rawData);
      if (!parsed.success) {
        emitHuddleError('huddle:signal', 'INVALID_PAYLOAD', 'Invalid huddle signal request');
        return;
      }
      const data = parsed.data;
      const room = huddle.getRoom(data.huddle_id);
      if (!room || room.org_id !== user.org_id) {
        emitHuddleError('huddle:signal', 'ROOM_NOT_FOUND', 'Huddle not found');
        return;
      }
      if (!huddle.isParticipant(data.huddle_id, user.id, socket.id)) {
        emitHuddleError('huddle:signal', 'NOT_PARTICIPANT', 'You are not an active participant in this huddle');
        return;
      }
      const targetSocketId = huddle.getParticipantSocketId(data.huddle_id, data.target_user_id);
      if (!targetSocketId) {
        emitHuddleError('huddle:signal', 'TARGET_NOT_FOUND', 'Target participant not found');
        return;
      }
      io!.to(targetSocketId).emit('huddle:signal', {
        huddle_id: data.huddle_id,
        from_user_id: user.id,
        signal_data: data.signal_data,
      });
    });

    socket.on('huddle:mute', (rawData: unknown) => {
      const parsed = huddle.parseMutePayload(rawData);
      if (!parsed.success) {
        emitHuddleError('huddle:mute', 'INVALID_PAYLOAD', 'Invalid huddle mute request');
        return;
      }
      const data = parsed.data;
      const room = huddle.getRoom(data.huddle_id);
      if (!room || room.org_id !== user.org_id) {
        emitHuddleError('huddle:mute', 'ROOM_NOT_FOUND', 'Huddle not found');
        return;
      }
      if (!huddle.setMuted(data.huddle_id, user.id, socket.id, data.muted)) {
        emitHuddleError('huddle:mute', 'NOT_PARTICIPANT', 'You are not an active participant in this huddle');
        return;
      }
      socket.to(`huddle:${data.huddle_id}`).emit('huddle:mute_changed', {
        huddle_id: data.huddle_id,
        user_id: user.id,
        muted: data.muted,
      });
    });

    // Disconnect
    socket.on('disconnect', () => {
      // Auto-leave any huddle the user was in
      for (const roomId of huddle.getRoomIdsForSocket(socket.id)) {
        const { removed, empty, room } = huddle.removeParticipant(roomId, user.id, socket.id);
        if (removed && room) {
          socket.to(`huddle:${roomId}`).emit('huddle:user_left', {
            huddle_id: roomId, user_id: user.id, participants: huddle.getParticipantList(roomId),
          });
          io!.to(`space:${room.space_id}`).emit('huddle:updated', {
            huddle_id: roomId,
            space_id: room.space_id,
            participants: huddle.getParticipantList(roomId),
          });
          if (empty) {
            huddle.setGraceTimer(roomId, () => {
              const orgId = room.org_id;
              const spaceId = room.space_id;
              const hid = roomId;
              huddle.destroyRoom(hid);
              io!.to(`space:${spaceId}`).emit('huddle:ended', { huddle_id: hid, space_id: spaceId });
              io!.to(`org:${orgId}`).emit('huddle:ended', { huddle_id: hid, space_id: spaceId });
            });
          }
        }
      }

      const sockets = onlineUsers.get(user.id);
      if (sockets) {
        sockets.delete(socket.id);
        // Only mark offline if ALL tabs/sockets are closed
        if (sockets.size === 0) {
          onlineUsers.delete(user.id);
          idleUsers.delete(user.id);
          updateLastSeen(user.id);
          socket.to(`org:${user.org_id}`).emit('presence:update', {
            user_id: user.id,
            status: 'offline',
          });
        }
      }
    });
  });

  return io;
}
