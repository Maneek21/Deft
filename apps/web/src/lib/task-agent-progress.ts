/**
 * Live agent progress for the task detail strip.
 *
 * `task:agent_progress` events go to every member of the org, so they carry
 * only ids, position and state. The step text for a reader of the task comes
 * from the task read (GET /api/tasks/:id `agent_progress`), which the server
 * returns only to readers of the task. An event refreshes that read; while it
 * is in flight, or when the read has no progress (for example a plan step),
 * the strip shows the event's neutral text.
 */

export type TaskAgentProgressStatus =
  | 'queued' | 'pending' | 'delivered' | 'acknowledged' | 'started' | 'approval_pending'
  | 'needs_human' | 'blocked' | 'completed' | 'failed' | 'cancelled';

export type TaskAgentProgress = {
  agent_employee_id: string | null;
  step_index: number;
  step_description: string;
  status: TaskAgentProgressStatus;
  total_steps: number;
  error?: string;
};

export type TaskAgentProgressEvent = TaskAgentProgress & { task_id: string };

export const TERMINAL_AGENT_PROGRESS_STATUSES: readonly string[] = ['completed', 'failed', 'cancelled', 'needs_human', 'blocked'];

/** The strip state an org-wide event provides on its own. */
export function progressFromEvent(event: TaskAgentProgressEvent): TaskAgentProgress {
  return {
    agent_employee_id: event.agent_employee_id,
    step_index: event.step_index,
    step_description: event.step_description,
    status: event.status,
    total_steps: event.total_steps,
  };
}

/** The strip state after the task read: the read's progress when it has one. */
export function progressAfterRead(
  current: TaskAgentProgress | null,
  read: { agent_progress?: TaskAgentProgress | null; agent_outcome?: unknown },
): TaskAgentProgress | null {
  if (read.agent_outcome) return null;
  return read.agent_progress ?? current;
}

/**
 * Run `refresh` for a burst of triggers with at most one call in flight: a
 * trigger during a call schedules one more call after it, however many
 * triggers arrive.
 */
export function createCoalescedRefresh(refresh: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let again = false;
  const run = async (): Promise<void> => {
    try {
      do {
        again = false;
        try { await refresh(); } catch { /* the next trigger retries */ }
      } while (again);
    } finally {
      inFlight = null;
    }
  };
  return () => {
    if (inFlight) {
      again = true;
      return inFlight;
    }
    inFlight = run();
    return inFlight;
  };
}

/**
 * Tell whether a read that was started earlier may still be applied.
 * `capture()` marks the start of a read and returns a check; `invalidate()`
 * makes every check captured before it answer false.
 */
export function createSnapshotGuard(): { capture: () => () => boolean; invalidate: () => void } {
  let epoch = 0;
  return {
    capture: () => {
      const started = epoch;
      return () => started === epoch;
    },
    invalidate: () => { epoch += 1; },
  };
}
