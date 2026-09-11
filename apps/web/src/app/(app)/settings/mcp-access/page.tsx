'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Bot, Check, ChevronDown, Code2, Copy, Globe2, KeyRound, Plug, Wrench } from 'lucide-react';
import { api } from '@/lib/api';
import { useSetPageContext } from '@/components/app-header-context';
import { SettingsSteps } from '@/components/settings-steps';
import styles from './page.module.css';

type McpToken = {
  id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  created_at: string;
  recent_actions?: OAuthAuditAction[];
};

const READ_SCOPES = ['read:workspace', 'read:wiki', 'read:tasks', 'read:messages', 'read:calendar', 'read:modules'];
const WRITE_SCOPES = [
  'write:tasks',
  'write:messages',
  'write:wiki',
  'write:calendar',
  'write:modules',
  'write:workspace',
];
const COLLABORATE_SCOPES = [...READ_SCOPES, 'write:tasks', 'write:messages', 'write:wiki', 'write:modules'];
const ALL_SCOPES = [...READ_SCOPES, ...WRITE_SCOPES];
const APP_SCOPES = ['read:apps', 'invoke:apps', 'read:app-runs'];
const AVAILABLE_SCOPES = [...ALL_SCOPES, ...APP_SCOPES];

type ClientId = 'codex' | 'claude-code' | 'claude-desktop' | 'remote-web' | 'headless' | 'custom' | 'agent-employee';
type AccessPreset = 'read' | 'work' | 'operate' | 'custom';

type ClientOption = {
  id: ClientId;
  name: string;
  fit: string;
  detail: string;
  setupKind: 'token' | 'oauth' | 'advanced' | 'agent';
  defaultPreset: AccessPreset;
  tokenName: string;
};

const CLIENT_OPTIONS: ClientOption[] = [
  {
    id: 'codex',
    name: 'Codex',
    fit: 'Recommended token setup',
    detail:
      'Best for owner-operator workflows: triage messages, read tasks, write wiki, post updates, and leave receipts.',
    setupKind: 'token',
    defaultPreset: 'work',
    tokenName: 'Codex',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    fit: 'Token setup',
    detail: 'Use the Claude Code CLI with Deft as a remote HTTP MCP server and a bearer header.',
    setupKind: 'token',
    defaultPreset: 'work',
    tokenName: 'Claude Code',
  },
  {
    id: 'claude-desktop',
    name: 'Claude / Claude Desktop',
    fit: 'Remote OAuth connector',
    detail:
      'Add Deft from Claude settings, not inside a chat. Claude connects from Anthropic cloud and authenticates through OAuth.',
    setupKind: 'oauth',
    defaultPreset: 'read',
    tokenName: 'Claude connector',
  },
  {
    id: 'remote-web',
    name: 'ChatGPT / hosted AI apps',
    fit: 'Plan-dependent access',
    detail:
      'ChatGPT Pro currently supports read/fetch. Full read/write MCP requires an eligible Business or Enterprise/Edu workspace using Developer Mode.',
    setupKind: 'oauth',
    defaultPreset: 'read',
    tokenName: 'Remote AI app',
  },
  {
    id: 'headless',
    name: 'Headless / automation',
    fit: 'Full workspace operation',
    detail:
      'For scripts and AI clients that operate notes, inbox, approvals, projects, calendar, and agent state without opening Deft.',
    setupKind: 'token',
    defaultPreset: 'operate',
    tokenName: 'Headless operator',
  },
  {
    id: 'custom',
    name: 'Custom MCP client',
    fit: 'Advanced',
    detail: 'For engineers wiring their own streamable HTTP MCP client, bearer token, or OAuth connector.',
    setupKind: 'advanced',
    defaultPreset: 'custom',
    tokenName: 'Custom MCP client',
  },
  {
    id: 'agent-employee',
    name: 'Agent employee runtime',
    fit: 'Different flow',
    detail: 'Use this when the app should behave like a shared employee instead of acting as your personal user.',
    setupKind: 'agent',
    defaultPreset: 'work',
    tokenName: 'Agent employee',
  },
];

const PRESETS: Array<{ id: AccessPreset; title: string; detail: string; scopes: string[] }> = [
  {
    id: 'read',
    title: 'Read and answer',
    detail: 'Can answer questions using visible workspace, task, chat, calendar, wiki, and module context.',
    scopes: READ_SCOPES,
  },
  {
    id: 'work',
    title: 'Collaborate in work',
    detail: 'Can create and update tasks and module records, post messages, and maintain wiki knowledge as you.',
    scopes: COLLABORATE_SCOPES,
  },
  {
    id: 'operate',
    title: 'Operate the workspace',
    detail: 'Adds calendar writes plus notes, inbox, approvals, projects, and agent operations for headless use.',
    scopes: ALL_SCOPES,
  },
  {
    id: 'custom',
    title: 'Choose individually',
    detail: 'Turn each read and write permission on or off yourself.',
    scopes: READ_SCOPES,
  },
];

const CONTEXT_PACKET_CARDS = [
  {
    title: 'Company memory',
    detail: 'Org-wide wiki knowledge the AI app can use across projects and channels.',
  },
  {
    title: 'Channel memory',
    detail: 'Knowledge created in, cited from, or scoped to the space where the work is happening.',
  },
  {
    title: 'Personal memory',
    detail: 'Private notes and memories scoped to the connected human user.',
  },
];

const READ_TEST_PROMPTS = [
  'Check my unread messages and tell me what needs my attention.',
  'List my open tasks, find blockers, and suggest the next action.',
  'Search wiki for launch blockers, then summarize what changed recently.',
  'Show me which Deft capabilities and tools this connection can use.',
];

type RemoteReadiness = {
  public_url: string;
  mcp_endpoint_url: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  protected_resource_metadata: string;
  authorization_server_metadata: string;
  https_ready: boolean;
  scopes: string[];
  profiles?: string[];
};

type AuditReceipt = {
  title: string;
  detail: string;
  href?: string;
  target_kind?: string;
  target_id?: string;
  preview?: string;
};

type OAuthAuditAction = {
  id: string;
  event: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  receipt?: AuditReceipt;
};

type OAuthGrant = {
  id: string;
  client_id: string;
  app_name: string;
  connector_profile: string;
  scopes: string[];
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  recent_actions: OAuthAuditAction[];
};

type RevokedMcpToken = McpToken & {
  revoked_at: string;
  recent_actions: OAuthAuditAction[];
};

type RevokedOAuthGrant = OAuthGrant & {
  revoked_at: string;
};

type McpAccessHistory = {
  revoked_tokens: RevokedMcpToken[];
  revoked_grants: RevokedOAuthGrant[];
};

function formatDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : 'never';
}

function actionTitle(action: OAuthAuditAction) {
  if (action.receipt?.title) return action.receipt.title;
  const metadata = action.metadata ?? {};
  const toolName = typeof metadata.tool_name === 'string' ? metadata.tool_name : null;
  if (action.event === 'token_issued') return 'Token created';
  if (action.event === 'token_revoked') return 'Token revoked';
  if (action.event === 'grant_revoked') return 'App connection revoked';
  if (action.event === 'mcp_tool_call') return toolName ? `Called ${toolName}` : 'Tool call';
  if (action.event === 'mcp_idempotency_result') {
    if (toolName === 'task_create') return 'Created task';
    if (toolName === 'task_transition') return 'Changed task status';
    if (toolName === 'task_update') return 'Updated task';
    if (toolName === 'comment_on_task') return 'Commented on task';
    if (toolName === 'message_post' || toolName === 'send_message') return 'Sent message';
    if (toolName === 'memory_write' || toolName === 'wiki_upsert') return 'Saved knowledge';
    return toolName ? `${toolName} completed` : 'Write completed';
  }
  return action.event.replaceAll('_', ' ');
}

function actionResult(action: OAuthAuditAction): Record<string, unknown> | null {
  const metadata = action.metadata ?? {};
  const result = metadata.result;
  if (!result || typeof result !== 'object') return null;
  const content = (result as { content?: Array<{ text?: string }> }).content;
  const text = Array.isArray(content) ? content[0]?.text : null;
  if (typeof text !== 'string') return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function actionDetail(action: OAuthAuditAction) {
  if (action.receipt?.detail) return action.receipt.detail;
  const metadata = action.metadata ?? {};
  const toolName = typeof metadata.tool_name === 'string' ? metadata.tool_name : null;
  const result = actionResult(action);
  if (action.event === 'token_issued') {
    const scopes = Array.isArray(metadata.scopes) ? metadata.scopes.length : null;
    return scopes ? `${scopes} scopes granted` : 'ready to use';
  }
  if (action.event === 'token_revoked' || action.event === 'grant_revoked') return 'access removed';
  if (toolName === 'task_create' && result) {
    const number = result.number ? `#${result.number}` : 'task';
    return `${number}: ${String(result.title ?? '').slice(0, 80)}`;
  }
  if (toolName === 'task_transition' && result) {
    const transition = result.transition as { from?: string; to?: string } | undefined;
    const taskKey = result.task_key ?? result.number ?? 'task';
    return `${taskKey}: ${transition?.from ?? 'previous'} -> ${transition?.to ?? result.status ?? 'updated'}`;
  }
  if ((toolName === 'message_post' || toolName === 'send_message') && result) {
    return `message in ${String(result.space_id ?? 'space').slice(0, 8)}...`;
  }
  const pieces = [
    typeof metadata.surface === 'string' ? metadata.surface : null,
    typeof metadata.target_id === 'string' ? metadata.target_id : null,
    typeof metadata.success === 'boolean' ? (metadata.success ? 'ok' : 'failed') : null,
  ].filter(Boolean);
  return pieces.length > 0 ? pieces.join(' / ') : 'recorded';
}

function actionHref(action: OAuthAuditAction) {
  if (action.receipt?.href) return action.receipt.href;
  const toolName = typeof action.metadata?.tool_name === 'string' ? action.metadata.tool_name : null;
  const result = actionResult(action);
  if (!result) return null;
  if (
    (toolName === 'task_create' ||
      toolName === 'task_transition' ||
      toolName === 'task_update' ||
      toolName === 'comment_on_task') &&
    typeof result.id === 'string'
  ) {
    return `/tasks?task=${encodeURIComponent(result.id)}`;
  }
  if (
    (toolName === 'message_post' || toolName === 'send_message') &&
    typeof result.id === 'string' &&
    typeof result.space_id === 'string'
  ) {
    return `/chat?space=${encodeURIComponent(result.space_id)}&message=${encodeURIComponent(result.id)}`;
  }
  return null;
}

function clientById(id: ClientId) {
  return CLIENT_OPTIONS.find((client) => client.id === id) ?? CLIENT_OPTIONS[0]!;
}

function clientIcon(id: ClientId) {
  if (id === 'codex' || id === 'claude-code') return <Code2 size={16} />;
  if (id === 'claude-desktop' || id === 'remote-web') return <Globe2 size={16} />;
  if (id === 'headless' || id === 'custom') return <Wrench size={16} />;
  return <Bot size={16} />;
}

function RecentActionList({ actions }: { actions?: OAuthAuditAction[] }) {
  if (!actions?.length) {
    return (
      <div className="mt-2 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
        No recent actions recorded.
      </div>
    );
  }
  return (
    <div className="mt-2 space-y-1.5">
      {actions.slice(0, 5).map((action) => {
        const href = actionHref(action);
        const content = (
          <>
            <span className="min-w-0 break-words" style={{ color: 'var(--text-secondary)' }}>
              {actionTitle(action)} <span style={{ color: 'var(--text-tertiary)' }}>({actionDetail(action)})</span>
            </span>
            <span className="shrink-0" style={{ color: 'var(--text-tertiary)' }}>
              {formatDate(action.created_at)}
            </span>
          </>
        );
        return href ? (
          <Link
            key={action.id}
            href={href}
            className="grid gap-1 text-xs sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-3 hover:underline"
          >
            {content}
          </Link>
        ) : (
          <div key={action.id} className="grid gap-1 text-xs sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-3">
            {content}
          </div>
        );
      })}
    </div>
  );
}

function permissionLabel(scope: string) {
  const labels: Record<string, string> = {
    'read:workspace': 'View workspace context, people and projects',
    'read:wiki': 'Read accessible knowledge and memory',
    'read:tasks': 'Read tasks, comments and progress',
    'read:messages': 'Read accessible conversations and unread messages',
    'read:calendar': 'Read your calendar context',
    'read:modules': 'Read accessible module records',
    'write:tasks': 'Create and update tasks and comments',
    'write:messages': 'Post messages in conversations you can access',
    'write:wiki': 'Create and update accessible knowledge',
    'write:calendar': 'Create, update and cancel your Deft events',
    'write:modules': 'Create, update and archive module records',
    'write:workspace': 'Manage your notes, inbox, approvals, projects and agent operations',
    'read:apps': 'View installed apps, permissions and health',
    'invoke:apps': 'Prepare and invoke reviewed app actions',
    'read:app-runs': 'Read authorized app run status and results',
  };
  return labels[scope] ?? scope;
}

function accessSummary(scopes: string[]) {
  if (!scopes.length) return 'No permissions granted.';
  if (scopes.every((scope) => scope.startsWith('read:'))) return 'Read-only access within its granted permissions.';
  if (scopes.some((scope) => scope.startsWith('write:') || scope.startsWith('invoke:')))
    return 'Can read or make changes within its granted permissions.';
  return 'Access is defined by the permissions below.';
}

function PermissionDetails({ scopes }: { scopes: string[] }) {
  return (
    <details className="mt-3 text-sm">
      <summary className="cursor-pointer font-medium">View {scopes.length} permissions</summary>
      <ul className="mt-3 space-y-3">
        {scopes.map((scope) => (
          <li key={scope}>
            <span className="block">{permissionLabel(scope)}</span>
            <code className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {scope}
            </code>
          </li>
        ))}
      </ul>
    </details>
  );
}

function CopyControl({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: string | null;
  onCopy: (label: string, value: string) => Promise<void>;
}) {
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      onClick={() => void onCopy(label, value)}
      className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-lg border px-3 text-xs focus-visible:outline-2"
      style={{ borderColor: 'var(--border-default)' }}
    >
      {copied === label ? <Check size={14} /> : <Copy size={14} />}
      <span role="status">{copied === label ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

export default function McpAccessPage() {
  useSetPageContext(<span className="text-sm font-semibold">Personal AI connections</span>, []);
  const [tokens, setTokens] = useState<McpToken[]>([]);
  const [remote, setRemote] = useState<RemoteReadiness | null>(null);
  const [grants, setGrants] = useState<OAuthGrant[]>([]);
  const [history, setHistory] = useState<McpAccessHistory | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selectedClient, setSelectedClient] = useState<ClientId>('codex');
  const [accessPreset, setAccessPreset] = useState<AccessPreset>('work');
  const [customScopes, setCustomScopes] = useState<string[]>(READ_SCOPES);
  const [tokenName, setTokenName] = useState('Codex');
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setupStep, setSetupStep] = useState(0);
  const [tokenSaved, setTokenSaved] = useState(false);
  const [issuedTokenId, setIssuedTokenId] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupStarted, setSetupStarted] = useState(false);
  const [connectionQuery, setConnectionQuery] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [selectedGrantId, setSelectedGrantId] = useState('');
  const [loadFailures, setLoadFailures] = useState<string[]>([]);
  const loadRequest = useRef(0);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const connectionsAction = useRef<HTMLButtonElement>(null);
  const revokeAction = useRef<HTMLButtonElement>(null);
  const revokeTriggers = useRef<Record<string, HTMLButtonElement | null>>({});
  const previousRevoke = useRef<string | null>(null);
  const focusStep = useRef(false);
  const setupSteps = ['Choose app', 'Review access', 'Connect', 'Verify'] as const;

  function moveStep(next: number) {
    focusStep.current = true;
    setSetupStep(next);
  }

  useLayoutEffect(() => {
    if (focusStep.current) {
      (setupOpen ? stepHeading.current : connectionsAction.current)?.focus();
      focusStep.current = false;
    }
  }, [setupStep, setupOpen]);

  useLayoutEffect(() => {
    if (confirmRevoke) revokeAction.current?.focus();
    else if (previousRevoke.current)
      (revokeTriggers.current[previousRevoke.current] ?? connectionsAction.current)?.focus();
    previousRevoke.current = confirmRevoke;
  }, [confirmRevoke]);

  const selectedClientOption = clientById(selectedClient);
  const selectedScopes = useMemo(() => {
    if (accessPreset === 'read') return READ_SCOPES;
    if (accessPreset === 'work') return COLLABORATE_SCOPES;
    if (accessPreset === 'operate') return ALL_SCOPES;
    return customScopes;
  }, [accessPreset, customScopes]);

  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    setLoading(true);
    const resources = [
      ['Personal tokens', '/api/mcp-access/tokens'],
      ['Connector settings', '/api/oauth/readiness'],
      ['App authorizations', '/api/oauth/grants'],
      ['Connection history', '/api/mcp-access/history'],
    ] as const;
    const results = await Promise.allSettled(
      resources.map(async ([, path]) => {
        const response = await api.get(path);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      }),
    );
    if (request !== loadRequest.current) return;
    const [tokenResult, readinessResult, grantResult, historyResult] = results;
    if (tokenResult.status === 'fulfilled') {
      setTokens(tokenResult.value.tokens ?? []);
      setEndpoint(tokenResult.value.mcp_endpoint_url ?? '');
    }
    setRemote(readinessResult.status === 'fulfilled' ? readinessResult.value : null);
    if (grantResult.status === 'fulfilled') setGrants(grantResult.value.grants ?? []);
    if (historyResult.status === 'fulfilled')
      setHistory({
        revoked_tokens: historyResult.value.revoked_tokens ?? [],
        revoked_grants: historyResult.value.revoked_grants ?? [],
      });
    setLoadFailures(results.flatMap((result, index) => (result.status === 'rejected' ? [resources[index][0]] : [])));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function chooseClient(id: ClientId) {
    if (busy || newToken || id === selectedClient) return;
    const client = clientById(id);
    setSelectedClient(id);
    setAccessPreset(client.defaultPreset);
    setTokenName(client.tokenName);
    setNewToken(null);
    if (client.defaultPreset === 'custom') setCustomScopes(READ_SCOPES);
  }

  function toggleCustomScope(scope: string) {
    setCustomScopes((current) =>
      current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope],
    );
  }

  async function copy(label: string, value: string) {
    setError(null);
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setError('Could not copy to the clipboard. Select and copy the text manually.');
    }
  }

  async function createToken() {
    if (busy || newToken || !selectedScopes.length) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/api/mcp-access/tokens', {
        name: tokenName.trim() || selectedClientOption.tokenName,
        scopes: selectedScopes,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = await res.json();
      setNewToken(body.token);
      setIssuedTokenId(body.token_id ?? null);
      setTokenSaved(false);
      setEndpoint(body.mcp_endpoint_url ?? endpoint);
      await load();
      setConfirmRevoke(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.delete(`/api/mcp-access/tokens/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
      setConfirmRevoke(null);
    } catch {
      setError('Could not confirm revocation. Refresh the connection list to check its status, then try again.');
    } finally {
      setBusy(false);
    }
  }

  async function revokeGrant(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.delete(`/api/oauth/grants/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
      setConfirmRevoke(null);
    } catch {
      setError('Could not confirm revocation. Refresh the connection list to check its status, then try again.');
    } finally {
      setBusy(false);
    }
  }

  const endpointForConfig = endpoint || '<deft-api-url>/api/mcp/v1';
  const tokenForConfig = newToken ?? '<paste-token-here>';

  const selectedSnippet = useMemo(() => {
    if (selectedClient === 'codex') {
      return {
        title: 'Codex config',
        detail: 'Paste this into your Codex MCP server config.',
        value: [
          '[mcp_servers.deft]',
          `url = "${endpointForConfig}"`,
          `http_headers = { Authorization = "Bearer ${tokenForConfig}" }`,
        ].join('\n'),
      };
    }
    if (selectedClient === 'claude-code') {
      return {
        title: 'Claude Code CLI',
        detail:
          'Run this in a terminal. Then use /mcp in Claude Code to verify the connection. Do not paste the token into a Claude chat.',
        value: `claude mcp add --transport http --scope user deft "${endpointForConfig}" --header "Authorization: Bearer ${tokenForConfig}"`,
      };
    }
    return {
      title: 'Raw endpoint and bearer header',
      detail: 'Use this when your client asks for the MCP URL and authorization header separately.',
      value: [`MCP URL: ${endpointForConfig}`, `Authorization: Bearer ${tokenForConfig}`].join('\n'),
    };
  }, [endpointForConfig, selectedClient, tokenForConfig]);

  const tokenSetupClient = selectedClientOption.setupKind === 'token' || selectedClientOption.setupKind === 'advanced';
  const issuedConnection = tokens.find((token) => token.id === issuedTokenId);
  const historyCount = (history?.revoked_tokens.length ?? 0) + (history?.revoked_grants.length ?? 0);
  const remoteRows: Array<[string, string | undefined]> = [
    ['Connector URL', remote?.mcp_endpoint_url],
    ['Protected resource metadata', remote?.protected_resource_metadata],
    ['OAuth metadata', remote?.authorization_server_metadata],
    ['Authorization endpoint', remote?.authorization_endpoint],
    ['Token endpoint', remote?.token_endpoint],
    ['Registration endpoint', remote?.registration_endpoint],
  ];
  const isClaudeConnector = selectedClient === 'claude-desktop';
  const remoteSteps = isClaudeConnector
    ? [
        'In Claude, open Settings or Customize -> Connectors. Do not paste MCP JSON or tokens into a chat.',
        'Add a custom connector and use the Connector URL below.',
        'Click Connect in Claude. On the Deft approval screen, choose the exact read and write permissions before allowing access.',
        'Enable the connector for the chat where Claude should use Deft tools.',
      ]
    : [
        'In ChatGPT web, enable developer mode for an eligible account, then open Settings -> Apps -> Create.',
        'Use the Connector URL below and choose OAuth authentication. Deft publishes the discovery metadata automatically.',
        'Click Scan Tools and complete the Deft authorization screen. Deft starts scope-less connections read-only; add write permissions only when your ChatGPT plan supports full MCP.',
        "Create the draft app, enable it in a new chat, and confirm a read. On Business or Enterprise/Edu, test a write action and approve ChatGPT's confirmation prompt.",
      ];
  const claudeConnectorFields = [
    {
      label: 'Name',
      value: 'Deft',
      copyValue: 'Deft',
      help: 'This is the display name Claude will show in its connector list.',
    },
    {
      label: 'Remote MCP server URL',
      value: remote?.mcp_endpoint_url ?? (loading ? 'Loading connector URL...' : 'Connector URL unavailable'),
      copyValue: remote?.mcp_endpoint_url,
      help: "Paste this into Claude's required URL field.",
    },
    {
      label: 'OAuth Client ID (optional)',
      value: 'Leave blank',
      help: 'Deft supports dynamic client registration, so Claude should create its own client during Connect.',
    },
    {
      label: 'OAuth Client Secret (optional)',
      value: 'Leave blank',
      help: 'Deft uses public-client OAuth with PKCE and token_endpoint_auth_method=none. No shared secret is needed.',
    },
  ];

  const connections = [
    ...tokens.map((token) => ({
      ...token,
      key: `token:${token.id}`,
      kind: 'token' as const,
      label: 'Personal token',
      displayName: token.name,
    })),
    ...grants.map((grant) => ({
      ...grant,
      key: `grant:${grant.id}`,
      kind: 'grant' as const,
      label: 'App authorization',
      displayName: grant.app_name,
    })),
  ];
  const filteredConnections = connections.filter((connection) =>
    `${connection.displayName} ${connection.label}`.toLowerCase().includes(connectionQuery.trim().toLowerCase()),
  );
  const inventoryFailures = loadFailures.filter((name) => name === 'Personal tokens' || name === 'App authorizations');
  const selectedPreset = PRESETS.find((preset) => preset.id === accessPreset)!;
  const verificationConnection = tokenSetupClient
    ? issuedConnection
    : grants.find((grant) => grant.id === selectedGrantId);
  const verificationUnavailable = loadFailures.includes(tokenSetupClient ? 'Personal tokens' : 'App authorizations');
  const promptScopes = verificationConnection?.scopes ?? selectedScopes;
  const prompt = promptScopes.includes('read:messages')
    ? READ_TEST_PROMPTS[0]
    : promptScopes.includes('read:tasks')
      ? READ_TEST_PROMPTS[1]
      : promptScopes.includes('read:wiki')
        ? READ_TEST_PROMPTS[2]
        : READ_TEST_PROMPTS[3];
  const border = { borderColor: 'var(--border-default)' };
  const muted = { color: 'var(--text-secondary)' };
  const buttonClass =
    'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40';
  const primaryStyle = {
    background: 'var(--connection-action)',
    borderColor: 'var(--connection-action)',
    color: 'white',
  };

  function openSetup() {
    focusStep.current = true;
    setSetupStarted(true);
    setSetupOpen(true);
    setError(null);
  }

  function closeSetup() {
    focusStep.current = true;
    setSetupOpen(false);
  }

  function finishSetup() {
    closeSetup();
    setSetupStarted(false);
    setSetupStep(0);
    setNewToken(null);
    setIssuedTokenId(null);
    setTokenSaved(false);
    setSelectedGrantId('');
  }

  return (
    <div className={`${styles.page} flex h-full min-w-0 flex-col overflow-x-hidden overflow-y-auto`}>
      <div className="mx-auto w-full min-w-0 max-w-4xl space-y-6 px-4 pb-12 md:px-6">
        <header className="border-b pb-6 pt-7" style={border}>
          <h1 className="text-2xl font-semibold tracking-tight">Personal AI connections</h1>
          <p className="mt-2 text-sm leading-6" style={muted}>
            Connect your AI apps to Deft. You control their access.
          </p>
        </header>
        {error && !setupOpen && !confirmRevoke && (
          <div
            role="alert"
            className="flex items-start justify-between gap-3 rounded-lg border p-4 text-sm"
            style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
          >
            <p>{error}</p>
            <button type="button" onClick={() => setError(null)} className="shrink-0 underline">
              Dismiss
            </button>
          </div>
        )}

        {!setupOpen ? (
          <>
            <section aria-labelledby="connections-heading">
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 id="connections-heading" className="text-lg font-semibold">
                    Your connections
                  </h2>
                  <p className="mt-1 text-sm" style={muted}>
                    These apps act as you and can only access work you can see.
                  </p>
                </div>
                <button
                  ref={connectionsAction}
                  type="button"
                  onClick={openSetup}
                  className={buttonClass}
                  style={primaryStyle}
                >
                  <Plug size={16} />
                  {setupStarted ? 'Resume setup' : 'Add connection'}
                </button>
              </div>
              {newToken && !tokenSaved && (
                <p role="status" className="mb-4 rounded-lg border p-3 text-sm" style={border}>
                  Your new token is still in setup. Resume to save it before refreshing or leaving this page.
                </p>
              )}
              <div className="mb-4 flex gap-3">
                <label className="min-w-0 flex-1">
                  <span className="sr-only">Search connections</span>
                  <input
                    type="search"
                    value={connectionQuery}
                    onChange={(event) => setConnectionQuery(event.target.value)}
                    placeholder="Search connections"
                    className="h-10 w-full rounded-lg border bg-transparent px-3 text-sm focus-visible:outline-2"
                    style={border}
                  />
                </label>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void load()}
                  className={buttonClass}
                  style={border}
                >
                  {loading ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>
              {inventoryFailures.length > 0 && (
                <p role="alert" className="mb-4 text-sm" style={{ color: 'var(--danger)' }}>
                  Could not refresh {inventoryFailures.join(' and ').toLowerCase()}. The list may be incomplete or out
                  of date. Retry with Refresh.
                </p>
              )}
              {loading && connections.length === 0 ? (
                <p role="status" className="py-8 text-sm" style={muted}>
                  Loading your connections…
                </p>
              ) : filteredConnections.length === 0 ? (
                <div className="rounded-xl border border-dashed px-5 py-10 text-center" style={border}>
                  <h3 className="font-semibold">
                    {connectionQuery.trim()
                      ? 'No matching connections'
                      : inventoryFailures.length
                        ? 'Connections unavailable'
                        : 'Connect your first AI app'}
                  </h3>
                  <p className="mt-2 text-sm" style={muted}>
                    {connectionQuery.trim()
                      ? 'Try a different name or clear your search.'
                      : inventoryFailures.length
                        ? 'Refresh to try loading your connections again.'
                        : 'Bring your workspace into Codex, Claude or another supported client.'}
                  </p>
                  {connectionQuery.trim() && (
                    <button type="button" onClick={() => setConnectionQuery('')} className="mt-3 text-sm underline">
                      Clear search
                    </button>
                  )}
                </div>
              ) : (
                <div className={`${styles.connectionList} divide-y rounded-xl border`} style={border}>
                  {filteredConnections.map((connection) => (
                    <details key={connection.key} className="group px-4 py-1" style={border}>
                      <summary className="flex cursor-pointer list-none items-center gap-3 py-4 focus-visible:outline-2">
                        <span
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
                          style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}
                        >
                          {connection.kind === 'token' ? <KeyRound size={18} /> : <Globe2 size={18} />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block break-words text-sm font-semibold">{connection.displayName}</span>
                          <span className="mt-1 block text-xs leading-5" style={muted}>
                            {connection.label} ·{' '}
                            {connection.last_used_at
                              ? `Last used ${formatDate(connection.last_used_at)}`
                              : 'Not used yet'}
                          </span>
                        </span>
                        <ChevronDown size={16} className="shrink-0 transition-transform group-open:rotate-180" />
                      </summary>
                      <div className="space-y-5 border-t pb-5 pt-4" style={border}>
                        <div>
                          <h3 className="text-sm font-semibold">Access</h3>
                          <p className="mt-1 text-sm" style={muted}>
                            {accessSummary(connection.scopes)}
                          </p>
                          <PermissionDetails scopes={connection.scopes} />
                        </div>
                        <div>
                          <h3 className="text-sm font-semibold">Recent activity</h3>
                          <RecentActionList actions={connection.recent_actions} />
                        </div>
                        <p className="text-xs" style={muted}>
                          Added {formatDate(connection.created_at)}
                          {connection.kind === 'token'
                            ? ` · Token ${connection.token_prefix}…`
                            : ` · ${connection.connector_profile}`}
                        </p>
                        {confirmRevoke === connection.key ? (
                          <div className="rounded-lg border p-3" style={border}>
                            {error && (
                              <p role="alert" className="mb-3 text-sm" style={{ color: 'var(--danger)' }}>
                                {error}
                              </p>
                            )}
                            <p className="text-sm">
                              Revoke access for <strong>{connection.displayName}</strong>? It will stop accessing Deft.
                              To use it again, you will need to reconnect.
                            </p>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                  void (connection.kind === 'token'
                                    ? revoke(connection.id)
                                    : revokeGrant(connection.id))
                                }
                                className={buttonClass}
                                style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
                                ref={revokeAction}
                              >
                                {busy ? 'Revoking…' : 'Confirm revoke'}
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => setConfirmRevoke(null)}
                                className={buttonClass}
                                style={border}
                              >
                                Keep connection
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            ref={(node) => {
                              revokeTriggers.current[connection.key] = node;
                            }}
                            onClick={() => {
                              setConfirmRevoke(connection.key);
                              setError(null);
                            }}
                            className="text-sm font-medium"
                            style={{ color: 'var(--danger)' }}
                          >
                            Revoke access
                          </button>
                        )}
                      </div>
                    </details>
                  ))}
                </div>
              )}
            </section>

            <section className="border-t pt-5" style={border}>
              <button
                type="button"
                aria-expanded={historyOpen}
                onClick={() => setHistoryOpen(!historyOpen)}
                className="flex w-full items-center justify-between gap-3 py-2 text-left"
              >
                <span>
                  <span className="block text-sm font-semibold">Connection history</span>
                  <span className="mt-1 block text-xs" style={muted}>
                    Revoked connections and their last recorded activity.
                  </span>
                </span>
                <ChevronDown size={16} className={historyOpen ? 'rotate-180' : ''} />
              </button>
              {historyOpen && (
                <div className="mt-4 space-y-3">
                  {loadFailures.includes('Connection history') ? (
                    <p role="alert" className="text-sm">
                      History could not be refreshed. Use Refresh to retry.
                    </p>
                  ) : loading && !history ? (
                    <p role="status" className="text-sm">
                      Loading history…
                    </p>
                  ) : historyCount === 0 ? (
                    <p className="text-sm" style={muted}>
                      No revoked connections.
                    </p>
                  ) : (
                    [
                      ...(history?.revoked_tokens.map((token) => ({
                        ...token,
                        key: `token:${token.id}`,
                        displayName: token.name,
                        label: `Personal token ${token.token_prefix}…`,
                      })) ?? []),
                      ...(history?.revoked_grants.map((grant) => ({
                        ...grant,
                        key: `grant:${grant.id}`,
                        displayName: grant.app_name,
                        label: grant.connector_profile,
                      })) ?? []),
                    ].map((connection) => (
                      <details key={connection.key} className="rounded-lg border p-4" style={border}>
                        <summary className="cursor-pointer text-sm font-medium">
                          {connection.displayName}
                          <span className="mt-1 block text-xs font-normal" style={muted}>
                            Revoked {formatDate(connection.revoked_at)}
                          </span>
                        </summary>
                        <p className="mt-3 text-xs" style={muted}>
                          {connection.label} · Last used {formatDate(connection.last_used_at)}
                        </p>
                        <PermissionDetails scopes={connection.scopes} />
                        <RecentActionList actions={connection.recent_actions} />
                      </details>
                    ))
                  )}
                </div>
              )}
            </section>
          </>
        ) : (
          <section aria-labelledby="setup-heading" className={styles.setup}>
            <button
              type="button"
              onClick={closeSetup}
              className="mb-6 text-sm font-medium"
              style={{ color: 'var(--accent)' }}
            >
              ← Your connections
            </button>
            <SettingsSteps
              steps={selectedClientOption.setupKind === 'agent' ? setupSteps.slice(0, 3) : setupSteps}
              current={setupStep}
            />
            <h2
              id="setup-heading"
              ref={stepHeading}
              tabIndex={-1}
              className="scroll-mt-32 text-xl font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-4"
            >
              {setupStep === 0
                ? 'Which app would you like to connect?'
                : setupStep === 1
                  ? `Review access for ${selectedClientOption.name}`
                  : setupStep === 2
                    ? `Connect ${selectedClientOption.name}`
                    : 'Check your connection'}
            </h2>
            <p className="mb-7 mt-2 text-sm leading-6" style={muted}>
              {setupStep === 0
                ? 'Choose an app to see its setup instructions.'
                : setupStep === 1
                  ? 'Choose the access this app needs. Every action is recorded under your name.'
                  : setupStep === 2
                    ? 'Complete the setup in your app, then come back to check its activity.'
                    : 'Run a request from your app and check whether Deft receives it.'}
            </p>
            {error && (
              <p
                role="alert"
                className="mb-5 rounded-lg border p-3 text-sm"
                style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
              >
                {error}
              </p>
            )}
            {newToken && setupStep < 2 && (
              <p role="status" className="mb-5 rounded-lg border p-3 text-sm" style={border}>
                A token has already been issued with these permissions. Return to Connect to save it. Start another
                connection after finishing this setup to choose different access.
              </p>
            )}

            {setupStep === 0 && (
              <div className="space-y-2">
                {CLIENT_OPTIONS.map((client) => (
                  <button
                    key={client.id}
                    type="button"
                    disabled={busy || !!newToken}
                    aria-pressed={selectedClient === client.id}
                    onClick={() => chooseClient(client.id)}
                    className={`${styles.clientChoice} flex w-full items-center gap-3 rounded-lg border p-4 text-left focus-visible:outline-2 disabled:opacity-60`}
                    style={{
                      borderColor: selectedClient === client.id ? 'var(--accent)' : 'var(--border-default)',
                      background: selectedClient === client.id ? 'var(--accent-muted)' : 'transparent',
                    }}
                  >
                    <span style={{ color: 'var(--accent)' }}>{clientIcon(client.id)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold">{client.name}</span>
                      <span className="mt-1 block text-xs leading-5" style={muted}>
                        {client.setupKind === 'oauth'
                          ? 'Connect through your app’s settings using Deft authorization.'
                          : client.setupKind === 'agent'
                            ? 'A shared worker with its own workspace access.'
                            : client.setupKind === 'advanced'
                              ? 'Use a server URL and a personal token.'
                              : 'Use a personal token and a configuration for this app.'}
                      </span>
                    </span>
                    {selectedClient === client.id && (
                      <Check size={16} className="shrink-0" style={{ color: 'var(--accent)' }} />
                    )}
                  </button>
                ))}
              </div>
            )}

            {setupStep === 1 &&
              (tokenSetupClient ? (
                <fieldset disabled={busy || !!newToken} className="min-w-0 space-y-5">
                  <label className="block text-sm font-medium">
                    Access level
                    <select
                      value={accessPreset}
                      onChange={(event) => setAccessPreset(event.target.value as AccessPreset)}
                      className="mt-2 h-11 w-full rounded-lg border px-3 text-sm"
                      style={{ ...border, background: 'var(--surface-container)', color: 'var(--text-primary)' }}
                    >
                      {PRESETS.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.title}
                          {preset.id === selectedClientOption.defaultPreset ? ' (recommended)' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="rounded-lg p-4" style={{ background: 'var(--surface-container-low)' }}>
                    <h3 className="text-sm font-semibold">{selectedPreset.title}</h3>
                    <p className="mt-2 text-sm leading-6" style={muted}>
                      {selectedPreset.detail}
                    </p>
                    <p className="mt-2 text-sm leading-6" style={muted}>
                      This does not give the app access to other people’s private work or bypass workspace permissions.
                    </p>
                  </div>
                  {accessPreset === 'custom' ? (
                    <div className="divide-y" style={border}>
                      {AVAILABLE_SCOPES.map((scope) => (
                        <label key={scope} className="flex cursor-pointer items-start gap-3 py-3 text-sm leading-5">
                          <input
                            type="checkbox"
                            checked={customScopes.includes(scope)}
                            onChange={() => toggleCustomScope(scope)}
                            className="mt-1 shrink-0"
                          />
                          <span>{permissionLabel(scope)}</span>
                        </label>
                      ))}
                      {selectedScopes.length === 0 && (
                        <p role="status" className="pt-3 text-sm" style={{ color: 'var(--danger)' }}>
                          Select at least one permission to continue.
                        </p>
                      )}
                    </div>
                  ) : (
                    <PermissionDetails scopes={selectedScopes} />
                  )}
                </fieldset>
              ) : (
                <div className="space-y-4 text-sm leading-6" style={muted}>
                  <p>
                    {selectedClientOption.setupKind === 'agent'
                      ? 'Shared employees have their own workspace access, policies and activity. Configure those in Agent employees.'
                      : 'Your app will open Deft’s authorization screen. Review the requested permissions there before allowing access.'}
                  </p>
                  <p>
                    {selectedClientOption.setupKind === 'agent'
                      ? 'Your personal token will not be used to represent a shared employee.'
                      : 'You can inspect and revoke the resulting connection from Your connections.'}
                  </p>
                </div>
              ))}

            {setupStep === 2 && tokenSetupClient && (
              <div className="space-y-6">
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void createToken();
                  }}
                  className="space-y-3"
                >
                  <label className="block text-sm font-medium">
                    Connection name
                    <input
                      value={tokenName}
                      disabled={busy || !!newToken}
                      onChange={(event) => setTokenName(event.target.value)}
                      className="mt-2 h-11 w-full rounded-lg border bg-transparent px-3 text-sm"
                      style={border}
                    />
                  </label>
                  <p className="text-xs" style={muted}>
                    {accessSummary(selectedScopes)} Go back to review the permissions.
                  </p>
                  {!newToken && (
                    <button
                      type="submit"
                      disabled={busy || !selectedScopes.length}
                      className={buttonClass}
                      style={primaryStyle}
                    >
                      {busy ? 'Generating…' : 'Generate token'}
                    </button>
                  )}
                </form>
                {newToken && (
                  <div className="space-y-3 rounded-xl border p-4" style={border}>
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-sm font-semibold">Save your token</h3>
                      <CopyControl label="token" value={newToken} copied={copied} onCopy={copy} />
                    </div>
                    <p className="text-sm leading-6" style={muted}>
                      It is shown only during this setup. Store it securely and never paste it into an AI chat.
                    </p>
                    <pre
                      tabIndex={0}
                      aria-label="New token"
                      className="max-w-full overflow-x-auto rounded-lg p-3 text-xs"
                      style={{ background: 'var(--surface-container-low)' }}
                    >
                      {newToken}
                    </pre>
                    <label className="flex items-start gap-3 text-sm">
                      <input
                        type="checkbox"
                        checked={tokenSaved}
                        onChange={(event) => setTokenSaved(event.target.checked)}
                        className="mt-1 shrink-0"
                      />
                      <span>I have saved this token securely.</span>
                    </label>
                  </div>
                )}
                <div className="min-w-0 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold">{selectedSnippet.title}</h3>
                    <CopyControl
                      label={selectedSnippet.title}
                      value={selectedSnippet.value}
                      copied={copied}
                      onCopy={copy}
                    />
                  </div>
                  <p className="text-sm leading-6" style={muted}>
                    {selectedSnippet.detail}
                  </p>
                  {!newToken && (
                    <p className="text-xs" style={muted}>
                      Preview only. Generate a token to fill in the authorization value.
                    </p>
                  )}
                  <pre
                    tabIndex={0}
                    aria-label={selectedSnippet.title}
                    className="max-h-64 max-w-full overflow-auto rounded-xl border p-4 text-xs leading-6"
                    style={{ ...border, background: 'var(--surface-container-low)' }}
                  >
                    {selectedSnippet.value}
                  </pre>
                </div>
                {!tokenSaved && (
                  <p className="text-sm" style={muted}>
                    {newToken
                      ? 'Confirm that you saved the token before continuing.'
                      : 'Generate a token and save it to continue.'}
                  </p>
                )}
              </div>
            )}

            {setupStep === 2 && selectedClientOption.setupKind === 'oauth' && (
              <div className="space-y-6">
                {!remote ? (
                  <div role="alert" className="rounded-lg border p-4 text-sm" style={border}>
                    <p>
                      {loading
                        ? 'Loading connector settings…'
                        : 'Connector settings are unavailable. Retry before connecting your app.'}
                    </p>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => void load()}
                      className={`${buttonClass} mt-3`}
                      style={border}
                    >
                      Retry connector settings
                    </button>
                  </div>
                ) : (
                  !remote.https_ready && (
                    <p role="status" className="rounded-lg border p-4 text-sm" style={border}>
                      Your Deft server needs a public HTTPS address before a hosted app can connect. Ask your workspace
                      administrator to configure it.
                    </p>
                  )
                )}
                <ol className="list-decimal space-y-3 pl-5 text-sm leading-6" style={muted}>
                  {remoteSteps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                {isClaudeConnector ? (
                  <div className="divide-y rounded-xl border px-4" style={border}>
                    {claudeConnectorFields.map((field) => (
                      <div key={field.label} className="py-4" style={border}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h3 className="text-sm font-medium">{field.label}</h3>
                            <p className="mt-1 break-all text-sm" style={muted}>
                              {field.value}
                            </p>
                          </div>
                          {field.copyValue && (
                            <CopyControl label={field.label} value={field.copyValue} copied={copied} onCopy={copy} />
                          )}
                        </div>
                        <p className="mt-2 text-xs leading-5" style={muted}>
                          {field.help}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="min-w-0 rounded-xl border p-4" style={border}>
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-sm font-medium">Connector URL</h3>
                      {remote?.mcp_endpoint_url && (
                        <CopyControl
                          label="Connector URL"
                          value={remote.mcp_endpoint_url}
                          copied={copied}
                          onCopy={copy}
                        />
                      )}
                    </div>
                    <p className="mt-3 break-all text-sm" style={muted}>
                      {remote?.mcp_endpoint_url ?? 'Unavailable'}
                    </p>
                  </div>
                )}
                <p className="text-sm leading-6" style={muted}>
                  Sign in through Deft’s authorization screen. Do not paste a personal token into a hosted AI chat.
                </p>
              </div>
            )}

            {setupStep === 2 && selectedClientOption.setupKind === 'agent' && (
              <p className="text-sm leading-6" style={muted}>
                Continue in Agent employees to create or manage the shared worker, choose its access and configure its
                runtime.
              </p>
            )}

            {setupStep === 3 && (
              <div className="space-y-6">
                {!tokenSetupClient && (
                  <label className="block text-sm font-medium">
                    Connection to check
                    <select
                      value={selectedGrantId}
                      onChange={(event) => setSelectedGrantId(event.target.value)}
                      className="mt-2 h-11 w-full rounded-lg border px-3 text-sm"
                      style={{ ...border, background: 'var(--surface-container)' }}
                    >
                      <option value="">Choose an authorized app</option>
                      {grants.map((grant) => (
                        <option key={grant.id} value={grant.id}>
                          {grant.app_name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div role="status" className="rounded-xl border p-5" style={border}>
                  <h3 className="font-semibold">
                    {loading
                      ? 'Checking activity…'
                      : verificationUnavailable
                        ? 'Activity is unavailable'
                        : verificationConnection?.last_used_at
                          ? 'Deft received a request'
                          : !tokenSetupClient && !selectedGrantId
                            ? 'Choose your connection to verify'
                            : 'Waiting for the first request'}
                  </h3>
                  <p className="mt-2 text-sm leading-6" style={muted}>
                    {verificationUnavailable
                      ? 'We could not refresh the activity. Retry to check the latest status.'
                      : verificationConnection?.last_used_at
                        ? `Last used ${formatDate(verificationConnection.last_used_at)}. Review the recorded action to confirm it is the one you expected.`
                        : 'Completing setup does not confirm connectivity. Run the prompt below in your app, then check again.'}
                  </p>
                  {verificationConnection && <RecentActionList actions={verificationConnection.recent_actions} />}
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => void load()}
                    className={`${buttonClass} mt-4`}
                    style={border}
                  >
                    Check again
                  </button>
                </div>
                <div>
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold">Try this in your app</h3>
                    <CopyControl label="test prompt" value={prompt} copied={copied} onCopy={copy} />
                  </div>
                  <p
                    className="mt-3 rounded-lg p-4 text-sm leading-6"
                    style={{ background: 'var(--surface-container-low)' }}
                  >
                    {prompt}
                  </p>
                </div>
                <details className="text-sm">
                  <summary className="cursor-pointer font-medium">Still not connecting?</summary>
                  <ul className="mt-3 list-disc space-y-2 pl-5 leading-6" style={muted}>
                    <li>Check the server URL and your app’s connection status.</li>
                    <li>
                      {tokenSetupClient
                        ? 'Return to Connect and make sure the complete bearer token was copied into the configuration.'
                        : 'Finish authorization in your app, then refresh and select the new connection above.'}
                    </li>
                    <li>Check the permissions if the connection works but a specific action is denied.</li>
                  </ul>
                </details>
              </div>
            )}

            <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t pt-5" style={border}>
              <button
                type="button"
                disabled={busy}
                onClick={() => (setupStep === 0 ? closeSetup() : moveStep(setupStep - 1))}
                className={buttonClass}
                style={border}
              >
                {setupStep === 0 ? 'Cancel' : 'Back'}
              </button>
              {setupStep === 2 && selectedClientOption.setupKind === 'agent' ? (
                <Link href="/settings/agent-employees" className={buttonClass} style={primaryStyle}>
                  Open Agent Employees
                </Link>
              ) : setupStep < 3 ? (
                <button
                  type="button"
                  disabled={
                    busy ||
                    (setupStep === 1 && tokenSetupClient && !selectedScopes.length) ||
                    (setupStep === 2 && tokenSetupClient && (!newToken || !tokenSaved)) ||
                    (setupStep === 2 && selectedClientOption.setupKind === 'oauth' && (!remote || !remote.https_ready))
                  }
                  onClick={() => moveStep(setupStep + 1)}
                  className={buttonClass}
                  style={primaryStyle}
                >
                  {setupStep === 0 ? 'Review access' : setupStep === 1 ? 'Continue to connect' : 'Check connection'}
                </button>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setNewToken(null);
                      setIssuedTokenId(null);
                      setTokenSaved(false);
                      setSelectedGrantId('');
                      moveStep(0);
                    }}
                    className={buttonClass}
                    style={border}
                  >
                    Connect another app
                  </button>
                  <button type="button" onClick={finishSetup} className={buttonClass} style={primaryStyle}>
                    Your connections
                  </button>
                </div>
              )}
            </div>
          </section>
        )}

        <section className="border-t pt-5" style={border}>
          <button
            type="button"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen(!advancedOpen)}
            className="flex w-full items-center justify-between gap-3 py-2 text-left"
          >
            <span>
              <span className="block text-sm font-semibold">Developer details</span>
              <span className="mt-1 block text-xs" style={muted}>
                Server endpoints, supported permissions and memory context.
              </span>
            </span>
            <ChevronDown size={16} className={advancedOpen ? 'rotate-180' : ''} />
          </button>
          {advancedOpen && (
            <div className="mt-4 space-y-5">
              {loadFailures.includes('Connector settings') && (
                <div role="alert" className="text-sm">
                  <p>Connector metadata is unavailable.</p>
                  <button type="button" disabled={loading} onClick={() => void load()} className="mt-2 underline">
                    Retry loading metadata
                  </button>
                </div>
              )}
              {[['MCP endpoint', endpoint || undefined], ...remoteRows].map(([label, value]) => (
                <div key={label} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-xs font-medium">{label}</h3>
                    <code className="mt-1 block break-all text-xs" style={muted}>
                      {value ?? 'Unavailable'}
                    </code>
                  </div>
                  {value && <CopyControl label={label!} value={value} copied={copied} onCopy={copy} />}
                </div>
              ))}
              <PermissionDetails scopes={remote?.scopes ?? AVAILABLE_SCOPES} />
              <details className="text-sm">
                <summary className="cursor-pointer font-medium">Memory context</summary>
                <dl className="mt-3 space-y-3">
                  {CONTEXT_PACKET_CARDS.map((card) => (
                    <div key={card.title}>
                      <dt className="font-medium">{card.title}</dt>
                      <dd className="mt-1 leading-6" style={muted}>
                        {card.detail}
                      </dd>
                    </div>
                  ))}
                </dl>
              </details>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
