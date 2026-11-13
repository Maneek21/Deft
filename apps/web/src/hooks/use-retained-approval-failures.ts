'use client';

import { useCallback, useState } from 'react';
import type { AgentAction } from '@/components/agent-action-card';
import { getApprovalMutationStatus } from '@/lib/agent-action-presentation';

type Retained = { group: string; action: AgentAction };

/**
 * Keeps an approval card whose approve answered "failed" on screen after the
 * list it came from drops the settled action, so the reason stays visible
 * while the page is open. `group` is where the card was shown (an Inbox lane,
 * a message id).
 */
export function useRetainedApprovalFailures() {
  const [retained, setRetained] = useState<Retained[]>([]);

  const retain = useCallback((group: string, action: AgentAction, body: unknown) => {
    if (getApprovalMutationStatus(body, 'approved') !== 'failed') return;
    const reply = body as { error?: unknown };
    const error = typeof reply.error === 'string' && reply.error ? reply.error : 'The approved action did not complete.';
    setRetained((current) => [
      ...current.filter((entry) => entry.action.id !== action.id),
      { group, action: { ...action, status: 'approved', approval_status: 'approved', error } },
    ]);
  }, []);

  /** The retained failures for `group` that `live` no longer lists. */
  const retainedFor = useCallback((group: string, live: readonly { id: string }[] = []) => retained
    .filter((entry) => entry.group === group && !live.some((action) => action.id === entry.action.id))
    .map((entry) => entry.action), [retained]);

  return { retain, retainedFor };
}
