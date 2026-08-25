export type OnboardingPreflightCheck = {
  key: string;
  status: 'pass' | 'fail' | 'warning';
  detail: string;
  repair: string | null;
};

export type OnboardingPreflightResult = {
  ready: boolean;
  checked_at: string;
  checks: OnboardingPreflightCheck[];
};

type ModuleRequirement = { module_id: string; access: 'read' | 'write' };
type ModuleSnapshot = { module_id: string; access: 'none' | 'read' | 'write'; enabled: boolean };

export function evaluateAgentOnboardingPreflight(input: {
  employee: {
    active: boolean;
    unhealthy: boolean;
    has_mcp_token: boolean;
    has_channel_token: boolean;
    trust_level: string;
    max_daily_actions: number;
    daily_action_count: number;
  };
  connection: {
    status: string | null;
    attestation?: {
      ready?: boolean;
      responses_api?: boolean;
      skills_api?: boolean;
      configured_model?: string | null;
      available_models?: string[];
      enabled_toolsets?: string[];
    } | null;
  } | null;
  requirements: {
    modules: ModuleRequirement[];
    hermes_toolsets: string[];
    min_action_headroom?: number;
    require_skills_api?: boolean;
    required_model?: string;
  };
  modules: ModuleSnapshot[];
  now?: Date;
}): OnboardingPreflightResult {
  const checks: OnboardingPreflightCheck[] = [];
  const required = (key: string, pass: boolean, success: string, failure: string, repair: string) => {
    checks.push({ key, status: pass ? 'pass' : 'fail', detail: pass ? success : failure, repair: pass ? null : repair });
  };

  required('employee_active', input.employee.active && !input.employee.unhealthy,
    'Employee is active and its circuit breaker is clear.',
    input.employee.unhealthy ? 'Employee circuit breaker is open.' : 'Employee is paused or deleted.',
    input.employee.unhealthy ? 'Repair or reset the employee circuit breaker before assigning work.' : 'Activate the employee before certification.');
  required('deft_credentials', input.employee.has_mcp_token && input.employee.has_channel_token,
    'MCP and Agent Channel credentials are issued.',
    'Issue both MCP and Agent Channel credentials.',
    'Generate both credentials from the employee Developer settings.');
  required('channel_compatibility', input.connection?.status === 'connected',
    'The remote bridge is connected with the current Agent Channel contract.',
    input.connection?.status === 'incompatible'
      ? 'The remote bridge is incompatible with this Deft release.'
      : 'The remote bridge is not connected and ready.',
    input.connection?.status === 'incompatible'
      ? 'Install the Hermes integration bundle matched to this Deft release.'
      : 'Start or repair the Agent Channel bridge, then refresh readiness.');

  const attestation = input.connection?.attestation;
  required('hermes_runtime', attestation?.ready === true && attestation.responses_api === true,
    'Hermes runtime and Responses API are reachable.',
    'Hermes runtime preflight has not passed.',
    'Start the authenticated Hermes gateway and confirm its Responses API is enabled.');
  if (input.requirements.require_skills_api !== false) {
    required('hermes_skills', attestation?.skills_api === true,
      'Hermes skills capability is available.',
      'Hermes has not attested its skills capability.',
      'Enable the Hermes skills API in the remote runtime; do not install skills in Deft.');
  }
  const configuredModel = attestation?.configured_model?.trim() ?? '';
  const availableModels = new Set(attestation?.available_models ?? []);
  const requiredModel = input.requirements.required_model?.trim();
  const modelAvailable = Boolean(configuredModel)
    && availableModels.has(configuredModel)
    && (!requiredModel || configuredModel === requiredModel);
  required('hermes_model', modelAvailable,
    `Hermes model ${configuredModel} is configured and available.`,
    requiredModel
      ? `Hermes must attest configured model ${requiredModel} as available.`
      : 'Hermes has not attested its configured model as available.',
    requiredModel
      ? `Configure ${requiredModel} in Hermes and restart the gateway.`
      : 'Configure an available model in Hermes and restart the gateway.');

  const remainingActions = Math.max(0, input.employee.max_daily_actions - input.employee.daily_action_count);
  const minimumHeadroom = input.requirements.min_action_headroom ?? 10;
  required('action_headroom', remainingActions >= minimumHeadroom,
    `${remainingActions} of ${input.employee.max_daily_actions} daily actions remain.`,
    `${remainingActions} of ${input.employee.max_daily_actions} daily actions remain; onboarding requires at least ${minimumHeadroom}.`,
    'Reset the employee action counter or raise its daily action limit.');

  for (const requirement of input.requirements.modules) {
    const installed = input.modules.find((candidate) => candidate.module_id === requirement.module_id);
    const accessRank = { none: 0, read: 1, write: 2 } as const;
    const allowed = Boolean(installed?.enabled)
      && Boolean(installed && accessRank[installed.access] >= accessRank[requirement.access]);
    required(`module:${requirement.module_id}:${requirement.access}`, allowed,
      `${requirement.module_id} is enabled with ${installed?.access} agent access.`,
      `${requirement.module_id} must be enabled with ${requirement.access} agent access.`,
      `Grant ${requirement.access} agent access for ${requirement.module_id} in Module settings.`);
  }

  const requiredModuleIds = new Set(input.requirements.modules.map((requirement) => requirement.module_id));
  for (const module of input.modules.filter((candidate) => candidate.enabled && !requiredModuleIds.has(candidate.module_id))) {
    const granted = module.access !== 'none';
    checks.push({
      key: `module_grant:${module.module_id}`,
      status: granted ? 'pass' : 'warning',
      detail: granted
        ? `${module.module_id} is installed with ${module.access} agent access.`
        : `${module.module_id} is installed but this organization has not granted agent access.`,
      repair: granted ? null : `Choose read or write agent access for ${module.module_id} in Module settings.`,
    });
  }

  const enabledToolsets = new Set(attestation?.enabled_toolsets ?? []);
  for (const toolset of input.requirements.hermes_toolsets) {
    required(`hermes_toolset:${toolset}`, enabledToolsets.has(toolset),
      `Hermes reports the ${toolset} toolset enabled and configured.`,
      `Configure the ${toolset} toolset in the remote Hermes runtime.`,
      `Enable and configure ${toolset} in Hermes; do not install it in Deft.`);
  }

  checks.push({
    key: 'approval_guardrails',
    status: 'pass',
    detail: `Deft trust is ${input.employee.trust_level}; the daily action limit is ${input.employee.max_daily_actions}. External tools remain governed by the remote Hermes runtime.`,
    repair: null,
  });

  return {
    ready: checks.every((check) => check.status !== 'fail'),
    checked_at: (input.now ?? new Date()).toISOString(),
    checks,
  };
}
