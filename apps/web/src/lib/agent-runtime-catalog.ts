export type AgentRuntimeId = 'codex' | 'openclaw' | 'hermes' | 'claude_desktop' | 'custom_mcp' | 'deft_managed_later';

export type AgentRuntime = {
  id: AgentRuntimeId;
  name: string;
  description: string;
  defaultName: string;
  defaultRole: string;
  defaultJobTitle: string;
  defaultExpertise: string;
  defaultWakeMode: 'manual' | 'polling' | 'webhook' | 'external_chat';
  transports: string[];
  setupNotes: string[];
  certificationTools: string[];
  caveats: string[];
  ownsIdentity: boolean;
  disabled?: boolean;
  disabledReason?: string;
};

export const AGENT_RUNTIMES: AgentRuntime[] = [
  {
    id: 'codex',
    name: 'I already have Codex running',
    description: 'Connect a Codex-style coding/workspace agent with its own instructions.',
    defaultName: 'Codex QA',
    defaultRole: 'qa_engineer',
    defaultJobTitle: 'QA Engineer',
    defaultExpertise: 'Repo-aware task execution, testing, and workflow follow-through',
    defaultWakeMode: 'manual',
    transports: ['MCP streamable HTTP'],
    setupNotes: [
      'Add Deft as an MCP server in the Codex runtime.',
      'Tell the runtime its Deft caller slug after connection.',
      'Use memory_recall for Deft wiki context; wiki_search is accepted as a compatibility alias.',
      'Run certification from the Developer tab before assigning work.',
    ],
    certificationTools: ['platform_context', 'task_query', 'ping_alive', 'record_conversation_turn', 'record_decision'],
    caveats: ['Codex owns its own system instructions; Deft should store the job title and trust policy only.'],
    ownsIdentity: true,
  },
  {
    id: 'openclaw',
    name: 'I already have OpenClaw running',
    description: 'Connect an existing long-running OpenClaw runtime as an employee.',
    defaultName: 'OpenClaw',
    defaultRole: 'custom',
    defaultJobTitle: 'Autonomous Agent Employee',
    defaultExpertise: 'Autonomous workspace operations through Deft MCP tools',
    defaultWakeMode: 'polling',
    transports: ['MCP streamable HTTP', 'External scheduler'],
    setupNotes: [
      'Assume the customer already has an OpenClaw runtime running.',
      'Add Deft MCP endpoint and bearer token to the existing OpenClaw tool config.',
      'Keep OpenClaw identity prompts in OpenClaw; use Deft for employee record, trust, and certification.',
      'Use memory_recall for Deft wiki context; wiki_search is accepted as a compatibility alias.',
      'Use certification to prove OpenClaw can read context, query tasks, ping alive, and report decisions.',
    ],
    certificationTools: ['platform_context', 'task_query', 'ping_alive', 'record_conversation_turn', 'record_decision'],
    caveats: [
      'OpenClaw may need explicit instruction to include caller_employee_slug on every tool call.',
      'Do not ask OpenClaw to rewrite its SOUL/identity during onboarding unless the customer wants that.',
    ],
    ownsIdentity: true,
  },
  {
    id: 'hermes',
    name: 'I already have Hermes running',
    description: 'Connect an existing Hermes runtime with its own voice and role prompt.',
    defaultName: 'Hermes',
    defaultRole: 'executive_assistant',
    defaultJobTitle: 'Executive Assistant',
    defaultExpertise: 'Inbox, coordination, summaries, and follow-up workflows',
    defaultWakeMode: 'manual',
    transports: ['Hermes MCP stdio bridge'],
    setupNotes: [
      'Assume Hermes is already running with a model and personality.',
      'Attach Deft as a Hermes MCP server named "deft" and preserve Hermes-owned identity prompts.',
      'Prompt Hermes with model-visible tool names like mcp_deft_ping_alive and mcp_deft_task_query.',
      'Use mcp_deft_memory_recall for Deft wiki context; mcp_deft_wiki_search is accepted as a compatibility alias.',
      'Use the challenge nonce to verify Hermes can self-report conversation and decision records.',
    ],
    certificationTools: ['platform_context', 'task_query', 'ping_alive', 'record_conversation_turn', 'record_decision'],
    caveats: [
      'Hermes may discover Deft MCP tools but still fail certification if the model provider is not authenticated.',
      'Hermes CLI configuration may show deft:<tool>, while the model-visible tools appear as mcp_deft_<tool>.',
      'Hermes may expose MCP tools only after a restart or config reload.',
      'If Hermes does not autonomously wake, choose manual or external chat wake mode.',
    ],
    ownsIdentity: true,
  },
  {
    id: 'claude_desktop',
    name: 'Claude Desktop',
    description: 'A local MCP client for supervised workspace help.',
    defaultName: 'Claude Desktop',
    defaultRole: 'custom',
    defaultJobTitle: 'Workspace Assistant',
    defaultExpertise: 'Human-in-the-loop workspace assistance through MCP',
    defaultWakeMode: 'manual',
    transports: ['MCP streamable HTTP'],
    setupNotes: [
      'Paste the Deft MCP config into Claude Desktop.',
      'Restart the client after config changes.',
      'Certification is human-triggered because Claude Desktop is not a background worker.',
    ],
    certificationTools: ['platform_context', 'task_query', 'ping_alive', 'record_conversation_turn', 'record_decision'],
    caveats: ['Claude Desktop acts when a human prompts it; it is not a scheduled employee by itself.'],
    ownsIdentity: true,
  },
  {
    id: 'custom_mcp',
    name: 'I have a generic MCP agent',
    description: 'Connect any MCP-compatible agent loop or internal runtime.',
    defaultName: 'Workspace Agent',
    defaultRole: 'custom',
    defaultJobTitle: 'Workspace Agent',
    defaultExpertise: 'Workspace actions through Deft MCP tools',
    defaultWakeMode: 'manual',
    transports: ['MCP streamable HTTP'],
    setupNotes: [
      'Connect to Deft MCP over HTTP with the bearer token.',
      'Pass caller_employee_slug on each tool call.',
      'Use memory_recall for Deft wiki context; wiki_search is accepted as a compatibility alias.',
      'Run certification before adding the employee to real workflows.',
    ],
    certificationTools: ['platform_context', 'task_query', 'ping_alive', 'record_conversation_turn', 'record_decision'],
    caveats: ['Custom runtimes must implement their own loop, scheduling, and prompt discipline.'],
    ownsIdentity: false,
  },
  {
    id: 'deft_managed_later',
    name: 'I want Deft to manage the runtime',
    description: 'Coming later: Deft-provisioned hosted or local employees.',
    defaultName: 'Managed Agent',
    defaultRole: 'custom',
    defaultJobTitle: 'Managed Agent',
    defaultExpertise: 'Deft-managed runtime',
    defaultWakeMode: 'polling',
    transports: ['Deft-managed runtime'],
    setupNotes: [
      'This mode is not available yet.',
      'For this pilot, start with an already-running Codex, OpenClaw, Hermes, Claude Desktop, or MCP runtime.',
    ],
    certificationTools: [],
    caveats: ['Managed runtime provisioning is outside the current BYOA pilot path.'],
    ownsIdentity: false,
    disabled: true,
    disabledReason: 'Coming later',
  },
];

export function getRuntimeById(id: AgentRuntimeId): AgentRuntime {
  const runtime = AGENT_RUNTIMES.find((candidate) => candidate.id === id);
  return runtime && !runtime.disabled ? runtime : AGENT_RUNTIMES[0];
}
