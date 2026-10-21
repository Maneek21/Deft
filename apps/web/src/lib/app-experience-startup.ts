export type ExperienceStartupPhase = 'bootstrap' | 'worker_start' | 'worker_runtime' | 'first_view';

/** One visible startup budget. A suspended tab cannot start or render its
 * Worker; returning resumes the remaining budget after authority revalidation.
 * Failure never retries a Worker or request. */
export function createExperienceStartup(failed: (phase: ExperienceStartupPhase) => void,
  options: { hidden?: () => boolean } = {}) {
  let active = true;
  let phase: ExperienceStartupPhase = 'bootstrap';
  let paused = options.hidden?.() ?? false;
  let remaining = 30_000, startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => { active = false; clearTimeout(timer); };
  const fail = (reason = phase) => { if (active) { finish(); failed(reason); } };
  const schedule = () => { startedAt = Date.now(); timer = setTimeout(() => fail(), remaining); };
  if (!paused) schedule();
  return {
    ready() { if (active) phase = 'worker_start'; },
    started() { if (active) phase = 'first_view'; },
    view() { if (active) { clearTimeout(timer); phase = 'worker_runtime'; } },
    pause() {
      if (!active || paused || phase === 'worker_runtime') return;
      paused = true; remaining = Math.max(0, remaining - Math.max(0, Date.now() - startedAt)); clearTimeout(timer);
    },
    resume() {
      if (!active || !paused || phase === 'worker_runtime' || options.hidden?.()) return;
      paused = false; schedule();
    },
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
