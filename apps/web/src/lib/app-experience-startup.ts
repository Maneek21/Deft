export type ExperienceStartupPhase = 'bootstrap' | 'worker_start' | 'worker_runtime' | 'first_view';

/** Startup has one wall-clock deadline, including hidden time. Failure never retries a Worker or request. */
export function createExperienceStartup(failed: (phase: ExperienceStartupPhase) => void) {
  let active = true;
  let phase: ExperienceStartupPhase = 'bootstrap';
  const finish = () => { active = false; clearTimeout(timer); };
  const fail = (reason = phase) => { if (active) { finish(); failed(reason); } };
  const timer = setTimeout(() => fail(), 30_000);
  return {
    ready() { if (active) phase = 'worker_start'; },
    started() { if (active) phase = 'first_view'; },
    view() { if (active) { clearTimeout(timer); phase = 'worker_runtime'; } },
    fail,
    dispose: finish,
  };
}

export function experienceStartupStatus(event: Pick<MessageEvent, 'source' | 'origin' | 'data'>,
  frame: Window | null, sessionId: string): 'started' | 'worker_start' | 'worker_runtime' | null {
  const data = event.data;
  if (!frame || event.source !== frame || event.origin !== 'null' || !data || typeof data !== 'object'
    || Object.keys(data).sort().join(',') !== 'kind,phase,session_id,state'
    || data.kind !== 'deft_experience_bootstrap_status.v1' || data.session_id !== sessionId) return null;
  if (data.state === 'started' && data.phase === 'first_view') return 'started';
  return data.state === 'failed' && ['worker_start', 'worker_runtime'].includes(data.phase) ? data.phase : null;
}
