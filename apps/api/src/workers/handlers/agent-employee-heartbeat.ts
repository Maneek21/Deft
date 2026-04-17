// Handler: agent-employee-heartbeat — runs periodic checks for proactive agent employees.
//
// Task 8.1 extended the handler to route by `employee.kind`:
//   - native / claude_sdk → `runAgentQuery` in background mode (legacy path)
//   - openclaw / custom_mcp → `dispatchHeartbeat` over the Gateway SSE channel
//
// The poller still walks every due employee in one sweep. The caller's cron
// name (`heartbeat-native` vs `heartbeat-openclaw`) filters the SQL so the
// two cadences can be tuned independently without clobbering each other.
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { agentEmployees, orgs } from '@deft/db/schema';
import { eq, and, or, inArray, sql } from 'drizzle-orm';
import { runAgentQuery } from '../../lib/agent-runner.js';
import { dispatchHeartbeat } from '../../lib/openclaw-dispatch.js';

type HeartbeatScope = 'native' | 'openclaw' | 'all';

function scopeFromJob(job: JobData): HeartbeatScope {
  if (job.name === 'heartbeat-native') return 'native';
  if (job.name === 'heartbeat-openclaw') return 'openclaw';
  return 'all';
}

export async function handleAgentEmployeeHeartbeat(job: JobData): Promise<void> {
  const scope = scopeFromJob(job);
  const now = new Date();

  const kindFilter =
    scope === 'native'
      ? or(
          eq(agentEmployees.kind, 'native'),
          eq(agentEmployees.kind, 'claude_sdk'),
        )
      : scope === 'openclaw'
        ? or(
            eq(agentEmployees.kind, 'openclaw'),
            eq(agentEmployees.kind, 'custom_mcp'),
          )
        : sql`TRUE`;

  const dueEmployees = await db
    .select()
    .from(agentEmployees)
    .where(
      and(
        eq(agentEmployees.is_active, true),
        eq(agentEmployees.heartbeat_enabled, true),
        sql`(${agentEmployees.last_heartbeat_at} IS NULL OR ${agentEmployees.last_heartbeat_at} + (${agentEmployees.heartbeat_interval_min} || ' minutes')::interval < NOW())`,
        kindFilter,
      ),
    );

  console.log(
    `[heartbeat] scope=${scope} found ${dueEmployees.length} employee(s) due`,
  );

  for (const employee of dueEmployees) {
    // ─── Guards that apply to every kind ────────────────────────────────
    if (employee.daily_action_count >= employee.max_daily_actions) {
      console.log(
        `[heartbeat] ${employee.slug}: daily action limit reached, skipping`,
      );
      continue;
    }

    const isOpenClawShaped =
      employee.kind === 'openclaw' || employee.kind === 'custom_mcp';

    // Gateway-connected kinds must be `connected` before we ping. A
    // Gateway in `error`/`revoked`/`pending` will only produce failures
    // that spam the inspector. The `gateway-ping` cron is the authority
    // for when this flips back.
    if (isOpenClawShaped && employee.connection_status !== 'connected') {
      console.log(
        `[heartbeat] ${employee.slug}: connection_status=${employee.connection_status}, skipping`,
      );
      continue;
    }

    const [org] = await db
      .select({ name: orgs.name })
      .from(orgs)
      .where(eq(orgs.id, employee.org_id))
      .limit(1);
    const orgName = org?.name ?? 'Unknown';

    try {
      if (isOpenClawShaped) {
        // Task 8.2 gives us a richer prompt composer. For 8.1 we fall
        // back to the existing checklist → template path so the
        // dispatcher branch is exercisable in isolation.
        const { buildHeartbeatPrompt } = await import(
          '../../lib/heartbeat-prompt.js'
        );
        const { prompt, context } = await buildHeartbeatPrompt(employee.id);
        await dispatchHeartbeat({ employee, prompt, context });
      } else {
        const heartbeatConfig =
          typeof employee.heartbeat_config === 'string'
            ? employee.heartbeat_config
            : (employee.heartbeat_config as { checklist?: string } | null)
                ?.checklist ?? 'Check if anything needs attention in your domain.';

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

        if (result.text?.trim() !== 'HEARTBEAT_OK') {
          console.log(
            `[heartbeat] ${employee.slug}: ${result.text?.slice(0, 100)}`,
          );
        }
      }

      await db
        .update(agentEmployees)
        .set({ last_heartbeat_at: now })
        .where(eq(agentEmployees.id, employee.id));
    } catch (err) {
      console.error(`[heartbeat] Error for ${employee.slug}:`, err);
      // Still stamp last_heartbeat_at to prevent retry storms — the
      // gateway-ping loop or the unhealthy flag (task 8.5) will flag
      // persistent failures.
      await db
        .update(agentEmployees)
        .set({ last_heartbeat_at: now })
        .where(eq(agentEmployees.id, employee.id));
    }
  }
}

// Exported for test-suite convenience — lets Phase 8 tests assert which
// kinds the handler routes to which runtime without re-deriving the filter.
export const HEARTBEAT_OPENCLAW_KINDS = ['openclaw', 'custom_mcp'] as const;
export const HEARTBEAT_NATIVE_KINDS = ['native', 'claude_sdk'] as const;

// Re-export so tests + future callers can import a stable symbol even if
// the local helper is renamed.
export { dispatchHeartbeat };

// Silence unused-import warning from `inArray` — retained for future use
// by task 8.7 (trigger-dispatch's batch scan).
void inArray;
