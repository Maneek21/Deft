// Handler: agent-employee-heartbeat — runs periodic checks for proactive agent employees
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { agentEmployees, orgs } from '@deft/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { runAgentQuery } from '../../lib/agent-runner.js';

export async function handleAgentEmployeeHeartbeat(_job: JobData): Promise<void> {
  const now = new Date();

  // Find employees with heartbeat due
  const dueEmployees = await db
    .select()
    .from(agentEmployees)
    .where(
      and(
        eq(agentEmployees.is_active, true),
        eq(agentEmployees.heartbeat_enabled, true),
        sql`(${agentEmployees.last_heartbeat_at} IS NULL OR ${agentEmployees.last_heartbeat_at} + (${agentEmployees.heartbeat_interval_min} || ' minutes')::interval < NOW())`,
      ),
    );

  console.log(`[heartbeat] Found ${dueEmployees.length} employee(s) due for heartbeat`);

  for (const employee of dueEmployees) {
    if (employee.daily_action_count >= employee.max_daily_actions) {
      console.log(`[heartbeat] ${employee.name}: daily action limit reached, skipping`);
      continue;
    }

    const [org] = await db.select({ name: orgs.name })
      .from(orgs)
      .where(eq(orgs.id, employee.org_id))
      .limit(1);

    const orgName = org?.name ?? 'Unknown';

    const heartbeatConfig = typeof employee.heartbeat_config === 'string'
      ? employee.heartbeat_config
      : (employee.heartbeat_config as { checklist?: string } | null)?.checklist
        ?? 'Check if anything needs attention in your domain.';

    const heartbeatPrompt = `HEARTBEAT CHECK — You are waking up for a scheduled check.

## Your Heartbeat Checklist:
${heartbeatConfig}

## Instructions:
1. Go through each item in your checklist
2. Use your tools to check the current state
3. If something needs attention: take action (post in channels, create tasks, DM people)
4. If nothing needs attention: respond with exactly HEARTBEAT_OK

Be concise. Only act on things that genuinely need attention right now.`;

    const augmentedPrompt = `${employee.system_prompt}

## Your Identity
You are ${employee.name}, a ${employee.role.replace(/_/g, ' ')} at ${orgName}.
${employee.expertise_description ? `Your expertise: ${employee.expertise_description}` : ''}`;

    try {
      const result = await runAgentQuery({
        content: heartbeatPrompt,
        orgId: employee.org_id,
        userId: employee.user_id,
        orgName,
        mode: 'background',
        systemPromptOverride: augmentedPrompt,
        trustLevelOverride: employee.trust_level,
        agentEmployeeId: employee.id,
      });

      await db.update(agentEmployees).set({
        last_heartbeat_at: now,
      }).where(eq(agentEmployees.id, employee.id));

      if (result.text?.trim() !== 'HEARTBEAT_OK') {
        console.log(`[heartbeat] ${employee.name}: ${result.text?.slice(0, 100)}`);
      }
    } catch (err) {
      console.error(`[heartbeat] Error for ${employee.name}:`, err);
      // Still update last_heartbeat_at to prevent retry storms
      await db.update(agentEmployees).set({ last_heartbeat_at: now })
        .where(eq(agentEmployees.id, employee.id));
    }
  }
}
