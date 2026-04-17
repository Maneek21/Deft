/**
 * Task 8.1 stub — `trigger-dispatch` is implemented in Task 8.7. Kept as a
 * no-op handler so the worker registry can register the cron at 8.1 rollout
 * time without crashing on import.
 */
import type { JobData } from '../types.js';

export async function handleTriggerDispatch(_job: JobData): Promise<void> {
  // No-op until Task 8.7 lands.
}
