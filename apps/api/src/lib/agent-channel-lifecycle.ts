export const AGENT_CHANNEL_EVENT_STATES = [
  'pending',
  'delivered',
  'acknowledged',
  'running',
  'approval_pending',
  'completed',
  'failed',
  'cancelled',
] as const;

export type AgentChannelEventState = (typeof AGENT_CHANNEL_EVENT_STATES)[number];
export type AgentChannelLifecyclePhase = 'queued' | Exclude<AgentChannelEventState, 'pending'>;
export type AgentChannelLifecycleSignal = Exclude<AgentChannelEventState, 'pending'>;

type LifecycleRow = {
  status: string;
  created_at: Date;
  updated_at: Date;
  delivered_at: Date | null;
  acked_at: Date | null;
  completed_at: Date | null;
  failed_at: Date | null;
};

type LifecyclePatch = Partial<Pick<LifecycleRow,
  'status' | 'updated_at' | 'delivered_at' | 'acked_at' | 'completed_at' | 'failed_at'
>> & { error?: string | null };

const STATE_RANK: Record<AgentChannelEventState, number> = {
  pending: 0,
  delivered: 1,
  acknowledged: 2,
  running: 3,
  approval_pending: 4,
  completed: 5,
  failed: 5,
  cancelled: 5,
};

function isEventState(value: string): value is AgentChannelEventState {
  return (AGENT_CHANNEL_EVENT_STATES as readonly string[]).includes(value);
}

/** Builds a monotonic lifecycle update. Terminal events never reopen or flip outcome. */
export function buildAgentChannelLifecyclePatch(
  event: LifecycleRow,
  signal: AgentChannelLifecycleSignal,
  now = new Date(),
  error?: string | null,
): LifecyclePatch {
  const current = isEventState(event.status) ? event.status : 'pending';
  if (current === 'completed' || current === 'failed' || current === 'cancelled') return {};
  if (STATE_RANK[signal] < STATE_RANK[current]) return {};

  const patch: LifecyclePatch = { status: signal, updated_at: now };
  if (STATE_RANK[signal] >= STATE_RANK.delivered) {
    patch.delivered_at = event.delivered_at ?? now;
  }
  if (STATE_RANK[signal] >= STATE_RANK.acknowledged) {
    patch.acked_at = event.acked_at ?? now;
  }
  if (signal === 'completed') {
    patch.completed_at = event.completed_at ?? now;
    patch.failed_at = null;
    patch.error = null;
  } else if (signal === 'failed' || signal === 'cancelled') {
    patch.failed_at = event.failed_at ?? now;
    patch.completed_at = null;
    patch.error = error ?? (signal === 'cancelled' ? 'Cancelled by an operator' : 'Runtime reported failure');
  }
  return patch;
}

export function summarizeAgentChannelLifecycle(event: LifecycleRow, now = new Date()) {
  const status = isEventState(event.status) ? event.status : 'pending';
  const terminalAt = event.completed_at ?? event.failed_at;
  const elapsed = (end: Date | null, start: Date | null) =>
    end && start ? Math.max(0, end.getTime() - start.getTime()) : null;

  return {
    phase: (status === 'pending' ? 'queued' : status) as AgentChannelLifecyclePhase,
    queue_ms: elapsed(event.delivered_at, event.created_at),
    acknowledge_ms: elapsed(event.acked_at, event.delivered_at),
    execution_ms: elapsed(terminalAt, event.acked_at),
    total_ms: elapsed(terminalAt, event.created_at),
    age_ms: terminalAt ? null : Math.max(0, now.getTime() - event.created_at.getTime()),
  };
}

function percentile(values: number[], ratio: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? null;
}

export function summarizeAgentChannelMetrics(events: LifecycleRow[], now = new Date()) {
  const summaries = events.map((event) => summarizeAgentChannelLifecycle(event, now));
  const metric = (key: 'queue_ms' | 'acknowledge_ms' | 'total_ms') => {
    const values = summaries.map((row) => row[key]).filter((value): value is number => value !== null);
    return { p50_ms: percentile(values, 0.5), p95_ms: percentile(values, 0.95) };
  };
  const openAges = summaries.map((row) => row.age_ms).filter((value): value is number => value !== null);
  return {
    sample_count: events.length,
    delivery: metric('queue_ms'),
    acknowledgement: metric('acknowledge_ms'),
    completion: metric('total_ms'),
    oldest_open_age_ms: openAges.length ? Math.max(...openAges) : null,
  };
}
