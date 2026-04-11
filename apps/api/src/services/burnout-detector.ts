// Service: Burnout Detection — detects signs of strain across org members
// PRIVACY: Never include message content in alerts. Only patterns.
import { db } from '../lib/db.js';
import { llm } from '../lib/llm.js';
import {
  orgMembers,
  users,
  orgs,
  messages,
  spaces,
  peoplePatterns,
  burnoutAlerts,
  managerSettings,
  notifications,
} from '@deft/db/schema';
import { eq, and, gte, sql, desc, ne } from 'drizzle-orm';
import { emitToUser } from '../socket.js';

interface BurnoutSignal {
  name: string;
  weight: number;
  detected: boolean;
  detail: string;
}

export async function detectBurnout(orgId: string): Promise<void> {
  // Get org timezone
  const [org] = await db
    .select({ timezone: orgs.timezone })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);

  const orgTimezone = org?.timezone ?? 'UTC';

  // Get all active org members
  const members = await db
    .select({
      userId: orgMembers.user_id,
      name: users.name,
      timezone: users.timezone,
      role: orgMembers.role,
    })
    .from(orgMembers)
    .innerJoin(users, eq(orgMembers.user_id, users.id))
    .where(
      and(
        eq(orgMembers.org_id, orgId),
        eq(orgMembers.is_active, true),
      ),
    );

  const now = new Date();
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  for (const member of members) {
    try {
      const signals: BurnoutSignal[] = [];

      // --- SIGNAL 1: Working hours shift (weight 0.2) ---
      const activeHoursPattern = await db
        .select()
        .from(peoplePatterns)
        .where(
          and(
            eq(peoplePatterns.org_id, orgId),
            eq(peoplePatterns.user_id, member.userId),
            eq(peoplePatterns.pattern_type, 'active_hours'),
          ),
        )
        .limit(1);

      const activeHours = activeHoursPattern[0];
      const currentPeakHour = (activeHours?.pattern_data as any)?.peak_hour;
      const baselinePeakHour = (activeHours?.baseline_data as any)?.peak_hour;

      let hoursShiftDetected = false;
      let hoursShiftDetail = 'No significant working hours shift detected';
      if (currentPeakHour != null && baselinePeakHour != null) {
        const shift = Math.abs(currentPeakHour - baselinePeakHour);
        if (shift >= 3) {
          hoursShiftDetected = true;
          hoursShiftDetail = `Peak working hours shifted by ${shift} hours from baseline`;
        }
      }

      signals.push({
        name: 'working_hours_shift',
        weight: 0.2,
        detected: hoursShiftDetected,
        detail: hoursShiftDetail,
      });

      // --- SIGNAL 2: Declining sentiment (weight 0.25) ---
      // PRIVACY: Only analyze PUBLIC messages, NOT DMs
      const publicMessages = await db
        .select({ content: messages.content })
        .from(messages)
        .innerJoin(spaces, eq(messages.space_id, spaces.id))
        .where(
          and(
            eq(messages.org_id, orgId),
            eq(messages.user_id, member.userId),
            eq(messages.is_deleted, false),
            gte(messages.created_at, fourteenDaysAgo),
            sql`${spaces.type} = 'public'`,
          ),
        )
        .orderBy(desc(messages.created_at))
        .limit(20);

      let sentimentDetected = false;
      let sentimentDetail = 'Insufficient data for sentiment analysis';

      if (publicMessages.length >= 5) {
        try {
          // PRIVACY: We send message content to LLM for sentiment scoring only.
          // The score is stored, never the messages themselves.
          const sentimentPrompt = `Rate the overall emotional sentiment of these messages on a scale from 0.0 (very negative/frustrated) to 1.0 (very positive/energetic). Only return a single decimal number, nothing else.

Messages (from a workplace chat):
${publicMessages.map((m, i) => `${i + 1}. ${m.content}`).join('\n')}`;

          const sentimentResponse = await llm({
            task: 'classify',
            messages: [{ role: 'user', content: sentimentPrompt }],
            maxTokens: 10,
          });

          const currentSentiment = parseFloat(sentimentResponse.text.trim());
          const baselineSentiment = (activeHours?.pattern_data as any)?.baseline_sentiment;

          if (!isNaN(currentSentiment)) {
            // Store current sentiment in pattern_data for future baseline comparisons
            const existingPatternData = (activeHours?.pattern_data as any) ?? {};
            if (baselineSentiment != null && currentSentiment < baselineSentiment - 0.3) {
              sentimentDetected = true;
              sentimentDetail = `Sentiment dropped from baseline ${baselineSentiment.toFixed(2)} to ${currentSentiment.toFixed(2)}`;
            } else {
              sentimentDetail = `Current sentiment: ${currentSentiment.toFixed(2)}`;
            }
          }
        } catch (err) {
          console.error(`[burnout-detect] Sentiment analysis failed for ${member.userId}:`, err);
          sentimentDetail = 'Sentiment analysis unavailable';
        }
      }

      signals.push({
        name: 'declining_sentiment',
        weight: 0.25,
        detected: sentimentDetected,
        detail: sentimentDetail,
      });

      // --- SIGNAL 3: Social withdrawal (weight 0.15) ---
      // Count messages in social/non-work spaces
      const [recentSocialRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(messages)
        .innerJoin(spaces, eq(messages.space_id, spaces.id))
        .where(
          and(
            eq(messages.org_id, orgId),
            eq(messages.user_id, member.userId),
            eq(messages.is_deleted, false),
            gte(messages.created_at, fourteenDaysAgo),
            sql`(LOWER(${spaces.name}) LIKE '%random%' OR LOWER(${spaces.name}) LIKE '%watercooler%' OR LOWER(${spaces.name}) LIKE '%social%' OR LOWER(${spaces.name}) LIKE '%fun%')`,
          ),
        );
      const recentSocialCount = Number(recentSocialRow?.count ?? 0);

      // 30-day baseline: average per 14-day window
      const [baselineSocialRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(messages)
        .innerJoin(spaces, eq(messages.space_id, spaces.id))
        .where(
          and(
            eq(messages.org_id, orgId),
            eq(messages.user_id, member.userId),
            eq(messages.is_deleted, false),
            gte(messages.created_at, thirtyDaysAgo),
            sql`(LOWER(${spaces.name}) LIKE '%random%' OR LOWER(${spaces.name}) LIKE '%watercooler%' OR LOWER(${spaces.name}) LIKE '%social%' OR LOWER(${spaces.name}) LIKE '%fun%')`,
          ),
        );
      const baselineSocialCount = Number(baselineSocialRow?.count ?? 0);
      // Normalize baseline to 14-day equivalent
      const baselinePer14Days = (baselineSocialCount / 30) * 14;

      let socialWithdrawalDetected = false;
      let socialWithdrawalDetail = 'Social engagement within normal range';

      if (baselinePer14Days > 2 && recentSocialCount < baselinePer14Days * 0.4) {
        socialWithdrawalDetected = true;
        const dropPercent = Math.round(((baselinePer14Days - recentSocialCount) / baselinePer14Days) * 100);
        socialWithdrawalDetail = `Social channel activity dropped ${dropPercent}% compared to 30-day baseline`;
      }

      signals.push({
        name: 'social_withdrawal',
        weight: 0.15,
        detected: socialWithdrawalDetected,
        detail: socialWithdrawalDetail,
      });

      // --- SIGNAL 4: Response time degradation (weight 0.15) ---
      const responseTimePattern = await db
        .select()
        .from(peoplePatterns)
        .where(
          and(
            eq(peoplePatterns.org_id, orgId),
            eq(peoplePatterns.user_id, member.userId),
            eq(peoplePatterns.pattern_type, 'response_time'),
          ),
        )
        .limit(1);

      const rtPattern = responseTimePattern[0];
      const currentRT = (rtPattern?.pattern_data as any)?.current_avg_seconds;
      const baselineRT = (rtPattern?.baseline_data as any)?.avg_seconds;

      let responseTimeDetected = false;
      let responseTimeDetail = 'Response time within normal range';

      if (currentRT != null && baselineRT != null && baselineRT > 0) {
        const increase = ((currentRT - baselineRT) / baselineRT) * 100;
        if (increase > 100) {
          responseTimeDetected = true;
          responseTimeDetail = `Response time increased ${Math.round(increase)}% over baseline`;
        }
      }

      signals.push({
        name: 'response_time_degradation',
        weight: 0.15,
        detected: responseTimeDetected,
        detail: responseTimeDetail,
      });

      // --- SIGNAL 5: Overwork (weight 0.25) ---
      // Count days with messages after 10 PM in user's timezone
      const userTimezone = member.timezone ?? orgTimezone;

      const [lateNightRow] = await db
        .select({ count: sql<number>`count(DISTINCT DATE(${messages.created_at} AT TIME ZONE ${userTimezone}))::int` })
        .from(messages)
        .where(
          and(
            eq(messages.org_id, orgId),
            eq(messages.user_id, member.userId),
            eq(messages.is_deleted, false),
            gte(messages.created_at, fourteenDaysAgo),
            sql`EXTRACT(HOUR FROM ${messages.created_at} AT TIME ZONE ${userTimezone}) >= 22`,
          ),
        );
      const lateNightDays = Number(lateNightRow?.count ?? 0);

      // Check if this is their normal pattern (baseline)
      const baselineLateNight = (activeHours?.baseline_data as any)?.late_night_days_per_14;
      const isNormalPattern = baselineLateNight != null && baselineLateNight >= 4;

      let overworkDetected = false;
      let overworkDetail = 'Work hours within normal range';

      if (lateNightDays >= 5 && !isNormalPattern) {
        overworkDetected = true;
        overworkDetail = `${lateNightDays} days with late-night activity (after 10 PM) in the last 14 days`;
      }

      signals.push({
        name: 'overwork',
        weight: 0.25,
        detected: overworkDetected,
        detail: overworkDetail,
      });

      // --- 5B: Score Calculation ---
      const burnoutScore = signals.reduce(
        (sum, signal) => sum + (signal.detected ? signal.weight : 0),
        0,
      );

      if (burnoutScore < 0.3) {
        // Ignore — no significant signals
        continue;
      }

      if (burnoutScore >= 0.3 && burnoutScore < 0.5) {
        // Log in peoplePatterns for tracking but don't alert
        await db
          .insert(peoplePatterns)
          .values({
            org_id: orgId,
            user_id: member.userId,
            pattern_type: 'activity_trend',
            pattern_data: {
              burnout_score: burnoutScore,
              signals: signals.filter((s) => s.detected).map((s) => s.name),
              recorded_at: now.toISOString(),
            },
          })
          .onConflictDoUpdate({
            target: [peoplePatterns.org_id, peoplePatterns.user_id, peoplePatterns.pattern_type],
            set: {
              pattern_data: sql`jsonb_set(COALESCE(${peoplePatterns.pattern_data}::jsonb, '{}'::jsonb), '{burnout_score}', ${sql.raw(`'${burnoutScore}'::jsonb`)})`,
            },
          });
        continue;
      }

      // --- 5C: Alert Generation (score >= 0.5) ---

      // Find the manager (org owner/admin)
      const managers = await db
        .select({ userId: orgMembers.user_id })
        .from(orgMembers)
        .where(
          and(
            eq(orgMembers.org_id, orgId),
            eq(orgMembers.is_active, true),
            sql`${orgMembers.role} IN ('owner', 'admin')`,
            ne(orgMembers.user_id, member.userId),
          ),
        );

      if (managers.length === 0) continue;

      const managerId = managers[0]!.userId;

      // PRIVACY: Generate a sensitive alert message. NEVER quote specific messages. Only describe patterns.
      let alertMessage: string;
      try {
        const alertPrompt = `You are generating a private, sensitive notification for a manager about a team member showing signs of strain.

Signals detected for ${member.name}:
${signals.filter((s) => s.detected).map((s) => `- ${s.detail}`).join('\n')}

Burnout score: ${burnoutScore.toFixed(2)} (0-1 scale)

RULES:
- NEVER quote specific messages. Only describe patterns.
- NEVER use the word "burnout". Frame as "signs of strain" or "changes in work patterns".
- Be empathetic and constructive.
- Suggest 1-2 concrete actions the manager can take.
- Keep it to 3-4 sentences.`;

        const alertResponse = await llm({
          task: 'summarize',
          messages: [{ role: 'user', content: alertPrompt }],
          maxTokens: 300,
        });

        alertMessage = alertResponse.text;
      } catch (err) {
        console.error(`[burnout-detect] LLM alert generation failed for ${member.userId}:`, err);
        const detectedSignals = signals.filter((s) => s.detected).map((s) => s.detail);
        alertMessage = `${member.name} is showing changes in work patterns that may indicate strain: ${detectedSignals.join('; ')}. Consider scheduling a casual check-in to see how they're doing.`;
      }

      // Insert burnout alert
      // PRIVACY: Never include message content in alerts. Only patterns.
      await db.insert(burnoutAlerts).values({
        org_id: orgId,
        user_id: member.userId,
        alerted_to: managerId,
        signals: signals.map((s) => ({
          name: s.name,
          weight: s.weight,
          detected: s.detected,
          detail: s.detail,
        })),
        confidence: burnoutScore,
        status: 'active',
      });

      // Check manager settings before notifying
      const [mgrSettings] = await db
        .select()
        .from(managerSettings)
        .where(
          and(
            eq(managerSettings.user_id, managerId),
            eq(managerSettings.org_id, orgId),
          ),
        )
        .limit(1);

      const burnoutAlertsEnabled = mgrSettings?.burnout_alerts_enabled ?? true;

      if (burnoutAlertsEnabled) {
        // Create notification for manager
        await db.insert(notifications).values({
          org_id: orgId,
          user_id: managerId,
          type: 'system',
          title: `Signs of strain detected for ${member.name}`,
          body: alertMessage,
          metadata: {
            type: 'burnout_alert',
            subject_user_id: member.userId,
            confidence: burnoutScore,
          },
        });

        // Emit via socket
        emitToUser(managerId, 'notification:new', {
          type: 'system',
          title: `Signs of strain detected for ${member.name}`,
          body: alertMessage,
        });
      }

      console.log(
        `[burnout-detect] Alert created for ${member.name} (score: ${burnoutScore.toFixed(2)}) — notified manager ${managerId}`,
      );
    } catch (err) {
      console.error(`[burnout-detect] Error processing member ${member.userId}:`, err);
      // Continue to next member
    }
  }
}
