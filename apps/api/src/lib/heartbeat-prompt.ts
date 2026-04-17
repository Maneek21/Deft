/**
 * Task 8.1 stub — `buildHeartbeatPrompt` is fleshed out in Task 8.2. This
 * file exists so the 8.1 dispatcher branch can `await import(...)` it
 * without a module-not-found error during the intermediate commit.
 *
 * Task 8.2 replaces this stub with the real checklist + context composer.
 */
import { and, eq } from 'drizzle-orm';
import { db } from './db.js';
import { agentEmployees } from '@deft/db/schema';

export type BuildHeartbeatPromptResult = {
  prompt: string;
  /** Machine-readable context forwarded through the trigger envelope. */
  context: Record<string, unknown>;
};

export async function buildHeartbeatPrompt(
  employeeId: string,
): Promise<BuildHeartbeatPromptResult> {
  const [employee] = await db
    .select()
    .from(agentEmployees)
    .where(and(eq(agentEmployees.id, employeeId)))
    .limit(1);

  if (!employee) {
    return {
      prompt: 'HEARTBEAT — employee row not found. Respond HEARTBEAT_OK.',
      context: {},
    };
  }

  const checklist =
    typeof employee.heartbeat_config === 'string'
      ? employee.heartbeat_config
      : (employee.heartbeat_config as { checklist?: string } | null)
          ?.checklist ?? 'Check if anything needs attention in your domain.';

  const prompt = `HEARTBEAT CHECK — scheduled wake-up.

## Checklist
${checklist}

## Instructions
1. Work through the checklist using your tools.
2. Act only on items that genuinely need attention right now.
3. If nothing needs attention, respond with HEARTBEAT_OK.`;

  return { prompt, context: { employee_id: employee.id, slug: employee.slug } };
}
