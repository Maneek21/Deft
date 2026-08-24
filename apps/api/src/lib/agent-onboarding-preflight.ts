export type OnboardingPreflightCheck = {
  key: string;
  status: 'pass' | 'fail' | 'warning';
  detail: string;
};

export type OnboardingPreflightResult = {
  ready: boolean;
  checked_at: string;
  checks: OnboardingPreflightCheck[];
};

type ModuleRequirement = { module_id: string; access: 'read' | 'write' };
type ModuleSnapshot = ModuleRequirement & { enabled: boolean };

export function evaluateAgentOnboardingPreflight(input: {
  employee: {
    active: boolean;
    unhealthy: boolean;
    has_mcp_token: boolean;
    has_channel_token: boolean;
    trust_level: string;
    max_daily_actions: number;
  };
  connection: {
    status: string | null;
    attestation?: {
      ready?: boolean;
      responses_api?: boolean;
      skills_api?: boolean;
      enabled_toolsets?: string[];
    } | null;
  } | null;
  requirements: {
    modules: ModuleRequirement[];
    hermes_toolsets: string[];
  };
  modules: ModuleSnapshot[];
  now?: Date;
}): OnboardingPreflightResult {
  const checks: OnboardingPreflightCheck[] = [];
  const required = (key: string, pass: boolean, success: string, failure: string) => {
    checks.push({ key, status: pass ? 'pass' : 'fail', detail: pass ? success : failure });
  };

  required('employee_active', input.employee.active && !input.employee.unhealthy,
    'Employee is active and its circuit breaker is clear.',
    input.employee.unhealthy ? 'Employee circuit breaker is open.' : 'Employee is paused or deleted.');
  required('deft_credentials', input.employee.has_mcp_token && input.employee.has_channel_token,
    'MCP and Agent Channel credentials are issued.',
    'Issue both MCP and Agent Channel credentials.');
  required('channel_compatibility', input.connection?.status === 'connected',
    'The remote bridge is connected with the current Agent Channel contract.',
    input.connection?.status === 'incompatible'
      ? 'The remote bridge is incompatible with this Deft release.'
      : 'The remote bridge is not connected and ready.');

  const attestation = input.connection?.attestation;
  required('hermes_runtime', attestation?.ready === true && attestation.responses_api === true,
    'Hermes runtime and Responses API are reachable.',
    'Hermes runtime preflight has not passed.');

  for (const requirement of input.requirements.modules) {
    const installed = input.modules.find((candidate) => candidate.module_id === requirement.module_id);
    const accessRank = { read: 1, write: 2 } as const;
    const allowed = Boolean(installed?.enabled)
      && Boolean(installed && accessRank[installed.access] >= accessRank[requirement.access]);
    required(`module:${requirement.module_id}:${requirement.access}`, allowed,
      `${requirement.module_id} is enabled with ${installed?.access} agent access.`,
      `${requirement.module_id} must be enabled with ${requirement.access} agent access.`);
  }

  const enabledToolsets = new Set(attestation?.enabled_toolsets ?? []);
  for (const toolset of input.requirements.hermes_toolsets) {
    required(`hermes_toolset:${toolset}`, enabledToolsets.has(toolset),
      `Hermes reports the ${toolset} toolset enabled and configured.`,
      `Configure the ${toolset} toolset in the remote Hermes runtime.`);
  }

  checks.push({
    key: 'approval_guardrails',
    status: 'pass',
    detail: `Deft trust is ${input.employee.trust_level}; the daily action limit is ${input.employee.max_daily_actions}. External tools remain governed by the remote Hermes runtime.`,
  });

  return {
    ready: checks.every((check) => check.status !== 'fail'),
    checked_at: (input.now ?? new Date()).toISOString(),
    checks,
  };
}
