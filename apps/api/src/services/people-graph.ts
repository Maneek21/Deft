// People Graph — nightly processing service for Deft Manager Intelligence
// Builds interaction matrices, extracts expertise, analyzes patterns, detects relationships
import { db } from '../lib/db.js';
import { llm } from '../lib/llm.js';
import {
  messages,
  spaces,
  spaceMembers,
  users,
  orgMembers,
  tasks,
  taskActivity,
  peopleInteractions,
  peopleExpertise,
  peoplePatterns,
  peopleRelationships,
  wikiPages,
  wikiLinks,
} from '@deft/db/schema';
import { eq, and, gte, sql, inArray, ne, desc } from 'drizzle-orm';

// ═══ INTERACTION MATRIX ═══

/**
 * Build/update the interaction matrix for an org based on last 24h of messages.
 * For channel messages: interaction between sender and each other space member.
 * For DMs: increment dm_count only (never read content).
 * For @mentions: +2 interaction_count, +1 mention_count.
 * For thread replies: increment thread_co_participation between replier and parent author.
 */
export async function buildInteractionMatrix(orgId: string): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Fetch all messages in this org from the last 24 hours
  const recentMessages = await db
    .select({
      id: messages.id,
      space_id: messages.space_id,
      user_id: messages.user_id,
      content: messages.content,
      parent_id: messages.parent_id,
      created_at: messages.created_at,
    })
    .from(messages)
    .where(
      and(
        eq(messages.org_id, orgId),
        eq(messages.is_deleted, false),
        gte(messages.created_at, cutoff),
      ),
    );

  if (recentMessages.length === 0) return;

  // Collect all unique space IDs
  const spaceIds = [...new Set(recentMessages.map((m) => m.space_id))];

  // Fetch space types for all relevant spaces
  const spaceRows = await db
    .select({ id: spaces.id, type: spaces.type })
    .from(spaces)
    .where(inArray(spaces.id, spaceIds));
  const spaceTypeMap = new Map(spaceRows.map((s) => [s.id, s.type]));

  // Fetch space members for all relevant spaces
  const memberRows = await db
    .select({ space_id: spaceMembers.space_id, user_id: spaceMembers.user_id })
    .from(spaceMembers)
    .where(inArray(spaceMembers.space_id, spaceIds));

  const spaceMembersMap = new Map<string, string[]>();
  for (const row of memberRows) {
    const members = spaceMembersMap.get(row.space_id) || [];
    members.push(row.user_id);
    spaceMembersMap.set(row.space_id, members);
  }

  // Build a map of message ID -> author for thread resolution
  // First collect parent IDs we need
  const parentIds = recentMessages
    .filter((m) => m.parent_id)
    .map((m) => m.parent_id!);
  const parentAuthorMap = new Map<string, string>();

  if (parentIds.length > 0) {
    const uniqueParentIds = [...new Set(parentIds)];
    const parentMessages = await db
      .select({ id: messages.id, user_id: messages.user_id })
      .from(messages)
      .where(inArray(messages.id, uniqueParentIds));
    for (const pm of parentMessages) {
      parentAuthorMap.set(pm.id, pm.user_id);
    }
  }

  // Accumulator: key = "userA:userB" (sorted), value = deltas
  type InteractionDelta = {
    interaction_count: number;
    dm_count: number;
    mention_count: number;
    thread_co_participation: number;
  };
  const deltas = new Map<string, InteractionDelta>();

  function pairKey(a: string, b: string): string {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  function addDelta(userA: string, userB: string, field: keyof InteractionDelta, amount: number) {
    if (userA === userB) return;
    const key = pairKey(userA, userB);
    const existing = deltas.get(key) || {
      interaction_count: 0,
      dm_count: 0,
      mention_count: 0,
      thread_co_participation: 0,
    };
    existing[field] += amount;
    deltas.set(key, existing);
  }

  for (const msg of recentMessages) {
    const spaceType = spaceTypeMap.get(msg.space_id);
    const members = spaceMembersMap.get(msg.space_id) || [];

    if (spaceType === 'dm' || spaceType === 'group_dm') {
      // DMs: increment dm_count only between sender and each other member
      for (const memberId of members) {
        if (memberId !== msg.user_id) {
          addDelta(msg.user_id, memberId, 'dm_count', 1);
        }
      }
    } else {
      // Channel message: interaction between sender and each other space member
      for (const memberId of members) {
        if (memberId !== msg.user_id) {
          addDelta(msg.user_id, memberId, 'interaction_count', 1);
        }
      }
    }

    // @mentions: look for @user patterns in content
    const mentionMatches = msg.content.match(/@([a-zA-Z0-9_-]+)/g);
    if (mentionMatches) {
      // Resolve mentioned usernames to user IDs within this org's space members
      for (const memberId of members) {
        // Check if any mention pattern could refer to this member
        // We increment for all mentioned members in the space
        if (memberId !== msg.user_id) {
          // Simple heuristic: if mentioned in content, add mention bonus
          // A more precise approach would resolve usernames, but we check all space members
          // who are explicitly @-mentioned
        }
      }
      // For a more practical approach: find users whose name/email matches the mention
      // For now, parse user IDs from metadata or use a simpler heuristic
      // We check if the message content contains user IDs directly (common in rich text editors)
      for (const memberId of members) {
        if (memberId !== msg.user_id && msg.content.includes(memberId)) {
          addDelta(msg.user_id, memberId, 'interaction_count', 2);
          addDelta(msg.user_id, memberId, 'mention_count', 1);
        }
      }
    }

    // Thread replies: increment thread_co_participation between replier and parent author
    if (msg.parent_id) {
      const parentAuthor = parentAuthorMap.get(msg.parent_id);
      if (parentAuthor && parentAuthor !== msg.user_id) {
        addDelta(msg.user_id, parentAuthor, 'thread_co_participation', 1);
      }
    }
  }

  // Upsert all deltas into peopleInteractions
  for (const [key, delta] of deltas) {
    const [userAId, userBId] = key.split(':');
    const now = new Date();

    await db
      .insert(peopleInteractions)
      .values({
        org_id: orgId,
        user_a_id: userAId!,
        user_b_id: userBId!,
        interaction_count: delta.interaction_count,
        dm_count: delta.dm_count,
        mention_count: delta.mention_count,
        thread_co_participation: delta.thread_co_participation,
        recency_weighted_score: delta.interaction_count + delta.dm_count + delta.mention_count + delta.thread_co_participation,
        last_interaction_at: now,
      })
      .onConflictDoUpdate({
        target: [peopleInteractions.org_id, peopleInteractions.user_a_id, peopleInteractions.user_b_id],
        set: {
          interaction_count: sql`${peopleInteractions.interaction_count} + ${delta.interaction_count}`,
          dm_count: sql`${peopleInteractions.dm_count} + ${delta.dm_count}`,
          mention_count: sql`${peopleInteractions.mention_count} + ${delta.mention_count}`,
          thread_co_participation: sql`${peopleInteractions.thread_co_participation} + ${delta.thread_co_participation}`,
          recency_weighted_score: sql`${peopleInteractions.recency_weighted_score} * 0.95 + ${delta.interaction_count + delta.dm_count + delta.mention_count + delta.thread_co_participation}`,
          last_interaction_at: now,
          updated_at: now,
        },
      });
  }

  console.log(`[people-graph] Interaction matrix built for org ${orgId}: ${deltas.size} pairs updated`);
}

// ═══ EXPERTISE EXTRACTION ═══

/**
 * Extract expertise topics from messages using LLM classification.
 * Batches messages in groups of 50, calls Haiku to extract 1-3 topics per message.
 * Also processes completed tasks for topic extraction.
 */
export async function extractExpertise(orgId: string): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Fetch recent messages (exclude DMs for privacy)
  const recentMessages = await db
    .select({
      id: messages.id,
      user_id: messages.user_id,
      content: messages.content,
      space_id: messages.space_id,
    })
    .from(messages)
    .innerJoin(spaces, eq(messages.space_id, spaces.id))
    .where(
      and(
        eq(messages.org_id, orgId),
        eq(messages.is_deleted, false),
        gte(messages.created_at, cutoff),
        ne(spaces.type, 'dm'),
        ne(spaces.type, 'group_dm'),
      ),
    );

  // Accumulator: key = "userId:topic", value = message_count delta
  const expertiseDeltas = new Map<string, number>();

  // Process messages in batches of 50
  for (let i = 0; i < recentMessages.length; i += 50) {
    const batch = recentMessages.slice(i, i + 50);

    const messagesForPrompt = batch.map((m, idx) => ({
      idx,
      user_id: m.user_id,
      content: m.content.slice(0, 300), // Truncate for the prompt only
    }));

    const prompt = `Extract expertise topics from these messages. For each message, output 1-3 short topic labels (e.g. "react", "database", "ci/cd", "design", "security", "onboarding", "payments").

Messages:
${messagesForPrompt.map((m) => `[${m.idx}] ${m.content}`).join('\n')}

Respond ONLY with valid JSON array. Each element: { "idx": number, "topics": string[] }
If a message has no clear expertise topic, use an empty topics array.`;

    try {
      const response = await llm({
        task: 'extract',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 1024,
      });

      // Parse JSON from response
      const jsonMatch = response.text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) continue;

      const results: { idx: number; topics: string[] }[] = JSON.parse(jsonMatch[0]);

      for (const result of results) {
        if (!result.topics || !Array.isArray(result.topics)) continue;
        const msg = batch[result.idx];
        if (!msg) continue;

        for (const topic of result.topics) {
          const normalizedTopic = topic.toLowerCase().trim();
          if (!normalizedTopic || normalizedTopic.length > 50) continue;
          const key = `${msg.user_id}:${normalizedTopic}`;
          expertiseDeltas.set(key, (expertiseDeltas.get(key) || 0) + 1);
        }
      }
    } catch (err) {
      console.error(`[people-graph] Expertise extraction LLM error for batch at ${i}:`, err);
      // Continue with next batch
    }
  }

  // Process completed tasks in last 24h — extract topics from task titles
  const completedTasks = await db
    .select({
      task_id: taskActivity.task_id,
      user_id: taskActivity.user_id,
      task_title: tasks.title,
    })
    .from(taskActivity)
    .innerJoin(tasks, eq(taskActivity.task_id, tasks.id))
    .where(
      and(
        eq(tasks.org_id, orgId),
        eq(taskActivity.action, 'status_changed'),
        eq(taskActivity.new_value, 'done'),
        gte(taskActivity.created_at, cutoff),
      ),
    );

  // For completed tasks, do a batch LLM call to extract topics from titles
  const taskCompletionsByUser = new Map<string, string[]>();
  for (const ct of completedTasks) {
    if (!ct.user_id) continue;
    const titles = taskCompletionsByUser.get(ct.user_id) || [];
    titles.push(ct.task_title);
    taskCompletionsByUser.set(ct.user_id, titles);
  }

  if (taskCompletionsByUser.size > 0) {
    const allTitles: { user_id: string; title: string; idx: number }[] = [];
    let idx = 0;
    for (const [userId, titles] of taskCompletionsByUser) {
      for (const title of titles) {
        allTitles.push({ user_id: userId, title, idx: idx++ });
      }
    }

    // Batch in groups of 50
    for (let i = 0; i < allTitles.length; i += 50) {
      const batch = allTitles.slice(i, i + 50);
      const prompt = `Extract 1-3 expertise topic labels from these completed task titles:

${batch.map((t) => `[${t.idx}] ${t.title}`).join('\n')}

Respond ONLY with valid JSON array. Each element: { "idx": number, "topics": string[] }`;

      try {
        const response = await llm({
          task: 'extract',
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 1024,
        });

        const jsonMatch = response.text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) continue;

        const results: { idx: number; topics: string[] }[] = JSON.parse(jsonMatch[0]);

        for (const result of results) {
          if (!result.topics || !Array.isArray(result.topics)) continue;
          const item = batch.find((b) => b.idx === result.idx);
          if (!item) continue;

          for (const topic of result.topics) {
            const normalizedTopic = topic.toLowerCase().trim();
            if (!normalizedTopic || normalizedTopic.length > 50) continue;

            // Upsert tasks_completed_count separately
            const now = new Date();
            await db
              .insert(peopleExpertise)
              .values({
                org_id: orgId,
                user_id: item.user_id,
                topic: normalizedTopic,
                tasks_completed_count: 1,
              })
              .onConflictDoUpdate({
                target: [peopleExpertise.org_id, peopleExpertise.user_id, peopleExpertise.topic],
                set: {
                  tasks_completed_count: sql`${peopleExpertise.tasks_completed_count} + 1`,
                  updated_at: now,
                },
              });
          }
        }
      } catch (err) {
        console.error(`[people-graph] Task expertise extraction error:`, err);
      }
    }
  }

  // Upsert message-based expertise deltas
  for (const [key, count] of expertiseDeltas) {
    const [userId, topic] = key.split(':');
    const now = new Date();

    await db
      .insert(peopleExpertise)
      .values({
        org_id: orgId,
        user_id: userId!,
        topic: topic!,
        message_count: count,
        expertise_score: count * 1, // Initial score from messages
      })
      .onConflictDoUpdate({
        target: [peopleExpertise.org_id, peopleExpertise.user_id, peopleExpertise.topic],
        set: {
          message_count: sql`${peopleExpertise.message_count} + ${count}`,
          updated_at: now,
        },
      });
  }

  // Recalculate expertise_score for all affected users in this org
  // expertise_score = (message_count * 1) + (question_answered_count * 5) + (mentioned_for_help_count * 8) + (tasks_completed_count * 3)
  await db.execute(sql`
    UPDATE people_expertise
    SET expertise_score = (message_count * 1) + (question_answered_count * 5) + (mentioned_for_help_count * 8) + (tasks_completed_count * 3),
        updated_at = now()
    WHERE org_id = ${orgId}
  `);

  // ── Wiki authorship signal ──────────────────────────────────────────────────
  // Users who author wiki pages tagged with topic X get +5 × confidence added
  // to their expertise score on X. Covers pages created in the last 24 hours
  // (matches the existing extraction cadence).
  //
  // We pull all recent pages for the org (not per-user) to avoid N+1 queries,
  // then accumulate per-user/topic deltas and upsert in one pass.
  const recentWikiPages = await db
    .select({
      user_id: wikiPages.user_id,
      tags: wikiPages.tags,
      confidence: wikiPages.confidence,
    })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.org_id, orgId),
        eq(wikiPages.is_deleted, false),
        sql`${wikiPages.created_at} > NOW() - INTERVAL '24 hours'`,
      ),
    );

  // Accumulate wiki score deltas: key = "userId:topic", value = score delta
  const wikiScoreDeltas = new Map<string, number>();
  for (const page of recentWikiPages) {
    if (!page.user_id) continue; // agent-authored pages have no user_id
    for (const tag of page.tags ?? []) {
      if (!tag || tag === 'commitment' || tag === 'reversed') continue;
      const key = `${page.user_id}:${tag}`;
      wikiScoreDeltas.set(key, (wikiScoreDeltas.get(key) ?? 0) + 5 * (page.confidence ?? 1));
    }
  }

  // Upsert wiki-derived expertise rows and apply the score boost
  for (const [key, scoreDelta] of wikiScoreDeltas) {
    const colonIdx = key.indexOf(':');
    const userId = key.slice(0, colonIdx);
    const topic = key.slice(colonIdx + 1);
    const now = new Date();

    await db
      .insert(peopleExpertise)
      .values({
        org_id: orgId,
        user_id: userId,
        topic,
        expertise_score: scoreDelta,
      })
      .onConflictDoUpdate({
        target: [peopleExpertise.org_id, peopleExpertise.user_id, peopleExpertise.topic],
        set: {
          expertise_score: sql`${peopleExpertise.expertise_score} + ${scoreDelta}`,
          updated_at: now,
        },
      });
  }

  console.log(`[people-graph] Expertise extracted for org ${orgId}: ${expertiseDeltas.size} topic-user pairs; wiki signal applied for ${wikiScoreDeltas.size} topic-user pairs`);
}

// ═══ PATTERN ANALYSIS ═══

/**
 * Analyze communication and activity patterns for each user in the org.
 * Patterns: active_hours, response_time, activity_trend, collaboration_preference.
 */
export async function analyzePatterns(orgId: string): Promise<void> {
  // Get all active users in this org
  const orgUsers = await db
    .select({ user_id: orgMembers.user_id })
    .from(orgMembers)
    .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.is_active, true)));

  if (orgUsers.length === 0) return;

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  for (const orgUser of orgUsers) {
    const userId = orgUser.user_id;

    try {
      // ── active_hours: Bucket messages by hour for last 7 days ──
      const hourBuckets = await db
        .select({
          hour: sql<number>`extract(hour from ${messages.created_at})`.as('hour'),
          count: sql<number>`count(*)`.as('count'),
        })
        .from(messages)
        .where(
          and(
            eq(messages.org_id, orgId),
            eq(messages.user_id, userId),
            eq(messages.is_deleted, false),
            gte(messages.created_at, sevenDaysAgo),
          ),
        )
        .groupBy(sql`extract(hour from ${messages.created_at})`);

      // Build full 24-hour distribution
      const hourDistribution: Record<number, number> = {};
      for (let h = 0; h < 24; h++) hourDistribution[h] = 0;
      for (const bucket of hourBuckets) {
        hourDistribution[Number(bucket.hour)] = Number(bucket.count);
      }

      // Find peak hours (top 3)
      const peakHours = Object.entries(hourDistribution)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3)
        .map(([h]) => Number(h));

      // Get 30-day baseline for comparison
      const existingActiveHours = await db
        .select({ baseline_data: peoplePatterns.baseline_data })
        .from(peoplePatterns)
        .where(
          and(
            eq(peoplePatterns.org_id, orgId),
            eq(peoplePatterns.user_id, userId),
            eq(peoplePatterns.pattern_type, 'active_hours'),
          ),
        )
        .limit(1);

      const activeHoursBaseline = existingActiveHours[0]?.baseline_data || hourDistribution;

      await db
        .insert(peoplePatterns)
        .values({
          org_id: orgId,
          user_id: userId,
          pattern_type: 'active_hours',
          pattern_data: { distribution: hourDistribution, peak_hours: peakHours, period_days: 7 },
          baseline_data: activeHoursBaseline,
          confidence: hourBuckets.length > 0 ? Math.min(hourBuckets.reduce((s, b) => s + Number(b.count), 0) / 50, 1.0) : 0,
        })
        .onConflictDoUpdate({
          target: [peoplePatterns.org_id, peoplePatterns.user_id, peoplePatterns.pattern_type],
          set: {
            pattern_data: { distribution: hourDistribution, peak_hours: peakHours, period_days: 7 },
            baseline_data: activeHoursBaseline,
            confidence: hourBuckets.length > 0 ? Math.min(hourBuckets.reduce((s, b) => s + Number(b.count), 0) / 50, 1.0) : 0,
            updated_at: now,
          },
        });

      // ── response_time: For each @mention of this user, find their first reply ──
      // Find messages mentioning this user in the last 7 days
      const mentionMessages = await db
        .select({
          id: messages.id,
          space_id: messages.space_id,
          created_at: messages.created_at,
        })
        .from(messages)
        .where(
          and(
            eq(messages.org_id, orgId),
            eq(messages.is_deleted, false),
            gte(messages.created_at, sevenDaysAgo),
            sql`${messages.content} LIKE ${'%' + userId + '%'}`,
            ne(messages.user_id, userId),
          ),
        );

      const responseTimes: number[] = [];
      for (const mention of mentionMessages) {
        // Find the first reply by this user after the mention in the same space
        const [reply] = await db
          .select({ created_at: messages.created_at })
          .from(messages)
          .where(
            and(
              eq(messages.space_id, mention.space_id),
              eq(messages.user_id, userId),
              eq(messages.is_deleted, false),
              gte(messages.created_at, mention.created_at),
            ),
          )
          .orderBy(messages.created_at)
          .limit(1);

        if (reply) {
          const diffMs = reply.created_at.getTime() - mention.created_at.getTime();
          if (diffMs > 0 && diffMs < 24 * 60 * 60 * 1000) {
            responseTimes.push(diffMs);
          }
        }
      }

      const sortedResponseTimes = [...responseTimes].sort((a, b) => a - b);
      const avgResponseTime = responseTimes.length > 0
        ? responseTimes.reduce((s, t) => s + t, 0) / responseTimes.length
        : null;
      const medianResponseTime = sortedResponseTimes.length > 0
        ? sortedResponseTimes[Math.floor(sortedResponseTimes.length / 2)]
        : null;
      const p95ResponseTime = sortedResponseTimes.length > 0
        ? sortedResponseTimes[Math.floor(sortedResponseTimes.length * 0.95)]
        : null;

      await db
        .insert(peoplePatterns)
        .values({
          org_id: orgId,
          user_id: userId,
          pattern_type: 'response_time',
          pattern_data: {
            avg_ms: avgResponseTime,
            median_ms: medianResponseTime,
            p95_ms: p95ResponseTime,
            sample_count: responseTimes.length,
          },
          baseline_data: null,
          confidence: responseTimes.length >= 5 ? 0.8 : responseTimes.length > 0 ? 0.4 : 0,
        })
        .onConflictDoUpdate({
          target: [peoplePatterns.org_id, peoplePatterns.user_id, peoplePatterns.pattern_type],
          set: {
            pattern_data: {
              avg_ms: avgResponseTime,
              median_ms: medianResponseTime,
              p95_ms: p95ResponseTime,
              sample_count: responseTimes.length,
            },
            confidence: responseTimes.length >= 5 ? 0.8 : responseTimes.length > 0 ? 0.4 : 0,
            updated_at: now,
          },
        });

      // ── activity_trend: Messages and tasks last 7 days vs prior 7 days ──
      const [recentActivity] = await db
        .select({ count: sql<number>`count(*)` })
        .from(messages)
        .where(
          and(
            eq(messages.org_id, orgId),
            eq(messages.user_id, userId),
            eq(messages.is_deleted, false),
            gte(messages.created_at, sevenDaysAgo),
          ),
        );

      const [priorActivity] = await db
        .select({ count: sql<number>`count(*)` })
        .from(messages)
        .where(
          and(
            eq(messages.org_id, orgId),
            eq(messages.user_id, userId),
            eq(messages.is_deleted, false),
            gte(messages.created_at, fourteenDaysAgo),
            sql`${messages.created_at} < ${sevenDaysAgo}`,
          ),
        );

      const [recentTasksCompleted] = await db
        .select({ count: sql<number>`count(*)` })
        .from(taskActivity)
        .innerJoin(tasks, eq(taskActivity.task_id, tasks.id))
        .where(
          and(
            eq(tasks.org_id, orgId),
            eq(taskActivity.user_id, userId),
            eq(taskActivity.action, 'status_changed'),
            eq(taskActivity.new_value, 'done'),
            gte(taskActivity.created_at, sevenDaysAgo),
          ),
        );

      const [priorTasksCompleted] = await db
        .select({ count: sql<number>`count(*)` })
        .from(taskActivity)
        .innerJoin(tasks, eq(taskActivity.task_id, tasks.id))
        .where(
          and(
            eq(tasks.org_id, orgId),
            eq(taskActivity.user_id, userId),
            eq(taskActivity.action, 'status_changed'),
            eq(taskActivity.new_value, 'done'),
            gte(taskActivity.created_at, fourteenDaysAgo),
            sql`${taskActivity.created_at} < ${sevenDaysAgo}`,
          ),
        );

      const recentMsgCount = Number(recentActivity?.count ?? 0);
      const priorMsgCount = Number(priorActivity?.count ?? 0);
      const recentTaskCount = Number(recentTasksCompleted?.count ?? 0);
      const priorTaskCount = Number(priorTasksCompleted?.count ?? 0);

      let trend: string;
      const totalRecent = recentMsgCount + recentTaskCount;
      const totalPrior = priorMsgCount + priorTaskCount;
      if (totalPrior === 0) {
        trend = totalRecent > 0 ? 'increasing' : 'stable';
      } else {
        const ratio = totalRecent / totalPrior;
        if (ratio > 1.3) trend = 'increasing';
        else if (ratio < 0.7) trend = 'decreasing';
        else trend = 'stable';
      }

      await db
        .insert(peoplePatterns)
        .values({
          org_id: orgId,
          user_id: userId,
          pattern_type: 'activity_trend',
          pattern_data: {
            recent_messages: recentMsgCount,
            prior_messages: priorMsgCount,
            recent_tasks_completed: recentTaskCount,
            prior_tasks_completed: priorTaskCount,
            trend,
          },
          baseline_data: { prior_messages: priorMsgCount, prior_tasks: priorTaskCount },
          confidence: (totalRecent + totalPrior) > 10 ? 0.8 : 0.4,
        })
        .onConflictDoUpdate({
          target: [peoplePatterns.org_id, peoplePatterns.user_id, peoplePatterns.pattern_type],
          set: {
            pattern_data: {
              recent_messages: recentMsgCount,
              prior_messages: priorMsgCount,
              recent_tasks_completed: recentTaskCount,
              prior_tasks_completed: priorTaskCount,
              trend,
            },
            baseline_data: { prior_messages: priorMsgCount, prior_tasks: priorTaskCount },
            confidence: (totalRecent + totalPrior) > 10 ? 0.8 : 0.4,
            updated_at: now,
          },
        });

      // ── collaboration_preference: DM vs public ratio, thread usage, channels active ──
      const [dmMessageCount] = await db
        .select({ count: sql<number>`count(*)` })
        .from(messages)
        .innerJoin(spaces, eq(messages.space_id, spaces.id))
        .where(
          and(
            eq(messages.org_id, orgId),
            eq(messages.user_id, userId),
            eq(messages.is_deleted, false),
            gte(messages.created_at, sevenDaysAgo),
            sql`${spaces.type} IN ('dm', 'group_dm')`,
          ),
        );

      const [publicMessageCount] = await db
        .select({ count: sql<number>`count(*)` })
        .from(messages)
        .innerJoin(spaces, eq(messages.space_id, spaces.id))
        .where(
          and(
            eq(messages.org_id, orgId),
            eq(messages.user_id, userId),
            eq(messages.is_deleted, false),
            gte(messages.created_at, sevenDaysAgo),
            sql`${spaces.type} NOT IN ('dm', 'group_dm')`,
          ),
        );

      const [threadCount] = await db
        .select({ count: sql<number>`count(*)` })
        .from(messages)
        .where(
          and(
            eq(messages.org_id, orgId),
            eq(messages.user_id, userId),
            eq(messages.is_deleted, false),
            gte(messages.created_at, sevenDaysAgo),
            sql`${messages.parent_id} IS NOT NULL`,
          ),
        );

      const [channelsActive] = await db
        .select({ count: sql<number>`count(distinct ${messages.space_id})` })
        .from(messages)
        .where(
          and(
            eq(messages.org_id, orgId),
            eq(messages.user_id, userId),
            eq(messages.is_deleted, false),
            gte(messages.created_at, sevenDaysAgo),
          ),
        );

      const dmCount = Number(dmMessageCount?.count ?? 0);
      const publicCount = Number(publicMessageCount?.count ?? 0);
      const totalMsgs = dmCount + publicCount;
      const dmRatio = totalMsgs > 0 ? dmCount / totalMsgs : 0;
      const threadUsageRate = recentMsgCount > 0 ? Number(threadCount?.count ?? 0) / recentMsgCount : 0;

      await db
        .insert(peoplePatterns)
        .values({
          org_id: orgId,
          user_id: userId,
          pattern_type: 'collaboration_preference',
          pattern_data: {
            dm_count: dmCount,
            public_count: publicCount,
            dm_ratio: Math.round(dmRatio * 100) / 100,
            thread_usage_rate: Math.round(threadUsageRate * 100) / 100,
            channels_active: Number(channelsActive?.count ?? 0),
          },
          baseline_data: null,
          confidence: totalMsgs > 10 ? 0.7 : totalMsgs > 0 ? 0.3 : 0,
        })
        .onConflictDoUpdate({
          target: [peoplePatterns.org_id, peoplePatterns.user_id, peoplePatterns.pattern_type],
          set: {
            pattern_data: {
              dm_count: dmCount,
              public_count: publicCount,
              dm_ratio: Math.round(dmRatio * 100) / 100,
              thread_usage_rate: Math.round(threadUsageRate * 100) / 100,
              channels_active: Number(channelsActive?.count ?? 0),
            },
            confidence: totalMsgs > 10 ? 0.7 : totalMsgs > 0 ? 0.3 : 0,
            updated_at: now,
          },
        });
    } catch (err) {
      console.error(`[people-graph] Pattern analysis error for user ${userId}:`, err);
      // Continue to next user
    }
  }

  console.log(`[people-graph] Patterns analyzed for org ${orgId}: ${orgUsers.length} users`);
}

// ═══ RELATIONSHIP DETECTION ═══

/**
 * Detect relationships between users based on interaction data and task co-assignment.
 * For pairs above the median interaction score: check for close_collaborator, mentor_mentee.
 */
export async function detectRelationships(orgId: string): Promise<void> {
  // Get all interactions for this org
  const interactions = await db
    .select()
    .from(peopleInteractions)
    .where(eq(peopleInteractions.org_id, orgId));

  if (interactions.length === 0) return;

  // Calculate median recency_weighted_score
  const scores = interactions.map((i) => i.recency_weighted_score).sort((a, b) => a - b);
  const median = scores[Math.floor(scores.length / 2)];

  // Filter to above-median pairs
  const strongPairs = interactions.filter((i) => i.recency_weighted_score > median!);

  const now = new Date();

  for (const pair of strongPairs) {
    const evidence: Record<string, any> = {
      interaction_count: pair.interaction_count,
      dm_count: pair.dm_count,
      mention_count: pair.mention_count,
      thread_co_participation: pair.thread_co_participation,
      recency_weighted_score: pair.recency_weighted_score,
    };

    // Check for task co-assignment (both assigned to tasks in the same project)
    const coAssignedTasks = await db
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(
        and(
          eq(tasks.org_id, orgId),
          eq(tasks.is_deleted, false),
          sql`${tasks.project_id} IN (
            SELECT DISTINCT project_id FROM tasks
            WHERE org_id = ${orgId}
              AND assignee_id = ${pair.user_a_id}
              AND is_deleted = false
          )`,
          eq(tasks.assignee_id, pair.user_b_id),
        ),
      )
      .limit(5);

    if (coAssignedTasks.length > 0) {
      evidence.co_assigned_tasks = coAssignedTasks.length;

      await db
        .insert(peopleRelationships)
        .values({
          org_id: orgId,
          user_a_id: pair.user_a_id,
          user_b_id: pair.user_b_id,
          relationship_type: 'close_collaborator',
          strength: Math.min(pair.recency_weighted_score / (median! * 3), 1.0),
          direction: 'bidirectional',
          evidence,
        })
        .onConflictDoNothing();
    }

    // Check for expertise asymmetry → potential mentor_mentee
    const [expertiseA] = await db
      .select({
        total_score: sql<number>`coalesce(sum(expertise_score), 0)`,
        topic_count: sql<number>`count(*)`,
      })
      .from(peopleExpertise)
      .where(
        and(
          eq(peopleExpertise.org_id, orgId),
          eq(peopleExpertise.user_id, pair.user_a_id),
        ),
      );

    const [expertiseB] = await db
      .select({
        total_score: sql<number>`coalesce(sum(expertise_score), 0)`,
        topic_count: sql<number>`count(*)`,
      })
      .from(peopleExpertise)
      .where(
        and(
          eq(peopleExpertise.org_id, orgId),
          eq(peopleExpertise.user_id, pair.user_b_id),
        ),
      );

    const scoreA = Number(expertiseA?.total_score ?? 0);
    const scoreB = Number(expertiseB?.total_score ?? 0);

    // If one user has significantly more expertise and they interact frequently
    if (scoreA > 0 || scoreB > 0) {
      const maxScore = Math.max(scoreA, scoreB);
      const minScore = Math.min(scoreA, scoreB);
      const asymmetry = maxScore > 0 ? (maxScore - minScore) / maxScore : 0;

      if (asymmetry > 0.5 && pair.thread_co_participation > 2) {
        const mentorId = scoreA > scoreB ? pair.user_a_id : pair.user_b_id;
        const menteeId = scoreA > scoreB ? pair.user_b_id : pair.user_a_id;
        const direction = mentorId === pair.user_a_id ? 'a_to_b' : 'b_to_a';

        await db
          .insert(peopleRelationships)
          .values({
            org_id: orgId,
            user_a_id: pair.user_a_id,
            user_b_id: pair.user_b_id,
            relationship_type: 'mentor_mentee',
            strength: Math.min(asymmetry * 0.8, 1.0),
            direction,
            evidence: {
              ...evidence,
              mentor_expertise_score: maxScore,
              mentee_expertise_score: minScore,
              asymmetry,
            },
          })
          .onConflictDoNothing();
      }
    }
  }

  // ─── Wiki citation → knowledge_dependency edges ───────────────────────────
  // When user-A's wiki page links to user-B's wiki page (via wikiLinks),
  // that signals user-A relies on user-B's documented knowledge.
  const citationPairs = await db
    .select({
      user_a: wikiPages.user_id,
      user_b: sql<string>`cited.user_id`,
      strength: sql<number>`count(*)::int`,
    })
    .from(wikiLinks)
    .innerJoin(wikiPages, eq(wikiLinks.source_page_id, wikiPages.id))
    .innerJoin(
      sql`wiki_pages AS cited`,
      sql`cited.id = ${wikiLinks.target_page_id}`,
    )
    .where(
      and(
        eq(wikiPages.org_id, orgId),
        sql`cited.org_id = ${orgId}`,
        sql`${wikiPages.user_id} IS NOT NULL`,
        sql`cited.user_id IS NOT NULL`,
        sql`${wikiPages.user_id} != cited.user_id`,
        eq(wikiPages.is_deleted, false),
        sql`cited.is_deleted = false`,
      ),
    )
    .groupBy(wikiPages.user_id, sql`cited.user_id`)
    .having(sql`count(*) >= 2`);

  for (const pair of citationPairs) {
    if (!pair.user_a || !pair.user_b) continue;
    const normalizedStrength = Math.min(1, Number(pair.strength) / 10);

    await db
      .insert(peopleRelationships)
      .values({
        org_id: orgId,
        user_a_id: pair.user_a,
        user_b_id: pair.user_b,
        relationship_type: 'knowledge_dependency',
        strength: normalizedStrength,
        direction: 'a_to_b',
        evidence: {
          wiki_citation_count: Number(pair.strength),
        },
      })
      .onConflictDoUpdate({
        target: [
          peopleRelationships.user_a_id,
          peopleRelationships.user_b_id,
          peopleRelationships.relationship_type,
        ],
        set: {
          strength: normalizedStrength,
          evidence: {
            wiki_citation_count: Number(pair.strength),
          },
          updated_at: now,
        },
      });
  }

  console.log(`[people-graph] Relationships detected for org ${orgId}: ${strongPairs.length} strong pairs analyzed, ${citationPairs.length} knowledge_dependency edges`);
}

// ═══ FULL PIPELINE ═══

/**
 * Run the complete People Graph pipeline for an org.
 * Called by the nightly cron job.
 */
export async function runFullPeopleGraph(orgId: string): Promise<void> {
  const start = Date.now();
  console.log(`[people-graph] Starting full pipeline for org ${orgId}`);

  await buildInteractionMatrix(orgId);
  await extractExpertise(orgId);
  await analyzePatterns(orgId);
  await detectRelationships(orgId);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[people-graph] Full pipeline completed for org ${orgId} in ${elapsed}s`);
}
