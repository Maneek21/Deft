/**
 * Seed starter prompts onto existing agent employees.
 *
 * Run: pnpm --filter @deft/api exec tsx src/scripts/seed-starter-prompts.ts
 */
import { db } from '../lib/db.js';
import { agentEmployees } from '@deft/db/schema';
import { eq } from 'drizzle-orm';

const PROMPTS_BY_ROLE: Record<string, string[]> = {
  project_manager: [
    "What's overdue?",
    "Who's blocked right now?",
    "Draft today's standup",
    "Summarize last sprint's wins",
    "Which tasks need my attention?",
  ],
  engineering_lead: [
    "What PRs need review?",
    "Any CI failures today?",
    "Summarize this week's merges",
    "Who's pairing on what?",
    "What's in the backlog for next sprint?",
  ],
  executive_assistant: [
    "What's on my calendar today?",
    "Any urgent emails?",
    "Draft a thank-you note",
    "Summarize yesterday's meetings",
    "What do I need to prep for tomorrow?",
  ],
  custom: [
    "What can you help with?",
    "Show me your tools",
    "What do you know about this project?",
  ],
};

async function main() {
  const emps = await db.select().from(agentEmployees);
  console.log(`Found ${emps.length} employees`);
  for (const emp of emps) {
    const prompts = PROMPTS_BY_ROLE[emp.role];
    if (!prompts) {
      console.log(`  skip ${emp.name} (${emp.role}) — no prompt set defined`);
      continue;
    }
    if (emp.starter_prompts && emp.starter_prompts.length > 0) {
      console.log(`  skip ${emp.name} — already has ${emp.starter_prompts.length} prompts`);
      continue;
    }
    await db
      .update(agentEmployees)
      .set({ starter_prompts: prompts })
      .where(eq(agentEmployees.id, emp.id));
    console.log(`  seeded ${emp.name} (${emp.role}) with ${prompts.length} prompts`);
  }
  console.log('Done.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
