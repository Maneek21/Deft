export type AgentEmployeeHealth = {
  is_active?: boolean;
  unhealthy?: boolean;
  unhealthy_reason?: string | null;
  certification_status?: string | null;
  pending_action_count?: number;
  last_mcp_call_at?: string | null;
  last_heartbeat_at?: string | null;
  last_turn_at?: string | null;
  last_work_outcome_at?: string | null;
  channel_last_seen_at?: string | null;
  channel_status?: string | null;
  required_workspace_skill_installed?: boolean;
};

export type AgentEmployeeLifecycle = {
  label: string;
  detail: string;
  tone: 'green' | 'blue' | 'amber' | 'red' | 'gray' | 'purple';
};

function validTime(value?: string | null) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestTime(...values: Array<string | null | undefined>) {
  return Math.max(0, ...values.map(validTime));
}

export function formatAgentAge(value?: string | null, now = Date.now()) {
  const timestamp = validTime(value);
  if (!timestamp) return 'never';
  const elapsedMinutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (elapsedMinutes < 1) return 'just now';
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const hours = Math.floor(elapsedMinutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function latestAgentContact(emp: AgentEmployeeHealth) {
  const values = [emp.last_mcp_call_at, emp.last_heartbeat_at, emp.channel_last_seen_at];
  const timestamp = latestTime(...values);
  if (!timestamp) return null;
  return values.find((value) => validTime(value) === timestamp) ?? null;
}

export function agentEmployeeLifecycle(emp: AgentEmployeeHealth, now = Date.now()): AgentEmployeeLifecycle {
  if (emp.unhealthy || emp.channel_status === 'error' || emp.channel_status === 'degraded') {
    return {
      label: 'Needs attention',
      detail: emp.unhealthy_reason || 'runtime health check failed',
      tone: 'red',
    };
  }
  if (emp.is_active === false) return { label: 'Paused', detail: 'will not pick up new work', tone: 'gray' };

  if (emp.channel_status === 'disconnected') {
    const contact = latestAgentContact(emp);
    return {
      label: 'Offline',
      detail: contact ? `last runtime contact ${formatAgentAge(contact, now)}` : 'runtime is not connected',
      tone: 'gray',
    };
  }

  if (emp.required_workspace_skill_installed === false) {
    return { label: 'Setup incomplete', detail: 'Deft Workspace skill is missing', tone: 'amber' };
  }

  if (emp.certification_status !== 'verified') {
    if (emp.certification_status === 'challenge_issued') {
      return { label: 'Certifying', detail: 'waiting for the end-to-end employee check', tone: 'amber' };
    }
    if (emp.certification_status === 'mcp_reachable') {
      return { label: 'Setup incomplete', detail: 'MCP works, but the employee check has not passed', tone: 'amber' };
    }
    if (emp.certification_status === 'token_issued') {
      return { label: 'Setup incomplete', detail: 'waiting for the first runtime call', tone: 'amber' };
    }
    return { label: 'Draft', detail: 'finish setup and certify the runtime', tone: 'gray' };
  }

  const contact = latestAgentContact(emp);
  const contactAt = validTime(contact);
  const workAt = latestTime(emp.last_work_outcome_at, emp.last_turn_at);
  const contactAge = contactAt ? Math.max(0, now - contactAt) : Number.POSITIVE_INFINITY;
  const workAge = workAt ? Math.max(0, now - workAt) : Number.POSITIVE_INFINITY;

  if (!contactAt) {
    if (emp.certification_status === 'verified') {
      return { label: 'Ready to connect', detail: 'certified, but no runtime contact yet', tone: 'purple' };
    }
  }

  if ((emp.pending_action_count ?? 0) > 0) {
    return {
      label: 'Approval waiting',
      detail: `${emp.pending_action_count} action${emp.pending_action_count === 1 ? '' : 's'} need review`,
      tone: 'amber',
    };
  }

  if (workAge < 15 * 60_000) {
    return { label: 'Working', detail: `activity ${formatAgentAge(new Date(workAt).toISOString(), now)}`, tone: 'green' };
  }
  if (contactAge < 5 * 60_000) {
    return { label: 'Online', detail: 'runtime connected and ready', tone: 'green' };
  }
  if (contactAge < 60 * 60_000) {
    return { label: 'Idle', detail: `runtime seen ${formatAgentAge(contact, now)}`, tone: 'blue' };
  }
  return { label: 'Offline', detail: `last runtime contact ${formatAgentAge(contact, now)}`, tone: 'gray' };
}

export function agentConnectionStatus(emp: AgentEmployeeHealth, now = Date.now()) {
  const contact = latestAgentContact(emp);
  if (emp.channel_status === 'disconnected') {
    return {
      label: contact ? `Disconnected - last seen ${formatAgentAge(contact, now)}` : 'Disconnected',
      tone: 'gray' as const,
    };
  }
  if (!contact) return { label: 'Never connected', tone: 'gray' as const };
  const elapsedMinutes = Math.max(0, Math.floor((now - validTime(contact)) / 60_000));
  if (elapsedMinutes < 5) return { label: 'Connected', tone: 'green' as const };
  return { label: `Last seen ${formatAgentAge(contact, now)}`, tone: elapsedMinutes < 60 ? 'amber' as const : 'gray' as const };
}
