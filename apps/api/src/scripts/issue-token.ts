/**
 * Phase 3 — one-shot CLI wrapper around `issueGatewayToken`.
 *
 * Usage:
 *   pnpm --filter @deft/api exec tsx src/scripts/issue-token.ts <org_id> <connection_url>
 *
 * Prints the raw bearer token to stdout exactly once. The bcrypt hash is
 * stamped onto every non-native agent_employees row matching the given
 * (org_id, connection_url) pair. Store the printed token somewhere safe —
 * it cannot be recovered from the database.
 */
import { issueGatewayToken } from '../lib/mcp-token.js';

async function main() {
  const [orgId, connectionUrl] = process.argv.slice(2);
  if (!orgId || !connectionUrl) {
    console.error(
      'Usage: pnpm --filter @deft/api exec tsx src/scripts/issue-token.ts <org_id> <connection_url>',
    );
    process.exit(1);
  }

  try {
    const token = await issueGatewayToken(orgId, connectionUrl);
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
