import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { appRuntimeAgentPolicies } from '@deft/db/schema';
import { AppError } from './app-errors.js';
import type { ExperienceCaller } from './app-experience-service.js';
import type { HumanActionAuthorityPort } from './app-experience-human-action-service.js';
const Update = z.strictObject({ mode: z.enum(['deny', 'require_approval']), expected_revision: z.number().int().min(0).max(2_147_483_646) });
/** This setting never upgrades an installation grant into agent autonomy. */
export function experienceAgentPolicy(authority: HumanActionAuthorityPort, caller: ExperienceCaller,
  sessionId: string, actionKey: string, raw: unknown | undefined, signal?: AbortSignal) {
  const update = raw === undefined ? null : Update.parse(raw);
  return authority.withHumanAction(caller, sessionId, actionKey, async (tx, context, final) => {
    const scope = and(eq(appRuntimeAgentPolicies.org_id, caller.org_id),
      eq(appRuntimeAgentPolicies.owner_user_id, caller.user_id), eq(appRuntimeAgentPolicies.runtime_binding_id, context.runtime_binding_id));
    const [old] = await tx.select().from(appRuntimeAgentPolicies).where(scope).limit(1).for('update');
    let result: { mode: 'deny' | 'require_approval'; revision: number } = old ? { mode: old.mode, revision: old.revision } : { mode: 'deny', revision: 0 };
    if (update) {
      if (result.revision !== update.expected_revision) throw new AppError('Agent policy changed. Reload before saving.', 'APP_STATE_CONFLICT', 409);
      if (!old) {
        const [created] = await tx.insert(appRuntimeAgentPolicies).values({ org_id: caller.org_id, owner_user_id: caller.user_id,
          runtime_binding_id: context.runtime_binding_id, mode: update.mode, revision: 1 }).onConflictDoNothing().returning();
        if (!created) throw new AppError('Agent policy changed. Reload before saving.', 'APP_STATE_CONFLICT', 409);
        result = { mode: created.mode, revision: created.revision };
      } else {
        const [changed] = await tx.update(appRuntimeAgentPolicies).set({ mode: update.mode, revision: old.revision + 1, updated_at: new Date() })
          .where(and(scope, eq(appRuntimeAgentPolicies.revision, update.expected_revision))).returning();
        if (!changed) throw new AppError('Agent policy changed. Reload before saving.', 'APP_STATE_CONFLICT', 409);
        result = { mode: changed.mode, revision: changed.revision };
      }
    }
    await final(tx); return result;
  }, signal);
}
