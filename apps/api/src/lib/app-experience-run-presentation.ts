import type { AppRunState } from '@deft/shared';
/** Engine approval is a release flag; Experience consumers see the queued phase. */
export function experienceRunState(state: AppRunState, releaseKind: string | null): AppRunState {
  return state === 'pending_approval' && releaseKind === 'approved' ? 'pending' : state;
}
