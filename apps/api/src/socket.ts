import { Server as SocketIOServer } from 'socket.io';
import type { Server as HTTPServer } from 'node:http';
import jwt from 'jsonwebtoken';
import { env } from './lib/env.js';
import { db } from './lib/db.js';
import { users, spaceMembers, spaces, notifications } from '@deft/db/schema';
import { eq, and, ne } from 'drizzle-orm';
import * as huddle from './huddle-rooms.js';

function updateLastSeen(userId: string) {
  db.update(users).set({ last_seen_at: new Date() }).where(eq(users.id, userId)).catch(() => {});
}

let io: SocketIOServer | null = null;

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
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    try {
      const payload = jwt.verify(token, env.JWT_SECRET) as { id: string; email: string; org_id: string };
      (socket as any).user = payload;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const user = (socket as any).user as { id: string; email: string; org_id: string };

    // Track this socket
    if (!onlineUsers.has(user.id)) {
      onlineUsers.set(user.id, new Set());
    }
    onlineUsers.get(user.id)!.add(socket.id);
    userOrgs.set(user.id, user.org_id);
    idleUsers.delete(user.id);

    // Join rooms
    socket.join(`org:${user.org_id}`);
    socket.join(`user:${user.id}`);

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
      const [member] = await db.select({ id: spaceMembers.id })
        .from(spaceMembers)
        .where(and(eq(spaceMembers.space_id, spaceId), eq(spaceMembers.user_id, user.id)))
        .limit(1);
      if (member) {
        socket.join(`space:${spaceId}`);
      }
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

    socket.on('huddle:create', (data: { space_id: string }) => {
      // Check if there's already an active huddle in this space
      let room = huddle.getRoomBySpace(data.space_id);
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
      room = huddle.createRoom(id, data.space_id, user.org_id, user.id);
      huddle.addParticipant(id, { user_id: user.id, user_name: user.email, muted: false, socket_id: socket.id });
      socket.join(`huddle:${id}`);
      // Broadcast to the space that a huddle started
      io!.to(`space:${data.space_id}`).emit('huddle:started', {
        huddle_id: id,
        space_id: data.space_id,
        created_by: user.id,
        participants: huddle.getParticipantList(id),
      });
      socket.emit('huddle:joined', { huddle_id: id, participants: huddle.getParticipantList(id) });

      // Ring all non-muted space members (fire-and-forget)
      (async () => {
        try {
          // Get space name
          const [space] = await db.select({ name: spaces.name }).from(spaces)
            .where(eq(spaces.id, data.space_id)).limit(1);
          // Get creator name
          const [creator] = await db.select({ name: users.name }).from(users)
            .where(eq(users.id, user.id)).limit(1);
          const spaceName = space?.name || 'Unknown';
          const creatorName = creator?.name || user.email;

          // Get all space members except creator
          const members = await db.select({
            user_id: spaceMembers.user_id,
            is_muted: spaceMembers.is_muted,
            status_text: users.status_text,
          }).from(spaceMembers)
            .innerJoin(users, eq(spaceMembers.user_id, users.id))
            .where(and(
              eq(spaceMembers.space_id, data.space_id),
              ne(spaceMembers.user_id, user.id),
            ));

          for (const member of members) {
            if (member.is_muted) continue;
            if (member.status_text === 'Do Not Disturb') continue;

            // Create notification record
            await db.insert(notifications).values({
              org_id: user.org_id,
              user_id: member.user_id,
              type: 'huddle_started',
              title: `${creatorName} started a huddle`,
              body: `#${spaceName}`,
              link: `/chat?space=${data.space_id}`,
              metadata: { huddle_id: id, space_id: data.space_id },
            }).catch(() => {});

            // Emit ring event
            emitToUser(member.user_id, 'huddle:ring', {
              huddle_id: id,
              space_id: data.space_id,
              space_name: spaceName,
              created_by: user.id,
              created_by_name: creatorName,
              participants: huddle.getParticipantList(id),
            });

            // Also emit notification:new for badge count
            emitToUser(member.user_id, 'notification:new', {
              type: 'huddle_started',
              title: `${creatorName} started a huddle`,
              body: `#${spaceName}`,
            });
          }
        } catch (err) {
          console.error('Failed to send huddle rings:', err);
        }
      })();
    });

    socket.on('huddle:join', (data: { huddle_id: string }) => {
      const room = huddle.getRoom(data.huddle_id);
      if (!room) { socket.emit('huddle:error', { message: 'Room not found' }); return; }
      huddle.addParticipant(data.huddle_id, { user_id: user.id, user_name: user.email, muted: false, socket_id: socket.id });
      socket.join(`huddle:${data.huddle_id}`);
      // Notify existing participants
      socket.to(`huddle:${data.huddle_id}`).emit('huddle:user_joined', {
        huddle_id: data.huddle_id,
        user_id: user.id,
        participants: huddle.getParticipantList(data.huddle_id),
      });
      // Notify the space
      io!.to(`space:${room.space_id}`).emit('huddle:updated', {
        huddle_id: data.huddle_id,
        participants: huddle.getParticipantList(data.huddle_id),
      });
      socket.emit('huddle:joined', { huddle_id: data.huddle_id, participants: huddle.getParticipantList(data.huddle_id) });
    });

    socket.on('huddle:leave', (data: { huddle_id: string }) => {
      const { empty, room } = huddle.removeParticipant(data.huddle_id, user.id);
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
          participants: huddle.getParticipantList(data.huddle_id),
        });
      }
    });

    socket.on('huddle:signal', (data: { huddle_id: string; target_user_id: string; signal_data: any }) => {
      // Relay WebRTC signaling data to the target user
      const participants = huddle.getParticipantList(data.huddle_id);
      const target = participants.find(p => p.user_id === data.target_user_id);
      if (target) {
        io!.to(target.socket_id).emit('huddle:signal', {
          huddle_id: data.huddle_id,
          from_user_id: user.id,
          signal_data: data.signal_data,
        });
      }
    });

    socket.on('huddle:mute', (data: { huddle_id: string; muted: boolean }) => {
      huddle.setMuted(data.huddle_id, user.id, data.muted);
      socket.to(`huddle:${data.huddle_id}`).emit('huddle:mute_changed', {
        huddle_id: data.huddle_id,
        user_id: user.id,
        muted: data.muted,
      });
    });

    // Disconnect
    socket.on('disconnect', () => {
      // Auto-leave any huddle the user was in
      for (const room of huddle.getActiveRooms()) {
        const participants = huddle.getParticipantList(room.id);
        const inRoom = participants.find(p => p.socket_id === socket.id);
        if (inRoom) {
          const { empty, room: r } = huddle.removeParticipant(room.id, user.id);
          socket.to(`huddle:${room.id}`).emit('huddle:user_left', {
            huddle_id: room.id, user_id: user.id, participants: huddle.getParticipantList(room.id),
          });
          if (r) {
            io!.to(`space:${r.space_id}`).emit('huddle:updated', {
              huddle_id: room.id, participants: huddle.getParticipantList(room.id),
            });
          }
          if (empty && r) {
            huddle.setGraceTimer(room.id, () => {
              const orgId = r.org_id;
              const spaceId = r.space_id;
              const hid = room.id;
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
