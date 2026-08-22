import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, lt, lte, gt, sql, isNull, inArray, ne } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { messages, users, reactions, spaces, spaceMembers, orgs, threadReads, messageVersions, agentEmployees, userGroups, userGroupMembers, orgMembers, files } from '@deft/db/schema';
import { getIO, emitToUser } from '../socket.js';
import { parseMentions } from '../lib/mentions.js';
import { fetchLinkPreview, extractUrls, type LinkPreview } from '../lib/link-preview.js';
import { enqueue, QUEUE_NAMES } from '../lib/queues.js';
import { resolveReasonProvider } from '../lib/org-ai-config.js';
import { requireSpaceMembership } from '../lib/space-membership.js';
import { DEFTY_EMAIL, ensureDeftyMembership } from '../lib/ensure-defty-membership.js';
import { enqueueChatObservation } from '../lib/chat-observation.js';
import { createNotificationIfAllowed, createNotificationsIfAllowed } from '../lib/notification-policy.js';
import { normalizePlainAgentMentions } from '../lib/agent-mention-normalization.js';
import { toPlainText } from '../lib/plain-text.js';
import {
  getMessageAttachments,
  MAX_MESSAGE_ATTACHMENTS,
  normalizeAttachmentIds,
  toMessageAttachment,
} from '../lib/message-attachments.js';

export const messageRoutes = new Hono();

const sendMessageSchema = z.object({
  content: z.string().min(1),
  parent_id: z.string().optional(),
  file_ids: z.array(z.string().min(1)).max(MAX_MESSAGE_ATTACHMENTS).optional(),
});

class AttachmentClaimError extends Error {}

// Helper: aggregate reactions for a set of message IDs
async function getReactionsForMessages(messageIds: string[]) {
  if (messageIds.length === 0) return new Map();

  const reactionRows = await db.select({
    message_id: reactions.message_id,
    emoji: reactions.emoji,
    user_id: reactions.user_id,
  })
    .from(reactions)
    .where(inArray(reactions.message_id, messageIds));

  // Group by message_id + emoji
  const grouped = new Map<string, Map<string, string[]>>();
  for (const row of reactionRows) {
    if (!grouped.has(row.message_id)) {
      grouped.set(row.message_id, new Map());
    }
    const emojiMap = grouped.get(row.message_id)!;
    if (!emojiMap.has(row.emoji)) {
      emojiMap.set(row.emoji, []);
    }
    emojiMap.get(row.emoji)!.push(row.user_id);
  }

  // Convert to final format
  const result = new Map<string, { emoji: string; count: number; users: string[] }[]>();
  for (const [msgId, emojiMap] of grouped) {
    const arr: { emoji: string; count: number; users: string[] }[] = [];
    for (const [emoji, userIds] of emojiMap) {
      arr.push({ emoji, count: userIds.length, users: userIds });
    }
    result.set(msgId, arr);
  }

  return result;
}

async function getVisibleMessage(messageId: string, orgId: string, userId: string) {
  const [msg] = await db.select({
    id: messages.id,
    org_id: messages.org_id,
    space_id: messages.space_id,
    user_id: messages.user_id,
    parent_id: messages.parent_id,
    content: messages.content,
    is_deleted: messages.is_deleted,
    metadata: messages.metadata,
    created_at: messages.created_at,
    edited_at: messages.edited_at,
    user_name: users.name,
    user_avatar: users.avatar_url,
    user_timezone: users.timezone,
  })
    .from(messages)
    .innerJoin(spaceMembers, and(
      eq(messages.space_id, spaceMembers.space_id),
      eq(spaceMembers.user_id, userId),
    ))
    .innerJoin(users, eq(messages.user_id, users.id))
    .where(and(
      eq(messages.id, messageId),
      eq(messages.org_id, orgId),
      eq(messages.is_deleted, false),
    ))
    .limit(1);

  return msg ?? null;
}

async function resolveGroupMentionUserIds(content: string, orgId: string): Promise<string[]> {
  const handles = Array.from(
    new Set(
      Array.from(content.matchAll(/(^|[\s(>])@([a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9])\b/g))
        .map((match) => match[2]?.toLowerCase())
        .filter((handle): handle is string => !!handle),
    ),
  );
  if (handles.length === 0) return [];

  const rows = await db
    .select({ user_id: userGroupMembers.user_id })
    .from(userGroups)
    .innerJoin(userGroupMembers, eq(userGroupMembers.group_id, userGroups.id))
    .innerJoin(orgMembers, and(
      eq(orgMembers.user_id, userGroupMembers.user_id),
      eq(orgMembers.org_id, userGroups.org_id),
      eq(orgMembers.is_active, true),
    ))
    .where(and(
      eq(userGroups.org_id, orgId),
      inArray(userGroups.handle, handles),
    ));

  return Array.from(new Set(rows.map((row) => row.user_id)));
}

// Helper: get reply counts and latest_reply_at for a set of message IDs
async function getReplyStats(messageIds: string[]) {
  if (messageIds.length === 0) return new Map();

  const rows = await db.select({
    parent_id: messages.parent_id,
    count: sql<number>`count(*)::int`,
    latest: sql<string>`to_char(max(${messages.created_at}), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
  })
    .from(messages)
    .where(
      and(
        inArray(messages.parent_id, messageIds),
        eq(messages.is_deleted, false),
      )
    )
    .groupBy(messages.parent_id);

  const result = new Map<string, { reply_count: number; latest_reply_at: string | null }>();
  for (const row of rows) {
    if (row.parent_id) {
      result.set(row.parent_id, {
        reply_count: row.count,
        latest_reply_at: row.latest,
      });
    }
  }

  return result;
}

// POST /forward — forward a message to another space (must be before /:spaceId)
messageRoutes.post('/forward', async (c) => {
  try {
    const user = c.get('user');
    const { message_id, target_space_id } = await c.req.json();

    if (!message_id || !target_space_id) {
      return c.json({ error: 'message_id and target_space_id required', code: 'VALIDATION_ERROR' }, 400);
    }

    const [original] = await db.select({
      content: messages.content,
      user_id: messages.user_id,
      space_id: messages.space_id,
    }).from(messages)
      .where(eq(messages.id, message_id))
      .limit(1);

    if (!original) {
      return c.json({ error: 'Message not found', code: 'NOT_FOUND' }, 404);
    }

    const isSourceMember = await requireSpaceMembership(original.space_id, user.id);
    if (!isSourceMember) return c.json({ error: 'No access to source message', code: 'FORBIDDEN' }, 403);

    const isTargetMember = await requireSpaceMembership(target_space_id, user.id);
    if (!isTargetMember) return c.json({ error: 'No access to target space', code: 'FORBIDDEN' }, 403);

    const [author] = await db.select({ name: users.name }).from(users).where(eq(users.id, original.user_id)).limit(1);
    const [sourceSpace] = await db.select({ name: spaces.name }).from(spaces).where(eq(spaces.id, original.space_id)).limit(1);

    const forwardedContent = `<blockquote>${original.content}</blockquote><p><em>Forwarded from #${sourceSpace?.name || 'unknown'} by ${author?.name || 'unknown'}</em></p>`;

    const [forwarded] = await db.insert(messages).values({
      org_id: user.org_id,
      space_id: target_space_id,
      user_id: user.id,
      content: forwardedContent,
      metadata: { forwarded_from: { message_id, space_id: original.space_id, space_name: sourceSpace?.name } },
    }).returning();

    const io = getIO();
    if (io && forwarded) {
      const [full] = await db.select({
        id: messages.id,
        content: messages.content,
        user_id: messages.user_id,
        space_id: messages.space_id,
        created_at: messages.created_at,
        user_name: users.name,
        user_avatar: users.avatar_url,
        metadata: messages.metadata,
      }).from(messages)
        .innerJoin(users, eq(messages.user_id, users.id))
        .where(eq(messages.id, forwarded.id))
        .limit(1);

      io.to(`space:${target_space_id}`).emit('message:new', full);
    }

    return c.json(forwarded, 201);
  } catch (err) {
    console.error('Failed to forward message:', err);
    return c.json({ error: 'Failed to forward', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/messages/:spaceId — paginated top-level messages
messageRoutes.get('/:spaceId', async (c) => {
  try {
    const user = c.get('user');
    const spaceId = c.req.param('spaceId');

    const isMember = await requireSpaceMembership(spaceId, user.id);
    if (!isMember) return c.json({ error: 'Not a member of this space', code: 'FORBIDDEN' }, 403);

    const cursor = c.req.query('cursor');
    const around = c.req.query('around');
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);

    // "around" mode: fetch messages around a specific message ID
    if (around) {
      const [targetMsg] = await db.select({ created_at: messages.created_at })
        .from(messages).where(eq(messages.id, around)).limit(1);
      if (!targetMsg) {
        return c.json({ messages: [], next_cursor: null });
      }
      const [before, after] = await Promise.all([
        db.select({
          id: messages.id, content: messages.content, space_id: messages.space_id,
          user_id: messages.user_id, parent_id: messages.parent_id, is_pinned: messages.is_pinned,
          is_deleted: messages.is_deleted, edited_at: messages.edited_at, metadata: messages.metadata,
          created_at: messages.created_at, user_name: users.name, user_avatar: users.avatar_url,
          user_timezone: users.timezone,
        }).from(messages).innerJoin(users, eq(messages.user_id, users.id))
          .where(and(eq(messages.space_id, spaceId), eq(messages.org_id, user.org_id), isNull(messages.parent_id), lte(messages.created_at, targetMsg.created_at)))
          .orderBy(desc(messages.created_at)).limit(25),
        db.select({
          id: messages.id, content: messages.content, space_id: messages.space_id,
          user_id: messages.user_id, parent_id: messages.parent_id, is_pinned: messages.is_pinned,
          is_deleted: messages.is_deleted, edited_at: messages.edited_at, metadata: messages.metadata,
          created_at: messages.created_at, user_name: users.name, user_avatar: users.avatar_url,
          user_timezone: users.timezone,
        }).from(messages).innerJoin(users, eq(messages.user_id, users.id))
          .where(and(eq(messages.space_id, spaceId), eq(messages.org_id, user.org_id), isNull(messages.parent_id), gt(messages.created_at, targetMsg.created_at)))
          .orderBy(messages.created_at).limit(25),
      ]);
      const combined = [...before.reverse(), ...after];
      // Deduplicate
      const seen = new Set<string>();
      const unique = combined.filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; });
      const messageIds = unique.map(m => m.id);
      const [reactionsMap, replyStatsMap, attachmentsMap] = await Promise.all([
        getReactionsForMessages(messageIds),
        getReplyStats(messageIds),
        getMessageAttachments(messageIds, user.org_id),
      ]);
      const result = unique.map(msg => ({
        ...msg,
        reactions: reactionsMap.get(msg.id) ?? [],
        reply_count: replyStatsMap.get(msg.id)?.reply_count ?? 0,
        latest_reply_at: replyStatsMap.get(msg.id)?.latest_reply_at ?? null,
        file_ids: (attachmentsMap.get(msg.id) ?? []).map((file) => file.id),
        files: attachmentsMap.get(msg.id) ?? [],
      }));
      return c.json({ messages: result, next_cursor: null });
    }

    const whereConditions = cursor
      ? and(
          eq(messages.space_id, spaceId),
          eq(messages.org_id, user.org_id),
          isNull(messages.parent_id),
          lt(messages.created_at, new Date(cursor)),
        )
      : and(
          eq(messages.space_id, spaceId),
          eq(messages.org_id, user.org_id),
          isNull(messages.parent_id),
        );

    const result = await db.select({
      id: messages.id,
      content: messages.content,
      space_id: messages.space_id,
      user_id: messages.user_id,
      parent_id: messages.parent_id,
      is_pinned: messages.is_pinned,
      is_deleted: messages.is_deleted,
      edited_at: messages.edited_at,
      metadata: messages.metadata,
      created_at: messages.created_at,
      user_name: users.name,
      user_avatar: users.avatar_url,
      user_timezone: users.timezone,
    })
      .from(messages)
      .innerJoin(users, eq(messages.user_id, users.id))
      .where(whereConditions)
      .orderBy(desc(messages.created_at))
      .limit(limit);

    const messageIds = result.map((m) => m.id);

    // Fetch reactions and reply stats in parallel
    const [reactionsMap, replyStatsMap, attachmentsMap] = await Promise.all([
      getReactionsForMessages(messageIds),
      getReplyStats(messageIds),
      getMessageAttachments(messageIds, user.org_id),
    ]);

    // Fetch thread read state for messages with replies
    const msgsWithReplies = messageIds.filter(id => replyStatsMap.has(id) && (replyStatsMap.get(id)?.reply_count ?? 0) > 0);
    let threadReadMap = new Map<string, Date>();
    if (msgsWithReplies.length > 0) {
      const reads = await db.select({
        parent_message_id: threadReads.parent_message_id,
        last_read_at: threadReads.last_read_at,
      }).from(threadReads)
        .where(and(
          eq(threadReads.user_id, user.id),
          inArray(threadReads.parent_message_id, msgsWithReplies),
        ));
      for (const r of reads) {
        threadReadMap.set(r.parent_message_id, r.last_read_at);
      }
    }

    // Merge reactions, reply stats, and thread unread state
    const messagesWithExtras = result.map((msg) => {
      const replyStats = replyStatsMap.get(msg.id);
      const replyCount = replyStats?.reply_count ?? 0;
      const latestReplyAt = replyStats?.latest_reply_at ?? null;
      let hasUnreadThreadReplies = false;
      if (replyCount > 0 && latestReplyAt) {
        const lastRead = threadReadMap.get(msg.id);
        hasUnreadThreadReplies = !lastRead || new Date(latestReplyAt) > lastRead;
      }
      return {
        ...msg,
        reactions: reactionsMap.get(msg.id) ?? [],
        reply_count: replyCount,
        latest_reply_at: latestReplyAt,
        has_unread_thread_replies: hasUnreadThreadReplies,
        file_ids: (attachmentsMap.get(msg.id) ?? []).map((file) => file.id),
        files: attachmentsMap.get(msg.id) ?? [],
      };
    });

    return c.json({
      messages: messagesWithExtras.reverse(),
      next_cursor: result.length === limit ? result[0]?.created_at?.toISOString() : null,
    });
  } catch (err) {
    console.error('Failed to fetch messages:', err);
    return c.json({ error: 'Failed to fetch messages', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/messages/:spaceId — send message
messageRoutes.post('/:spaceId', async (c) => {
  try {
    const user = c.get('user');
    const spaceId = c.req.param('spaceId');
    const body = await c.req.json();
    const parsed = sendMessageSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    // Phase 7 invariant — verify membership BEFORE insert. Without this, any
    // authenticated user could POST a message into any space (including
    // cross-org spaces) by passing the foreign space_id in the URL.
    const isMember = await requireSpaceMembership(spaceId, user.id);
    if (!isMember) {
      return c.json({ error: 'Not a member of this space', code: 'FORBIDDEN' }, 403);
    }

    if (parsed.data.parent_id) {
      const parentMsg = await getVisibleMessage(parsed.data.parent_id, user.org_id, user.id);
      if (!parentMsg || parentMsg.space_id !== spaceId) {
        return c.json({ error: 'Parent message not found', code: 'NOT_FOUND' }, 404);
      }
    }

    // Normalize plain @defty / @deft / @agent (case-insensitive) into structured
    // mentions so the renderer styles them as pills uniformly.
    let normalizedContent = parsed.data.content;
    if (!/<@[^|]+\|Defty?>/i.test(normalizedContent)) {
      const hasLegacyAgent = /(^|[^a-z0-9_])@(defty|deft|agent)\b/i.test(normalizedContent);
      if (hasLegacyAgent) {
        const deftyUserId = await ensureDeftyMembership(user.org_id);
        normalizedContent = normalizedContent.replace(
          /(^|[^a-z0-9_])@(defty|deft|agent)\b/gi,
          (_match, prefix) => `${prefix}<@${deftyUserId}|Defty>`,
        );
      }
    }

    const plainMentionScan = normalizedContent.replace(/<@[^>]+>/g, '');
    if (/(^|[^a-z0-9_])@[a-z0-9]/i.test(plainMentionScan)) {
      const agentIdentities = await db
        .select({
          userId: agentEmployees.user_id,
          name: agentEmployees.name,
          slug: agentEmployees.slug,
        })
        .from(agentEmployees)
        .innerJoin(users, eq(agentEmployees.user_id, users.id))
        .where(and(
          eq(agentEmployees.org_id, user.org_id),
          eq(agentEmployees.is_active, true),
        ));
      const plainAgentMentions = normalizePlainAgentMentions(
        normalizedContent,
        agentIdentities.flatMap((agent) => agent.userId ? [{
          userId: agent.userId,
          name: agent.name,
          slug: agent.slug,
        }] : []),
      );
      if (plainAgentMentions.ambiguousAliases.length > 0) {
        const handles = plainAgentMentions.ambiguousAliases.map((alias) => `@${alias}`).join(', ');
        return c.json({
          error: `${handles} matches more than one active agent. Choose the intended agent from the mention menu.`,
          code: 'AMBIGUOUS_AGENT_MENTION',
        }, 409);
      }
      normalizedContent = plainAgentMentions.content;
    }

    const attachmentIds = normalizeAttachmentIds(parsed.data.file_ids, normalizedContent);
    if (attachmentIds.length > MAX_MESSAGE_ATTACHMENTS) {
      return c.json({
        error: `A message can include at most ${MAX_MESSAGE_ATTACHMENTS} attachments`,
        code: 'VALIDATION_ERROR',
      }, 400);
    }

    const { message, messageAttachments } = await db.transaction(async (tx) => {
      const [insertedMessage] = await tx.insert(messages).values({
        org_id: user.org_id,
        space_id: spaceId,
        user_id: user.id,
        content: normalizedContent,
        parent_id: parsed.data.parent_id,
      }).returning();
      if (!insertedMessage) throw new Error('Message insert returned no row');

      if (attachmentIds.length === 0) {
        return { message: insertedMessage, messageAttachments: [] };
      }

      const claimedFiles = await tx.update(files)
        .set({ message_id: insertedMessage.id })
        .where(and(
          inArray(files.id, attachmentIds),
          eq(files.org_id, user.org_id),
          eq(files.uploaded_by, user.id),
          isNull(files.message_id),
          isNull(files.task_id),
        ))
        .returning({
          id: files.id,
          filename: files.filename,
          mime_type: files.mime_type,
          size_bytes: files.size_bytes,
        });

      if (claimedFiles.length !== attachmentIds.length) {
        throw new AttachmentClaimError('One or more attachments are unavailable');
      }

      const claimedById = new Map(claimedFiles.map((file) => [file.id, file]));
      return {
        message: insertedMessage,
        messageAttachments: attachmentIds.map((id) => toMessageAttachment(claimedById.get(id)!)),
      };
    });

    // Get user info for the broadcast
    const [userData] = await db.select({
      name: users.name,
      avatar_url: users.avatar_url,
    }).from(users).where(eq(users.id, user.id)).limit(1);

    const messageWithUser = {
      ...message,
      user_name: userData?.name,
      user_avatar: userData?.avatar_url,
      reactions: [],
      reply_count: 0,
      latest_reply_at: null,
      file_ids: messageAttachments.map((file) => file.id),
      files: messageAttachments,
    };

    // Broadcast via Socket.io
    const io = getIO();
    if (io) {
      io.to(`space:${spaceId}`).emit('message:new', messageWithUser);
    }

    // Async link preview fetch — don't block the response
    const urls = extractUrls(parsed.data.content);
    if (urls.length > 0 && io) {
      // Fire and forget — fetch previews and update message metadata
      (async () => {
        try {
          const previews: LinkPreview[] = [];
          for (const url of urls.slice(0, 3)) { // Max 3 previews per message
            const preview = await fetchLinkPreview(url);
            if (preview) previews.push(preview);
          }
          if (previews.length > 0) {
            await db.update(messages)
              .set({ metadata: { link_previews: previews } })
              .where(eq(messages.id, message!.id));

            io.to(`space:${spaceId}`).emit('message:link_previews', {
              message_id: message!.id,
              previews,
            });
          }
        } catch (err) {
          console.error('Link preview fetch failed:', err);
        }
      })();
    }

    // Parse mentions and create notifications
    const { userIds: directMentionedUserIds } = parseMentions(normalizedContent);
    const groupMentionedUserIds = await resolveGroupMentionUserIds(normalizedContent, user.org_id);
    const mentionedUserIds = Array.from(new Set([
      ...directMentionedUserIds,
      ...groupMentionedUserIds,
    ]));

    for (const mentionedUserId of mentionedUserIds) {
      // Don't notify the sender
      if (mentionedUserId === user.id) continue;

      try {
        const [mentionedUser] = await db.select({ id: users.id })
          .from(users)
          .where(eq(users.id, mentionedUserId))
          .limit(1);
        if (!mentionedUser) continue;

        const notification = await createNotificationIfAllowed({
          org_id: user.org_id,
          user_id: mentionedUserId,
          type: 'mention',
          title: `${userData?.name ?? 'Someone'} mentioned you`,
          body: normalizedContent.slice(0, 200),
          link: `/chat?space=${encodeURIComponent(spaceId)}&message=${encodeURIComponent(message!.id)}`,
        }, { channel: 'chat', spaceId, isMention: true });

        if (notification) {
          emitToUser(mentionedUserId, 'notification:new', notification);
        }
      } catch (err) {
        console.error(`Failed to create mention notification for ${mentionedUserId}:`, err);
      }
    }

    // If it's a thread reply, notify the parent message author and broadcast thread:updated
    if (parsed.data.parent_id) {
      try {
        const [parentMessage] = await db.select({
          user_id: messages.user_id,
        })
          .from(messages)
          .where(eq(messages.id, parsed.data.parent_id))
          .limit(1);

        if (parentMessage && parentMessage.user_id !== user.id && !mentionedUserIds.includes(parentMessage.user_id)) {
          const notification = await createNotificationIfAllowed({
            org_id: user.org_id,
            user_id: parentMessage.user_id,
            type: 'mention',
            title: `${userData?.name ?? 'Someone'} replied to your message`,
            body: normalizedContent.slice(0, 200),
            link: `/chat?space=${encodeURIComponent(spaceId)}&message=${encodeURIComponent(parsed.data.parent_id)}`,
          }, { channel: 'chat', spaceId, isMention: true });

          if (notification) {
            emitToUser(parentMessage.user_id, 'notification:new', notification);
          }
        }

        // Get updated reply stats for the parent
        const replyStatsMap = await getReplyStats([parsed.data.parent_id]);
        const stats = replyStatsMap.get(parsed.data.parent_id);

        if (io) {
          io.to(`space:${spaceId}`).emit('thread:updated', {
            parent_id: parsed.data.parent_id,
            reply_count: stats?.reply_count ?? 1,
            latest_reply_at: stats?.latest_reply_at ?? message!.created_at,
          });
        }
      } catch (err) {
        console.error('Failed to handle thread reply notification:', err);
      }
    }

    // Create notifications for message recipients
    try {
      const [space] = await db.select({ type: spaces.type, name: spaces.name })
        .from(spaces)
        .where(eq(spaces.id, spaceId))
        .limit(1);

      if (space && !parsed.data.parent_id) {
        // Get all space members except sender (with mute + DND status)
        const members = await db.select({
          user_id: spaceMembers.user_id,
        })
          .from(spaceMembers)
          .where(and(
            eq(spaceMembers.space_id, spaceId),
            sql`${spaceMembers.user_id} != ${user.id}`,
          ));

        const plainContent = toPlainText(normalizedContent).slice(0, 200);

        const isDm = space.type === 'dm' || space.type === 'group_dm';
        const title = isDm
          ? `${userData?.name ?? 'Someone'} sent you a message`
          : `${userData?.name ?? 'Someone'} in #${space.name}`;
        const link = `/chat?space=${spaceId}&message=${message!.id}`;
        const recipientNotifications = await createNotificationsIfAllowed(
          members
            .filter((member) => !mentionedUserIds.includes(member.user_id))
            .map((member) => ({
            org_id: user.org_id,
            user_id: member.user_id,
            type: 'message',
            title,
            body: plainContent,
            link,
            metadata: {
              message_id: message!.id,
              space_id: spaceId,
              is_direct_message: isDm,
            },
          })),
          { channel: 'chat', spaceId, isMention: false, respectDnd: true },
        );
        for (const notification of recipientNotifications) {
          emitToUser(notification.user_id, 'notification:new', notification);
        }
      }
    } catch (err) {
      console.error('Message notification error:', err);
    }

    // Detect @deft mention — Defty is the only agent that fires agent-reply.
    // BYOA agent mentions are handled separately (agent-employee-message); we
    // must NOT fire agent-reply for them.
    let agentMentioned = false;
    if (mentionedUserIds.length > 0) {
      const deftyMatch = await db
        .select({ id: users.id })
        .from(users)
        .where(and(
          inArray(users.id, mentionedUserIds),
          eq(users.email, DEFTY_EMAIL),
        ))
        .limit(1);
      agentMentioned = deftyMatch.length > 0;
    }
    // Backwards-compat fallback: legacy `<@agent|Deft>` and freeform `@defty`/`@deft`/`@agent` still trigger Defty.
    const legacyAgentMentionRegex = /@(agent|defty|deft)\b|<@agent\|Defty?>/i;
    if (!agentMentioned && legacyAgentMentionRegex.test(normalizedContent)) {
      agentMentioned = true;
    }
    // Auto-trigger Defty in DM-with-Defty / agent_conversation spaces — no mention required.
    if (!agentMentioned) {
      const [spaceRow] = await db.select({ type: spaces.type })
        .from(spaces).where(eq(spaces.id, spaceId)).limit(1);
      if (spaceRow && (spaceRow.type === 'dm' || spaceRow.type === 'agent_conversation')) {
        const deftyUserId = await ensureDeftyMembership(user.org_id);
        if (deftyUserId !== user.id) {
          const [deftyMember] = await db.select({ user_id: spaceMembers.user_id })
            .from(spaceMembers)
            .where(and(eq(spaceMembers.space_id, spaceId), eq(spaceMembers.user_id, deftyUserId)))
            .limit(1);
          if (deftyMember) agentMentioned = true;
        }
      }
    }

    // Defty dispatch is gated on the org having a usable reasoning provider —
    // not specifically Anthropic. Reasoning is provider-agnostic (anthropic /
    // openai / openrouter / ollama), and the key usually lives in org config,
    // not env. Gating on Anthropic here silently dropped Defty whenever the
    // org ran on OpenAI/etc. with no Anthropic key.
    let deftyProviderReady = false;
    let deftyProviderReason: Awaited<ReturnType<typeof resolveReasonProvider>> | null = null;
    if (agentMentioned) {
      deftyProviderReason = await resolveReasonProvider(user.org_id);
      deftyProviderReady = Boolean(deftyProviderReason.apiKey) || deftyProviderReason.provider === 'ollama';
    }
    if (agentMentioned && deftyProviderReady) {
      try {
        const [org] = await db.select({ name: orgs.name })
          .from(orgs)
          .where(eq(orgs.id, user.org_id))
          .limit(1);

        await enqueue(QUEUE_NAMES.AGENT_JOBS, 'agent-reply', {
          spaceId,
          messageId: message!.id,
          parentId: parsed.data.parent_id,
          orgId: user.org_id,
          userId: user.id,
          orgName: org?.name ?? 'Unknown',
          content: normalizedContent,
        });
      } catch (err) {
        // Don't block message sending if the background queue enqueue fails.
        console.error('Failed to enqueue agent reply:', err);
      }
    } else if (agentMentioned && deftyProviderReason) {
      try {
        const [spaceRow] = await db.select({ type: spaces.type })
          .from(spaces)
          .where(eq(spaces.id, spaceId))
          .limit(1);
        const isDmLike = spaceRow?.type === 'dm' || spaceRow?.type === 'group_dm' || spaceRow?.type === 'agent_conversation';
        const replyParentId = isDmLike ? (parsed.data.parent_id ?? null) : (parsed.data.parent_id || message!.id);
        const deftyUserId = await ensureDeftyMembership(user.org_id);
        const [agentMessage] = await db.insert(messages).values({
          org_id: user.org_id,
          space_id: spaceId,
          user_id: deftyUserId,
          content: `I need a usable reasoning model before I can answer. The current Defty reasoning route resolves to ${deftyProviderReason.provider}, but no usable ${deftyProviderReason.provider === 'ollama' ? 'Ollama endpoint' : 'API key'} is configured. Ask an admin to configure a reasoning provider in Settings > AI.`,
          parent_id: replyParentId,
          metadata: {
            is_agent_reply: true,
            kind: 'defty_provider_unavailable',
            provider: deftyProviderReason.provider,
            model: deftyProviderReason.model,
          } as never,
        }).returning();

        const io = getIO();
        if (io && agentMessage) {
          io.to(`space:${spaceId}`).emit('message:new', {
            ...agentMessage,
            user_name: 'Defty',
            user_avatar: null,
            reactions: [],
            reply_count: 0,
            latest_reply_at: null,
          });
        }
      } catch (err) {
        console.error('Failed to post Defty provider-unavailable reply:', err);
      }
    }

    // Detect agent-employee mentions → enqueue agent-employee-message per employee.
    // Also auto-trigger BYOA agents in DM/agent_conversation spaces — no mention
    // required. BYOA delivery must not depend on Deft's own hosted LLM provider:
    // the external runtime already owns its model and pulls work through MCP.
    try {
      const targetUserIds = new Set<string>(mentionedUserIds);
      const [spaceRow] = await db.select({ type: spaces.type })
        .from(spaces).where(eq(spaces.id, spaceId)).limit(1);
      if (spaceRow && (spaceRow.type === 'dm' || spaceRow.type === 'agent_conversation')) {
        const dmMembers = await db.select({ user_id: spaceMembers.user_id })
          .from(spaceMembers)
          .where(and(eq(spaceMembers.space_id, spaceId), sql`${spaceMembers.user_id} != ${user.id}`));
        for (const m of dmMembers) targetUserIds.add(m.user_id);
      }

      if (targetUserIds.size > 0) {
        const targetEmployees = await db.select({
          id: agentEmployees.id,
          user_id: agentEmployees.user_id,
        })
          .from(agentEmployees)
          .where(and(
            eq(agentEmployees.org_id, user.org_id),
            eq(agentEmployees.is_active, true),
            ne(agentEmployees.runtime_kind, 'defty_system'),
            inArray(agentEmployees.user_id, Array.from(targetUserIds)),
          ));

        for (const emp of targetEmployees) {
          await enqueue(QUEUE_NAMES.AGENT_JOBS, 'agent-employee-message', {
            messageId: message!.id,
            spaceId,
            orgId: user.org_id,
            employeeId: emp.id,
            isDM: spaceRow?.type === 'dm' || spaceRow?.type === 'agent_conversation',
          });
        }
      }
    } catch (err) {
      console.error('Failed to enqueue agent-employee-message:', err);
    }

    // Cross-reference detection — check for task identifier patterns like PROJ-42
    const TASK_ID_PATTERN = /([A-Z]+-\d+)/g;
    if (TASK_ID_PATTERN.test(normalizedContent)) {
      try {
        await enqueue(QUEUE_NAMES.AGENT_JOBS, 'cross-reference', {
          messageId: message!.id,
          spaceId,
          content: normalizedContent,
          orgId: user.org_id,
          userId: user.id,
        });
      } catch (err) {
        console.error('Failed to enqueue cross-reference job:', err);
      }
    }

    try {
      await enqueueChatObservation({
        orgId: user.org_id,
        messageId: message!.id,
        spaceId,
        userId: user.id,
      });
    } catch (err) {
      console.error('Failed to enqueue chat observation:', err);
    }

        // Blocked detection — enqueue alert if someone is blocked
    return c.json(messageWithUser, 201);
  } catch (err) {
    if (err instanceof AttachmentClaimError) {
      return c.json({ error: err.message, code: 'ATTACHMENT_NOT_FOUND' }, 404);
    }
    console.error('Failed to send message:', err);
    return c.json({ error: 'Failed to send message', code: 'INTERNAL_ERROR' }, 500);
  }
});

// PATCH /api/messages/:id — edit message
messageRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  const messageId = c.req.param('id');
  const body = await c.req.json();
  const { content } = body;

  if (!content) {
    return c.json({ error: 'Content required', code: 'VALIDATION_ERROR' }, 400);
  }

  const existing = await getVisibleMessage(messageId, user.org_id, user.id);
  if (!existing) {
    return c.json({ error: 'Message not found', code: 'NOT_FOUND' }, 404);
  }
  if (existing.user_id !== user.id) {
    return c.json({ error: 'Forbidden', code: 'FORBIDDEN' }, 403);
  }

  // Save previous version before editing
  await db.insert(messageVersions).values({
    message_id: messageId,
    content: existing.content,
    edited_at: existing.edited_at || existing.created_at,
  });

  const [updated] = await db.update(messages)
    .set({ content, edited_at: new Date() })
    .where(eq(messages.id, messageId))
    .returning();

  const io = getIO();
  if (io) {
    io.to(`space:${existing.space_id}`).emit('message:edited', updated);
  }

  return c.json(updated);
});

// DELETE /api/messages/:id — soft delete
messageRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const messageId = c.req.param('id');

  const existing = await getVisibleMessage(messageId, user.org_id, user.id);
  if (!existing) {
    return c.json({ error: 'Message not found', code: 'NOT_FOUND' }, 404);
  }
  if (existing.user_id !== user.id) {
    return c.json({ error: 'Forbidden', code: 'FORBIDDEN' }, 403);
  }

  const [deleted] = await db.update(messages)
    .set({ is_deleted: true })
    .where(eq(messages.id, messageId))
    .returning();

  const io = getIO();
  if (io) {
    io.to(`space:${existing.space_id}`).emit('message:deleted', { id: messageId, space_id: existing.space_id });
  }

  return c.json({ success: true });
});

// POST /api/messages/:id/reactions — add reaction
messageRoutes.post('/:id/reactions', async (c) => {
  try {
    const user = c.get('user');
    const messageId = c.req.param('id');
    const body = await c.req.json();
    const { emoji } = body;

    if (!emoji || typeof emoji !== 'string') {
      return c.json({ error: 'Emoji required', code: 'VALIDATION_ERROR' }, 400);
    }

    const msg = await getVisibleMessage(messageId, user.org_id, user.id);
    if (!msg) {
      return c.json({ error: 'Message not found', code: 'NOT_FOUND' }, 404);
    }

    // Check if reaction already exists (unique constraint)
    const [existing] = await db.select()
      .from(reactions)
      .where(
        and(
          eq(reactions.message_id, messageId),
          eq(reactions.user_id, user.id),
          eq(reactions.emoji, emoji),
        )
      )
      .limit(1);

    if (existing) {
      return c.json({ error: 'Reaction already exists', code: 'CONFLICT' }, 409);
    }

    const [reaction] = await db.insert(reactions).values({
      message_id: messageId,
      user_id: user.id,
      emoji,
    }).returning();

    const io = getIO();
    if (io) {
      io.to(`space:${msg.space_id}`).emit('reaction:added', {
        message_id: messageId,
        emoji,
        user_id: user.id,
      });
    }

    return c.json(reaction, 201);
  } catch (err) {
    console.error('Failed to add reaction:', err);
    return c.json({ error: 'Failed to add reaction', code: 'INTERNAL_ERROR' }, 500);
  }
});

// DELETE /api/messages/:id/reactions/:emoji — remove reaction
messageRoutes.delete('/:id/reactions/:emoji', async (c) => {
  try {
    const user = c.get('user');
    const messageId = c.req.param('id');
    const emoji = decodeURIComponent(c.req.param('emoji'));

    const msg = await getVisibleMessage(messageId, user.org_id, user.id);
    if (!msg) {
      return c.json({ error: 'Message not found', code: 'NOT_FOUND' }, 404);
    }

    const deleted = await db.delete(reactions)
      .where(
        and(
          eq(reactions.message_id, messageId),
          eq(reactions.user_id, user.id),
          eq(reactions.emoji, emoji),
        )
      )
      .returning();

    if (deleted.length === 0) {
      return c.json({ error: 'Reaction not found', code: 'NOT_FOUND' }, 404);
    }

    const io = getIO();
    if (io) {
      io.to(`space:${msg.space_id}`).emit('reaction:removed', {
        message_id: messageId,
        emoji,
        user_id: user.id,
      });
    }

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to remove reaction:', err);
    return c.json({ error: 'Failed to remove reaction', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/messages/:id/thread — get thread replies
messageRoutes.get('/:id/thread', async (c) => {
  try {
    const user = c.get('user');
    const messageId = c.req.param('id');

    const parentMsg = await getVisibleMessage(messageId, user.org_id, user.id);
    if (!parentMsg) {
      return c.json({ error: 'Message not found', code: 'NOT_FOUND' }, 404);
    }

    const replies = await db.select({
      id: messages.id,
      content: messages.content,
      space_id: messages.space_id,
      user_id: messages.user_id,
      parent_id: messages.parent_id,
      is_pinned: messages.is_pinned,
      is_deleted: messages.is_deleted,
      edited_at: messages.edited_at,
      metadata: messages.metadata,
      created_at: messages.created_at,
      user_name: users.name,
      user_avatar: users.avatar_url,
      user_timezone: users.timezone,
    })
      .from(messages)
      .innerJoin(users, eq(messages.user_id, users.id))
      .where(
        and(
          eq(messages.parent_id, messageId),
          eq(messages.org_id, user.org_id),
        )
      )
      .orderBy(messages.created_at);

    // Fetch reactions for parent + replies so deep-linked thread drawers can
    // hydrate from this endpoint without needing the parent message list first.
    const replyIds = replies.map((r) => r.id);
    const attachmentMessageIds = [parentMsg.id, ...replyIds];
    const [reactionsMap, attachmentsMap] = await Promise.all([
      getReactionsForMessages(attachmentMessageIds),
      getMessageAttachments(attachmentMessageIds, user.org_id),
    ]);
    const parentWithReactions = {
      ...parentMsg,
      reactions: reactionsMap.get(parentMsg.id) ?? [],
      file_ids: (attachmentsMap.get(parentMsg.id) ?? []).map((file) => file.id),
      files: attachmentsMap.get(parentMsg.id) ?? [],
    };

    const repliesWithReactions = replies.map((reply) => ({
      ...reply,
      reactions: reactionsMap.get(reply.id) ?? [],
      file_ids: (attachmentsMap.get(reply.id) ?? []).map((file) => file.id),
      files: attachmentsMap.get(reply.id) ?? [],
    }));

    return c.json({ parent: parentWithReactions, replies: repliesWithReactions });
  } catch (err) {
    console.error('Failed to fetch thread:', err);
    return c.json({ error: 'Failed to fetch thread', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/messages/:parentId/thread-read — mark thread as read
messageRoutes.post('/:parentId/thread-read', async (c) => {
  try {
    const user = c.get('user');
    const parentId = c.req.param('parentId');

    const parentMsg = await getVisibleMessage(parentId, user.org_id, user.id);
    if (!parentMsg) {
      return c.json({ error: 'Message not found', code: 'NOT_FOUND' }, 404);
    }

    await db.insert(threadReads).values({
      user_id: user.id,
      parent_message_id: parentId,
      last_read_at: new Date(),
    }).onConflictDoUpdate({
      target: [threadReads.user_id, threadReads.parent_message_id],
      set: { last_read_at: new Date() },
    });

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to mark thread read:', err);
    return c.json({ error: 'Failed to mark thread read', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/messages/:id/history — get edit history
messageRoutes.get('/:id/history', async (c) => {
  try {
    const user = c.get('user');
    const messageId = c.req.param('id');

    const msg = await getVisibleMessage(messageId, user.org_id, user.id);
    if (!msg) {
      return c.json({ error: 'Message not found', code: 'NOT_FOUND' }, 404);
    }

    const versions = await db.select({
      id: messageVersions.id,
      content: messageVersions.content,
      edited_at: messageVersions.edited_at,
    }).from(messageVersions)
      .where(eq(messageVersions.message_id, messageId))
      .orderBy(desc(messageVersions.edited_at));

    return c.json({ versions });
  } catch (err) {
    console.error('Failed to fetch message history:', err);
    return c.json({ error: 'Failed to fetch history', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /:spaceId/read-receipts — get read positions for all members
messageRoutes.get('/:spaceId/read-receipts', async (c) => {
  try {
    const user = c.get('user');
    const spaceId = c.req.param('spaceId');

    const isMember = await requireSpaceMembership(spaceId, user.id);
    if (!isMember) {
      return c.json({ error: 'Not a member of this space', code: 'FORBIDDEN' }, 403);
    }

    const receipts = await db.select({
      user_id: spaceMembers.user_id,
      user_name: users.name,
      user_avatar: users.avatar_url,
      last_read_at: spaceMembers.last_read_at,
      last_read_message_id: spaceMembers.last_read_message_id,
      show_read_receipts: users.show_read_receipts,
    })
      .from(spaceMembers)
      .innerJoin(users, eq(spaceMembers.user_id, users.id))
      .where(eq(spaceMembers.space_id, spaceId));

    // Filter out users who have disabled read receipts
    const visible = receipts.filter(r => r.show_read_receipts);

    return c.json({ receipts: visible });
  } catch (err) {
    console.error('Failed to fetch read receipts:', err);
    return c.json({ error: 'Failed to fetch read receipts', code: 'INTERNAL_ERROR' }, 500);
  }
});
