import { Hono } from 'hono';
import { eq, and, desc, gt } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { messages, users, spaceMembers, spaces } from '@deft/db/schema';
import { env } from '../lib/env.js';

export const recapRoutes = new Hono();

// POST /api/spaces/:spaceId/recap — generate AI summary of recent/unread messages
recapRoutes.post('/:spaceId/recap', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.param('spaceId');

  // Get user's last read position
  const [membership] = await db.select({ last_read_at: spaceMembers.last_read_at })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.space_id, spaceId), eq(spaceMembers.user_id, user.id)))
    .limit(1);

  const lastRead = membership?.last_read_at || new Date(0);

  // Try to fetch unread messages first
  let recentMessages = await db.select({
    content: messages.content,
    id: messages.id,
    user_name: users.name,
    created_at: messages.created_at,
  })
    .from(messages)
    .innerJoin(users, eq(messages.user_id, users.id))
    .where(and(
      eq(messages.space_id, spaceId),
      eq(messages.is_deleted, false),
      gt(messages.created_at, lastRead),
    ))
    .orderBy(messages.created_at)
    .limit(100);

  // If no unread messages (space was just marked read), summarize the latest 50 messages
  if (recentMessages.length === 0) {
    recentMessages = await db.select({
      content: messages.content,
      id: messages.id,
      user_name: users.name,
      created_at: messages.created_at,
    })
      .from(messages)
      .innerJoin(users, eq(messages.user_id, users.id))
      .where(and(
        eq(messages.space_id, spaceId),
        eq(messages.is_deleted, false),
      ))
      .orderBy(desc(messages.created_at))
      .limit(50);

    // Reverse to chronological order
    recentMessages.reverse();
  }

  if (recentMessages.length === 0) {
    return c.json({ summary: 'No messages in this channel yet.', message_count: 0 });
  }

  // Get space name for context
  const [space] = await db.select({ name: spaces.name }).from(spaces).where(eq(spaces.id, spaceId)).limit(1);

  // Build conversation text
  const conversationText = recentMessages.map(m => {
    const time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const content = m.content.replace(/<[^>]+>/g, '').replace(/\[\[file:[^\]]+\]\]/g, '[file]').slice(0, 300);
    return `[${time}] ${m.user_name}: ${content}`;
  }).join('\n');

  // Generate summary with AI (if key available)
  if (!env.ANTHROPIC_API_KEY) {
    const authors = [...new Set(recentMessages.map(m => m.user_name))];
    return c.json({
      summary: `${recentMessages.length} messages from ${authors.join(', ')}.`,
      message_count: recentMessages.length,
      authors,
    });
  }

  try {
    const { llm } = await import('../lib/llm.js');

    const response = await llm({
      task: 'summarize',
      messages: [{
        role: 'user',
        content: `Summarize the following team conversation from #${space?.name || 'chat'} concisely. Highlight: key decisions made, action items, questions that need answers, and important updates. Keep it under 150 words. Be direct — no filler.\n\n${conversationText}`,
      }],
      maxTokens: 300,
    });

    const summary = response.text || 'Unable to generate summary.';
    const model = response.model;

    const firstTime = recentMessages[0]?.created_at;
    const lastTime = recentMessages[recentMessages.length - 1]?.created_at;

    return c.json({
      summary,
      model,
      message_count: recentMessages.length,
      authors: [...new Set(recentMessages.map(m => m.user_name))],
      time_range: { from: firstTime, to: lastTime },
    });
  } catch (err) {
    console.error('Recap generation error:', err);
    return c.json({ error: 'Failed to generate recap', code: 'INTERNAL_ERROR' }, 500);
  }
});
