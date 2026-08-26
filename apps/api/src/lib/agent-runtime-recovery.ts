export type AgentRuntimeRecovery = {
  state: 'ready' | 'setup_required' | 'offline' | 'incompatible' | 'degraded' | 'delivery_failed' | 'backlogged' | 'certifying';
  title: string;
  detail: string;
  action: 'none' | 'regenerate_channel_token' | 'send_channel_test' | 'inspect_queue';
};

export function describeAgentRuntimeRecovery(input: {
  hasChannelToken: boolean;
  connectionStatus?: string | null;
  lastSeenAt?: Date | null;
  failedDeliveries: number;
  pendingDeliveries: number;
  certificationStatus?: string | null;
  now?: Date;
}): AgentRuntimeRecovery {
  const now = input.now ?? new Date();
  const stale = !input.lastSeenAt || now.getTime() - input.lastSeenAt.getTime() > 2 * 60_000;
  if (!input.hasChannelToken) return {
    state: 'setup_required',
    title: 'Connect this employee runtime',
    detail: 'Generate a channel token, add it to the runtime, then send a test event.',
    action: 'regenerate_channel_token',
  };
  if (input.connectionStatus === 'incompatible') return {
    state: 'incompatible',
    title: 'Runtime integration is incompatible',
    detail: 'Install the Hermes integration bundle pinned to this Deft release, then restart its Agent Channel adapter.',
    action: 'send_channel_test',
  };
  if (input.failedDeliveries > 0) return {
    state: 'delivery_failed',
    title: `${input.failedDeliveries} delivery${input.failedDeliveries === 1 ? '' : 'ies'} need attention`,
    detail: 'Inspect the failed event below, retry it after the runtime is healthy, or cancel it if the work is obsolete.',
    action: 'inspect_queue',
  };
  if (input.connectionStatus === 'degraded') return {
    state: 'degraded',
    title: 'Runtime needs attention',
    detail: 'The delivery adapter is checking in, but its Hermes runtime preflight or recent work failed. Inspect the runtime health details before assigning more work.',
    action: 'send_channel_test',
  };
  if (input.connectionStatus !== 'connected' || stale) return {
    state: 'offline',
    title: 'Runtime is not checking in',
    detail: 'Start the runtime and its Agent Channel adapter, then send a test event. Deft will update this page when contact resumes.',
    action: 'send_channel_test',
  };
  if (input.certificationStatus !== 'verified') return {
    state: 'certifying',
    title: 'Transport connected; employee check pending',
    detail: 'Deft will mark this employee ready only after a real Agent Channel assignment, Hermes turn, MCP calls, reply, and memory probe complete.',
    action: 'none',
  };
  if (input.pendingDeliveries > 5) return {
    state: 'backlogged',
    title: `${input.pendingDeliveries} deliveries are waiting`,
    detail: 'The runtime is connected but falling behind. Check its logs and daily action limits before adding more work.',
    action: 'inspect_queue',
  };
  return {
    state: 'ready',
    title: 'Runtime is ready',
    detail: 'The employee passed the end-to-end check, is connected, and has no delivery failures.',
    action: 'none',
  };
}
