import type { ExperiencePin } from './app-experience-bridge';
import type { GroupValue } from './private-state-adoption';

export type RecoveryDismissalScope = Pick<ExperiencePin, 'org_id' | 'user_id' | 'app_installation_id' | 'app_version_id' | 'grant_snapshot_id' | 'lifecycle_epoch' | 'grant_epoch'> & { artifact_digest: string };
/** Presentation preference only. Fresh host context and exposure remain required. */
export async function recoveryDismissalKey(scope: RecoveryDismissalScope, target: string,
  states: readonly { key: string; context: { groups: GroupValue[] } }[]): Promise<string> {
  const canonical = states.map(state => ({ key: state.key, groups: state.context.groups.map(group => ({
    ...group, records: [...group.records].sort((a, b) => a.record_id.localeCompare(b.record_id)),
  })).sort((a, b) => a.source_artifact_digest.localeCompare(b.source_artifact_digest)) })).sort((a, b) => a.key.localeCompare(b.key));
  const bytes = new TextEncoder().encode(JSON.stringify({ scope, target, states: canonical }));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return 'deft.recovery.dismissed.v1.' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
