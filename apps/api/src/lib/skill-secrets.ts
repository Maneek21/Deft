/**
 * Block 1.4 — per-org, per-skill encrypted secret store.
 *
 * Getters decrypt lazily. Setters upsert-encrypt. The store is ONLY touched
 * by the Block 1.6 pre-deploy install flow: when a ClawHub skill declares
 * `requires.env: [SLACK_BOT_TOKEN]` and OAuth match missed, Deft prompts for
 * raw token and stores it here; at install time only the keys declared by
 * the skill's manifest are pushed to the container (least privilege).
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@deft/db';
import { skillSecrets } from '@deft/db';
import { encrypt, decrypt } from './encryption.js';

export type SkillSecretInput = {
  org_id: string;
  skill_id: string;
  key_name: string;
  value: string;
  created_by?: string | null;
};

/** Returns the decrypted value, or null if not set. */
export async function getSecretForSkill(
  orgId: string,
  skillId: string,
  keyName: string,
): Promise<string | null> {
  const row = await db.query.skillSecrets.findFirst({
    where: and(
      eq(skillSecrets.org_id, orgId),
      eq(skillSecrets.skill_id, skillId),
      eq(skillSecrets.key_name, keyName),
    ),
  });
  if (!row) return null;
  try {
    return decrypt(row.value_encrypted);
  } catch {
    return null;
  }
}

/** Returns a map { key_name → decrypted_value } for the requested keys only. */
export async function getSecretsForSkill(
  orgId: string,
  skillId: string,
  keyNames: readonly string[],
): Promise<Record<string, string>> {
  if (keyNames.length === 0) return {};
  const rows = await db.query.skillSecrets.findMany({
    where: and(eq(skillSecrets.org_id, orgId), eq(skillSecrets.skill_id, skillId)),
  });
  const wanted = new Set(keyNames);
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (!wanted.has(row.key_name)) continue;
    try {
      out[row.key_name] = decrypt(row.value_encrypted);
    } catch {
      // Drop keys that fail to decrypt (stale key, corrupted row). Better to
      // report "missing secret" than to crash the install flow.
    }
  }
  return out;
}

/** Upsert. Re-setting the same (org, skill, key) overwrites the ciphertext. */
export async function setSecretForSkill(input: SkillSecretInput): Promise<void> {
  const encrypted = encrypt(input.value);
  const existing = await db.query.skillSecrets.findFirst({
    where: and(
      eq(skillSecrets.org_id, input.org_id),
      eq(skillSecrets.skill_id, input.skill_id),
      eq(skillSecrets.key_name, input.key_name),
    ),
  });
  if (existing) {
    await db
      .update(skillSecrets)
      .set({ value_encrypted: encrypted, updated_at: new Date() })
      .where(eq(skillSecrets.id, existing.id));
    return;
  }
  await db.insert(skillSecrets).values({
    id: crypto.randomUUID(),
    org_id: input.org_id,
    skill_id: input.skill_id,
    key_name: input.key_name,
    value_encrypted: encrypted,
    created_by: input.created_by ?? null,
  });
}

export async function deleteSecretForSkill(
  orgId: string,
  skillId: string,
  keyName: string,
): Promise<void> {
  await db
    .delete(skillSecrets)
    .where(
      and(
        eq(skillSecrets.org_id, orgId),
        eq(skillSecrets.skill_id, skillId),
        eq(skillSecrets.key_name, keyName),
      ),
    );
}

/** List key names (no values) for UI — shows which secrets are set. */
export async function listSecretKeysForSkill(
  orgId: string,
  skillId: string,
): Promise<string[]> {
  const rows = await db.query.skillSecrets.findMany({
    where: and(eq(skillSecrets.org_id, orgId), eq(skillSecrets.skill_id, skillId)),
    columns: { key_name: true },
  });
  return rows.map((r) => r.key_name);
}
