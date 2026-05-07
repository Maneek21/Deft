/**
 * One-shot CLI wrapper around `issueEmployeeToken`.
 *
 * Usage:
 *   pnpm --filter @deft/api exec tsx src/scripts/issue-token.ts <org_id> <employee_id>
 *
 * Prints the raw bearer token to stdout exactly once. The bcrypt hash is
 * stamped onto the `agent_employees` row matching the given
 * (org_id, employee_id) pair. Store the printed token somewhere safe —
 * it cannot be recovered from the database.
 */
import { issueEmployeeToken } from '../lib/mcp-token.js';

async function main() {
  const [orgId, employeeId] = process.argv.slice(2);
  if (!orgId || !employeeId) {
    console.error(
      'Usage: pnpm --filter @deft/api exec tsx src/scripts/issue-token.ts <org_id> <employee_id>',
    );
    process.exit(1);
  }

  try {
    const token = await issueEmployeeToken(orgId, employeeId);
    console.log(token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`issue-token failed: ${msg}`);
    process.exit(2);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(3);
  },
);
