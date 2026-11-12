import { Server as SocketIOServer } from 'socket.io';
import type { Server as HTTPServer } from 'node:http';
import { verifyWebAccess, webSessionEvents } from './lib/web-sessions.js';
import { db } from './lib/db.js';
import { users, orgMembers, spaceMembers, spaces } from '@deft/db/schema';
import { eq, and, ne } from 'drizzle-orm';
import * as huddle from './huddle-rooms.js';
import { requireActiveOrgMembership } from './lib/org-membership.js';
import { createNotificationIfAllowed } from './lib/notification-policy.js';
import { isOrgTaskEvent, orgTaskEventPayload, type OrgTaskEvent, type OrgTaskEventPayload } from './lib/task-realtime.js';

export type SocketUser = {
  id: string;
  email: string;
  org_id: string;
  sid?: string;
  exp?: number;
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

// Presence is tracked per (org, user) from the sockets actually authenticated
// for that org: orgId → userId → socket IDs (a user can have several tabs).
// A person who belongs to orgs A and B but is only connected to B is offline
// for A, so presence never reveals activity in another org.
const onlineUsers = new Map<string, Map<string, Set<string>>>();
// orgId → idle user IDs
const idleUsers = new Map<string, Set<string>>();

function idleSet(orgId: string): Set<string> {
  let set = idleUsers.get(orgId);
  if (!set) {
    set = new Set();
    idleUsers.set(orgId, set);
  }
  return set;
}

function clearIdle(orgId: string, userId: string): void {
  const set = idleUsers.get(orgId);
  if (!set) return;
  set.delete(userId);
  if (set.size === 0) idleUsers.delete(orgId);
}

export function getIO(): SocketIOServer | null {
  return io;
}

/** Emit an identifier-only task event to every member of `orgId`. */
export function emitOrgTaskEvent(orgId: string, event: OrgTaskEvent, payload: OrgTaskEventPayload): void {
  try {
    io?.to(`org:${orgId}`).emit(event, orgTaskEventPayload(event, payload));
  } catch {
    // Realtime delivery is best-effort; clients also reload on navigation.
  }
}

type BroadcastPacket = { data?: unknown[] };
type BroadcastOptions = { rooms?: Set<string> };
type BroadcastingAdapter = {
  broadcast(packet: BroadcastPacket, opts: BroadcastOptions): void;
  broadcastWithAck(packet: BroadcastPacket, opts: BroadcastOptions, ...rest: unknown[]): void;
};

/**
 * Task events addressed to an org room (or to every socket) reach every
 * member, so whatever an emitter passes is reduced to the identifier-only
 * payload before delivery.
 */
function reduceOrgTaskPacket(packet: BroadcastPacket, opts: BroadcastOptions): BroadcastPacket {
  const data = packet?.data;
  if (!Array.isArray(data) || !isOrgTaskEvent(data[0])) return packet;
  const rooms = opts?.rooms;
  const reachesOrg = !rooms || rooms.size === 0 || [...rooms].some((room) => room.startsWith('org:'));
  if (!reachesOrg) return packet;
  return { ...packet, data: [data[0], orgTaskEventPayload(data[0], data[1])] };
}

function installOrgTaskEventGuard(server: SocketIOServer) {
  const adapter = server.of('/').adapter as unknown as BroadcastingAdapter;
  const broadcast = adapter.broadcast.bind(adapter);
  const broadcastWithAck = adapter.broadcastWithAck.bind(adapter);
  adapter.broadcast = (packet, opts) => broadcast(reduceOrgTaskPacket(packet, opts), opts);
  adapter.broadcastWithAck = (packet, opts, ...rest) => broadcastWithAck(reduceOrgTaskPacket(packet, opts), opts, ...rest);
}

/**
 * Emit a per-user event to that user's sockets authenticated for `orgId` only.
 * `orgId` must be the org the event's data belongs to (for a notification, its
 * `org_id`): a user who is a member of several orgs has one socket room per
 * org, and an event about org B must never reach their org-A sockets.
 */
export function emitToUser(orgId: string, userId: string, event: string, data: unknown): void {
  io?.to(`org-user:${orgId}:${userId}`).emit(event, data);
}

/** Get the IDs of users with a socket connected to `orgId`. */
export function getOnlineUserIds(orgId: string): string[] {
  return Array.from(onlineUsers.get(orgId)?.keys() ?? []);
}

/** Get a user's presence status within `orgId`. */
export function getUserStatus(orgId: string, userId: string): 'online' | 'idle' | 'offline' {
  if (!onlineUsers.get(orgId)?.has(userId)) return 'offline';
  return idleUsers.get(orgId)?.has(userId) ? 'idle' : 'online';
}

type SocketSetupDependencies = {
  verifyAccess?: typeof verifyWebAccess;
  requireMembership?: typeof requireActiveOrgMembership;
  getSpaceAccess?: typeof getHuddleSpaceAccess;
  recordLastSeen?: typeof updateLastSeen;
  onPacketIngress?: (eventName: string) => void;
};

export function setupSocket(server: HTTPServer, dependencies: SocketSetupDependencies = {}) {
  const verifyAccess = dependencies.verifyAccess ?? verifyWebAccess;
  const requireMembership = dependencies.requireMembership ?? requireActiveOrgMembership;
  const getSpaceAccess = dependencies.getSpaceAccess ?? getHuddleSpaceAccess;
  const recordLastSeen = dependencies.recordLastSeen ?? updateLastSeen;
  io = new SocketIOServer(server, {
    cors: {
      origin: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
      credentials: true,
    },
    pingInterval: 10000,
    pingTimeout: 5000,
  });
  installOrgTaskEventGuard(io);

  // Auth middleware
  const disconnectSession = (sid: string) => io?.in(`web-session:${sid}`).disconnectSockets(true);
  webSessionEvents.on('revoked', disconnectSession);
  server.once('close', () => webSessionEvents.off('revoked', disconnectSession));
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    try {
      const payload = await verifyAccess(token);
      const authorizationGeneration = captureRealtimeAccessGeneration();
      const membership = await requireMembership(payload.org_id, payload.id);
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
    let settleInitialization!: (ready: boolean) => void;
    let initializationSettled = false;
    const initializationReady = new Promise<boolean>((resolve) => {
      settleInitialization = (ready) => {
        if (initializationSettled) return;
        initializationSettled = true;
        resolve(ready);
      };
    });
    socket.once('disconnect', () => settleInitialization(false));
    socket.use(async (event, next) => {
      dependencies.onPacketIngress?.(String(event[0] ?? ''));
      const packetGeneration = captureRealtimeAccessGeneration();
      try {
        if (!await initializationReady || !socket.connected) {
          next(new Error('Socket initialization failed'));
          return;
        }
        await verifyAccess(socket.handshake.auth.token);
        if (!socket.connected || !isRealtimeAccessGenerationCurrent(packetGeneration)) {
          socket.disconnect(true);
          next(new Error('Workspace access changed; reconnect'));
          return;
        }
        next();
      } catch {
        settleInitialization(false);
        socket.disconnect(true);
        next(new Error('Session unavailable; reconnect'));
      }
    });
    const user = (socket as any).user as SocketUser;
    const expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(0, (user.exp ?? 0) * 1000 - Date.now()));
    expiryTimer.unref();
    socket.once('disconnect', () => clearTimeout(expiryTimer));
    const connectionGeneration = (socket as any).realtimeAccessGeneration as number;
    if (!socket.connected || !isRealtimeAccessGenerationCurrent(connectionGeneration)) {
      settleInitialization(false);
      socket.disconnect(true);
      return;
    }

    try {
      // Join only the session-control room until the second verification has
      // closed the handshake/revocation race. Sensitive data rooms follow.
      await socket.join(`web-session:${user.sid}`);
      await verifyAccess(socket.handshake.auth.token);
      if (!socket.connected || !isRealtimeAccessGenerationCurrent(connectionGeneration)) {
        settleInitialization(false);
        socket.disconnect(true);
        return;
      }
      // No shared `user:<id>` room: it would span every org the user belongs
      // to. Per-user events go to `org-user:<org>:<user>` (emitToUser).
      const dataRooms = [
        `org:${user.org_id}`,
        `org-user:${user.org_id}:${user.id}`,
      ];
      if (user.role !== 'guest') dataRooms.push(`org-members:${user.org_id}`);
      await socket.join(dataRooms);
    } catch (error) {
      console.error('Failed to initialize socket rooms:', error);
      settleInitialization(false);
      socket.disconnect(true);
      return;
    }
    if (!socket.connected || !isRealtimeAccessGenerationCurrent(connectionGeneration)) {
      settleInitialization(false);
      socket.disconnect(true);
      return;
    }

    const emitHuddleError = (event: HuddleEventName, code: HuddleErrorCode, message: string) => {
      socket.emit('huddle:error', { event, code, message });
    };

    // Track this socket under its authenticated org only.
    let orgOnline = onlineUsers.get(user.org_id);
    if (!orgOnline) {
      orgOnline = new Map();
      onlineUsers.set(user.org_id, orgOnline);
    }
    let userSockets = orgOnline.get(user.id);
    if (!userSockets) {
      userSockets = new Set();
      orgOnline.set(user.id, userSockets);
    }
    userSockets.add(socket.id);
    const wasIdle = idleUsers.get(user.org_id)?.has(user.id) ?? false;
    clearIdle(user.org_id, user.id);

    // Update last_seen_at on connect
    recordLastSeen(user.id);

    // Broadcast online to the org for this user's first socket in the org, or
    // when a new socket ends an idle period: peers must not keep showing idle.
    if (userSockets.size === 1 || wasIdle) {
      socket.to(`org:${user.org_id}`).emit('presence:update', {
        user_id: user.id,
        status: 'online',
      });
    }

    // Send the users currently connected to this org to the new client. Cost:
    // one pass over this org's online users; no DB query.
    const presenceList: { user_id: string; status: 'online' | 'idle' }[] = [];
    const orgIdle = idleUsers.get(user.org_id);
    for (const uid of orgOnline.keys()) {
      if (uid !== user.id) {
        presenceList.push({ user_id: uid, status: orgIdle?.has(uid) ? 'idle' : 'online' });
      }
    }
    socket.emit('presence:init', presenceList);

    // Display name of the authenticated user, taken from the checked space join
    // (users.name); typing events use it instead of a client-supplied name.
    let authenticatedUserName: string | null = null;

    // Space rooms
    socket.on('space:join', async (spaceId: string) => {
      if (typeof spaceId !== 'string' || spaceId.length === 0 || spaceId.length > 128) return;
      const authorizationGeneration = captureRealtimeAccessGeneration();
      const access = await getSpaceAccess(spaceId, user).catch(() => undefined);
      if (!access || !isRealtimeAccessGenerationCurrent(authorizationGeneration)) return;
      authenticatedUserName = access.user_name;
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

    // Typing. Only relayed into a space room this socket already joined through
    // the checked `space:join` above (membership + active org + not archived;
    // revocation removes the socket from the room), so no per-keystroke query.
    // The display name comes from that checked join, never from the payload.
    const joinedSpaceId = (data: unknown): string | null => {
      const spaceId = (data as { space_id?: unknown } | null)?.space_id;
      if (typeof spaceId !== 'string' || spaceId.length === 0 || spaceId.length > 128) return null;
      return socket.rooms.has(`space:${spaceId}`) ? spaceId : null;
    };

    socket.on('typing:start', (data: unknown) => {
      const spaceId = joinedSpaceId(data);
      if (!spaceId) return;
      socket.to(`space:${spaceId}`).emit('typing:start', {
        user_id: user.id,
        user_name: authenticatedUserName ?? '',
        space_id: spaceId,
      });
    });

    socket.on('typing:stop', (data: unknown) => {
      const spaceId = joinedSpaceId(data);
      if (!spaceId) return;
      socket.to(`space:${spaceId}`).emit('typing:stop', {
        user_id: user.id,
        space_id: spaceId,
      });
    });

    // Idle / active
    socket.on('presence:idle', () => {
      const orgIdle = idleSet(user.org_id);
      if (!orgIdle.has(user.id)) {
        orgIdle.add(user.id);
        socket.to(`org:${user.org_id}`).emit('presence:update', {
          user_id: user.id,
          status: 'idle',
        });
      }
    });

    socket.on('presence:active', () => {
      recordLastSeen(user.id);
      if (idleUsers.get(user.org_id)?.has(user.id)) {
        clearIdle(user.org_id, user.id);
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
        access = await getSpaceAccess(data.space_id, user);
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
            emitToUser(user.org_id, recipientId, 'huddle:started', {
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

            emitToUser(user.org_id, recipientId, 'huddle:ring', {
              huddle_id: id,
              space_id: data.space_id,
              space_name: spaceName,
              created_by: user.id,
              created_by_name: creatorName,
              participants,
            });

            emitToUser(user.org_id, recipientId, 'notification:new', notification);
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
        access = await getSpaceAccess(room.space_id, user);
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

      const orgSockets = onlineUsers.get(user.org_id);
      const sockets = orgSockets?.get(user.id);
      if (orgSockets && sockets) {
        sockets.delete(socket.id);
        // Only mark offline when ALL of this user's sockets in this org are closed
        if (sockets.size === 0) {
          orgSockets.delete(user.id);
          if (orgSockets.size === 0) onlineUsers.delete(user.org_id);
          clearIdle(user.org_id, user.id);
          recordLastSeen(user.id);
          socket.to(`org:${user.org_id}`).emit('presence:update', {
            user_id: user.id,
            status: 'offline',
          });
        }
      }
    });
    // Socket.IO awaits per-packet middleware before dispatching to listeners.
    // Packets emitted from the client's `connect` callback remain queued here
    // until initialization and every handler registration above are complete.
    settleInitialization(true);
  });

  return io;
}
