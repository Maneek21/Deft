/**
 * Block 1.6 — pre-deploy install secret resolution.
 *
 * When a marketplace skill declares `requires.env: ['SLACK_BOT_TOKEN']`
 * we match each required env var against:
 *
 *   1. `connected_accounts` — OAuth-issued access tokens (preferred).
 *   2. `skill_secrets` — raw tokens the user saved via the UI.
 *
 * Returns `{ resolved, missing }`. The caller decides what to do with
 * missing keys (prompt user → save via `setSecretForSkill` → retry).
 *
 * Env-var → provider mapping. Loose by design: the rule is "if the key
 * starts with a known provider prefix, use that connected account."
 * Unknown prefixes fall through to `skill_secrets`.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@deft/db';
import { connectedAccounts } from '@deft/db';
import { decrypt } from './encryption.js';
import { getSecretsForSkill } from './skill-secrets.js';

export type ResolvedSecrets = {
  resolved: Record<string, string>;
  missing: string[];
  /** Which source each key came from — for audit/UI transparency. */
  sources: Record<string, 'oauth' | 'skill_secret'>;
};

const PROVIDER_PREFIXES: Array<{ prefix: string; provider: string }> = [
  { prefix: 'SLACK_', provider: 'slack' },
  { prefix: 'GITHUB_', provider: 'github' },
  { prefix: 'GMAIL_', provider: 'gmail' },
  { prefix: 'GOOGLE_CALENDAR_', provider: 'google_calendar' },
  { prefix: 'GOOGLE_', provider: 'google_calendar' },
  { prefix: 'LINEAR_', provider: 'linear' },
];

function providerForKey(key: string): string | null {
  for (const { prefix, provider } of PROVIDER_PREFIXES) {
    if (key.startsWith(prefix)) return provider;
  }
  return null;
}

export async function resolveSecretsForInstall(
  orgId: string,
  skillId: string,
  requiredKeys: readonly string[],
): Promise<ResolvedSecrets> {
  const resolved: Record<string, string> = {};
  const sources: Record<string, 'oauth' | 'skill_secret'> = {};
  const missing: string[] = [];

  if (requiredKeys.length === 0) {
    return { resolved, missing, sources };
  }

  // 1. OAuth-first: try connected_accounts for each key with a known prefix.
  const oauthHits = new Set<string>();
  for (const key of requiredKeys) {
    const provider = providerForKey(key);
    if (!provider) continue;
    const [acct] = await db
      .select({ access_token_encrypted: connectedAccounts.access_token_encrypted })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.org_id, orgId),
          eq(connectedAccounts.provider, provider),
        ),
      )
      .limit(1);
    if (acct) {
      try {
        resolved[key] = decrypt(acct.access_token_encrypted);
        sources[key] = 'oauth';
        oauthHits.add(key);
      } catch {
        // decrypt failed — fall through to skill_secrets
      }
    }
  }

  // 2. For keys not covered by OAuth, try skill_secrets.
  const remaining = requiredKeys.filter((k) => !oauthHits.has(k));
  if (remaining.length > 0) {
    const secrets = await getSecretsForSkill(orgId, skillId, remaining);
    for (const k of remaining) {
      if (secrets[k]) {
        resolved[k] = secrets[k]!;
        sources[k] = 'skill_secret';
      } else {
        missing.push(k);
      }
    }
  }

  return { resolved, missing, sources };
}

/**
 * Push resolved secrets to the sidecar before `skills.install`.
 *
 * We scope via `config.set(path, value)` with path=`skills/<slug>/<KEY>`
 * so each skill only sees its own keys. The gateway contract treats
 * config.set values as write-through to the container env.
 */
export async function pushSkillSecretsToGateway(
  gateway: {
    config: {
      set(path: string, value: unknown): Promise<unknown>;
    };
  },
  skillSlug: string,
  secrets: Record<string, string>,
): Promise<{ pushed: string[]; failed: string[] }> {
  const pushed: string[] = [];
  const failed: string[] = [];
  for (const [key, value] of Object.entries(secrets)) {
    try {
      await gateway.config.set(`skills/${skillSlug}/${key}`, value);
      pushed.push(key);
    } catch (err) {
      console.warn(`[skill-secret-push ${skillSlug}/${key}] failed: ${(err as Error).message}`);
      failed.push(key);
    }
  }
  return { pushed, failed };
}
