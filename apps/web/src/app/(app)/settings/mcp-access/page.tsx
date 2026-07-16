'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Globe2,
  History,
  KeyRound,
  Loader2,
  Plug,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wrench,
} from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { TabStrip } from '@/components/tab-strip';

type McpToken = {
  id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  created_at: string;
  recent_actions?: OAuthAuditAction[];
};

const READ_SCOPES = ['read:workspace', 'read:wiki', 'read:tasks', 'read:messages', 'read:calendar'];
const WRITE_SCOPES = ['write:tasks', 'write:messages', 'write:wiki', 'write:calendar', 'write:workspace'];
const ALL_SCOPES = [...READ_SCOPES, ...WRITE_SCOPES];

const SCOPE_LABELS: Record<string, string> = {
  'read:workspace': 'Workspace map, teammates, projects, receipts, and activity context',
  'read:wiki': 'Company, channel, and personal memory packets',
  'read:tasks': 'Task lists, task detail, comments, and progress',
  'read:messages': 'Visible spaces, threads, unread work, and chat search',
  'read:calendar': 'Native and ICS calendar context',
  'write:tasks': 'Create, update, transition, and comment on tasks',
  'write:messages': 'Post messages into spaces and DMs you can access',
  'write:wiki': 'Save or update wiki knowledge as you',
  'write:calendar': 'Create, update, and cancel your native Deft calendar events',
  'write:workspace': 'Manage your notes, inbox, approvals, projects, and agent operations',
};

type ClientId = 'codex' | 'claude-code' | 'claude-desktop' | 'remote-web' | 'custom' | 'agent-employee';
type AccessPreset = 'read' | 'work' | 'custom';

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
    detail: 'Best for owner-operator workflows: triage messages, read tasks, write wiki, post updates, and leave receipts.',
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
    detail: 'Add Deft from Claude settings, not inside a chat. Claude connects from Anthropic cloud and authenticates through OAuth.',
    setupKind: 'oauth',
    defaultPreset: 'read',
    tokenName: 'Claude connector',
  },
  {
    id: 'remote-web',
    name: 'ChatGPT / other web apps',
    fit: 'Remote connector path',
    detail: 'Use this when a hosted AI app asks for a public MCP URL, OAuth metadata, or a custom connector.',
    setupKind: 'oauth',
    defaultPreset: 'read',
    tokenName: 'Remote AI app',
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
    title: 'Read-only assistant',
    detail: 'Can answer questions using visible workspace, task, chat, calendar, and wiki context.',
    scopes: READ_SCOPES,
  },
  {
    id: 'work',
    title: 'Work-capable assistant',
    detail: 'Can read context and do work as you: create tasks, post messages, and update wiki knowledge.',
    scopes: ALL_SCOPES,
  },
  {
    id: 'custom',
    title: 'Custom scopes',
    detail: 'Choose exact MCP scopes. Best for self-hosted admins and unusual clients.',
    scopes: READ_SCOPES,
  },
];

const TEST_PROMPTS = [
  'Check my unread messages and tell me what needs my attention.',
  'List my open tasks, find blockers, and suggest the next action.',
  'Search wiki for launch blockers, then summarize what changed recently.',
  'Create a follow-up task from this discussion, post an update, and show me the receipt.',
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
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
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
  if ((toolName === 'task_create' || toolName === 'task_transition' || toolName === 'task_update' || toolName === 'comment_on_task') && typeof result.id === 'string') {
    return `/tasks?task=${encodeURIComponent(result.id)}`;
  }
  if ((toolName === 'message_post' || toolName === 'send_message') && typeof result.id === 'string' && typeof result.space_id === 'string') {
    return `/chat?space=${encodeURIComponent(result.space_id)}&message=${encodeURIComponent(result.id)}`;
  }
  return null;
}

function isStale(value: string | null | undefined) {
  if (!value) return true;
  return Date.now() - new Date(value).getTime() > 1000 * 60 * 60 * 24 * 14;
}

function clientById(id: ClientId) {
  return CLIENT_OPTIONS.find((client) => client.id === id) ?? CLIENT_OPTIONS[0]!;
}

function clientIcon(id: ClientId) {
  if (id === 'codex' || id === 'claude-code') return <Code2 size={16} />;
  if (id === 'claude-desktop' || id === 'remote-web') return <Globe2 size={16} />;
  if (id === 'custom') return <Wrench size={16} />;
  return <Bot size={16} />;
}

function RecentActionList({ actions }: { actions?: OAuthAuditAction[] }) {
  if (!actions?.length) {
    return <div className="mt-2 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>No recent actions recorded.</div>;
  }
  return (
    <div className="mt-2 space-y-1.5">
      {actions.slice(0, 5).map((action) => {
        const href = actionHref(action);
        const content = (
          <>
            <span className="min-w-0 truncate" style={{ color: 'var(--text-secondary)' }}>
              {actionTitle(action)} <span style={{ color: 'var(--text-tertiary)' }}>({actionDetail(action)})</span>
            </span>
            <span className="shrink-0" style={{ color: 'var(--text-tertiary)' }}>{formatDate(action.created_at)}</span>
          </>
        );
        return href ? (
          <Link key={action.id} href={href} className="grid grid-cols-[1fr_auto] gap-3 text-[11px] hover:underline">
            {content}
          </Link>
        ) : (
          <div key={action.id} className="grid grid-cols-[1fr_auto] gap-3 text-[11px]">
            {content}
          </div>
        );
      })}
    </div>
  );
}

function ScopePill({ scope }: { scope: string }) {
  return (
    <span className="text-[11px] rounded-md px-2 py-1" style={{ background: 'var(--surface-container)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>
      {scope}
    </span>
  );
}

export default function McpAccessPage() {
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

  const selectedClientOption = clientById(selectedClient);
  const selectedScopes = useMemo(() => {
    if (accessPreset === 'read') return READ_SCOPES;
    if (accessPreset === 'work') return ALL_SCOPES;
    return customScopes;
  }, [accessPreset, customScopes]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/api/mcp-access/tokens');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      setTokens(body.tokens ?? []);
      setEndpoint(body.mcp_endpoint_url ?? '');
      const [readinessRes, grantsRes, historyRes] = await Promise.all([
        api.get('/api/oauth/readiness'),
        api.get('/api/oauth/grants'),
        api.get('/api/mcp-access/history'),
      ]);
      if (readinessRes.ok) setRemote(await readinessRes.json());
      if (grantsRes.ok) {
        const grantsBody = await grantsRes.json();
        setGrants(grantsBody.grants ?? []);
      }
      if (historyRes.ok) {
        const historyBody = await historyRes.json();
        setHistory({
          revoked_tokens: historyBody.revoked_tokens ?? [],
          revoked_grants: historyBody.revoked_grants ?? [],
        });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function chooseClient(id: ClientId) {
    const client = clientById(id);
    setSelectedClient(id);
    setAccessPreset(client.defaultPreset);
    setTokenName(client.tokenName);
    setNewToken(null);
    if (client.defaultPreset === 'custom') setCustomScopes(READ_SCOPES);
  }

  function toggleCustomScope(scope: string) {
    setCustomScopes((current) => (
      current.includes(scope)
        ? current.filter((item) => item !== scope)
        : [...current, scope]
    ));
  }

  async function copy(label: string, value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  }

  async function createToken() {
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
      setEndpoint(body.mcp_endpoint_url ?? endpoint);
      await load();
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
    } catch (err) {
      setError((err as Error).message);
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
    } catch (err) {
      setError((err as Error).message);
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
        title: 'Claude Code MCP JSON',
        detail: 'Use this with Claude Code config or add-json. Do not paste bearer tokens into a Claude chat.',
        value: JSON.stringify({
          mcpServers: {
            deft: {
              type: 'http',
              url: endpointForConfig,
              headers: { Authorization: `Bearer ${tokenForConfig}` },
            },
          },
        }, null, 2),
      };
    }
    return {
      title: 'Raw endpoint and bearer header',
      detail: 'Use this when your client asks for the MCP URL and authorization header separately.',
      value: [
        `MCP URL: ${endpointForConfig}`,
        `Authorization: Bearer ${tokenForConfig}`,
      ].join('\n'),
    };
  }, [endpointForConfig, selectedClient, tokenForConfig]);

  const tokenSetupClient = selectedClientOption.setupKind === 'token' || selectedClientOption.setupKind === 'advanced';
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
        'Click Connect in Claude. Deft will handle OAuth and scope approval.',
        'Enable the connector for the chat where Claude should use Deft tools.',
      ]
    : [
        'Open the AI app settings area for custom or remote MCP connectors.',
        'Add the Connector URL below, then follow the app\'s OAuth sign-in flow.',
        'Use the metadata links only if the app asks for discovery or OAuth details.',
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
      value: remote?.mcp_endpoint_url ?? 'Loading connector URL...',
      copyValue: remote?.mcp_endpoint_url,
      help: 'Paste this into Claude\'s required URL field.',
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

  return (
    <div className="flex h-full min-w-0 flex-col overflow-x-hidden overflow-y-auto">
      <PageHeader
        title="Connections"
        description="Connect Codex, Claude, ChatGPT, or any MCP client to your Deft workspace."
        secondary={
          <TabStrip>
            <Link href="/settings/mcp-access" className="px-3 py-2 text-[13px] font-medium" style={{ color: 'var(--accent)', borderBottom: '2px solid var(--accent)' }}>
              My AI Apps
            </Link>
            <Link href="/settings/agent-employees" className="px-3 py-2 text-[13px] font-medium" style={{ color: 'var(--text-tertiary)', borderBottom: '2px solid transparent' }}>
              Agent Employees
            </Link>
          </TabStrip>
        }
        compact
      />

      <div className="mx-auto w-full min-w-0 max-w-5xl space-y-4 px-4 pb-8 md:px-6">
        {error && (
          <div className="rounded-lg px-3 py-2 text-[13px]" style={{ color: 'var(--danger)', border: '1px solid var(--danger)', background: 'color-mix(in srgb, var(--danger) 8%, transparent)' }}>
            {error}
          </div>
        )}
        {copied && (
          <div className="rounded-lg px-3 py-2 text-[13px] flex items-center gap-2" style={{ color: 'var(--accent)', background: 'var(--surface-container-low)' }}>
            <Check size={14} /> Copied {copied}
          </div>
        )}

        {!loading && (tokens.length > 0 || grants.length > 0) && (
          <section className="flex min-w-0 items-center justify-between gap-3 rounded-lg p-3 sm:p-4" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                <Check size={14} style={{ color: 'var(--status-green, #10b981)' }} />
                {tokens.length + grants.length} active connection{tokens.length + grants.length === 1 ? '' : 's'}
              </div>
              <p className="mt-1 hidden truncate text-[11px] sm:block" style={{ color: 'var(--text-secondary)' }}>Review last use, scopes, or revoke access below.</p>
            </div>
            <a href="#active-connections" className="deft-pill shrink-0" style={{ color: 'var(--accent)', border: '1px solid var(--border-default)' }}>Manage</a>
          </section>
        )}

        <section className="min-w-0 overflow-hidden rounded-lg" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
          <div className="flex flex-col gap-4 p-4 md:p-5" style={{ borderBottom: '1px solid var(--border-default)' }}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md" style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}>
                  <Sparkles size={16} />
                </div>
                <div>
                  <h2 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>Connect an AI app</h2>
                  <p className="mt-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>Choose an app. Deft will only show the setup it needs.</p>
                </div>
              </div>
              <Link href="/settings/agent-employees" className="inline-flex items-center gap-1.5 self-start text-[12px] font-medium" style={{ color: 'var(--accent)' }}>
                Need a shared agent employee? <ChevronRight size={13} />
              </Link>
            </div>

            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
              {CLIENT_OPTIONS.filter((client) => client.id !== 'agent-employee').map((client) => {
                const active = client.id === selectedClient;
                return (
                  <button
                    key={client.id}
                    type="button"
                    onClick={() => chooseClient(client.id)}
                    className="deft-pill shrink-0 gap-2 transition-colors"
                    style={{
                      background: active ? 'var(--accent)' : 'var(--surface-container)',
                      border: active ? '1px solid var(--accent)' : '1px solid var(--border-default)',
                      color: active ? 'white' : 'var(--text-secondary)',
                    }}
                    aria-pressed={active}
                  >
                    {clientIcon(client.id)}
                    {client.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="p-4 md:p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md" style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}>
                  {clientIcon(selectedClient)}
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>{selectedClientOption.name}</h3>
                    <span className="rounded-full px-2 py-0.5 text-[10px]" style={{ background: 'var(--surface-container)', color: 'var(--text-tertiary)', border: '1px solid var(--border-default)' }}>{selectedClientOption.fit}</span>
                  </div>
                  <p className="mt-1 max-w-2xl text-[12px]" style={{ color: 'var(--text-secondary)' }}>{selectedClientOption.detail}</p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                <span className="flex h-5 w-5 items-center justify-center rounded-full text-white" style={{ background: 'var(--accent)' }}><Check size={11} /></span>
                App
                <span className="mx-1 h-px w-5" style={{ background: 'var(--border-default)' }} />
                <span className="flex h-5 w-5 items-center justify-center rounded-full" style={{ border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}>2</span>
                {tokenSetupClient ? 'Access' : 'Setup'}
                <span className="mx-1 h-px w-5" style={{ background: 'var(--border-default)' }} />
                <span className="flex h-5 w-5 items-center justify-center rounded-full" style={{ border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}>3</span>
                Connect
              </div>
            </div>

            {tokenSetupClient && (
              <div className="mt-5 grid min-w-0 gap-6 lg:grid-cols-[minmax(0,.85fr)_minmax(0,1.15fr)]">
                <div className="min-w-0 lg:pr-6" style={{ borderColor: 'var(--border-default)' }}>
                  <div className="flex items-center gap-2">
                    <ShieldCheck size={14} style={{ color: 'var(--accent)' }} />
                    <h4 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>2. Choose access</h4>
                  </div>
                  <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>This connection acts as you and can only reach work you can access.</p>
                  <div className="mt-3 divide-y" style={{ borderColor: 'var(--border-default)' }}>
                    {PRESETS.map((preset) => {
                      const active = preset.id === accessPreset;
                      return (
                        <button key={preset.id} type="button" onClick={() => setAccessPreset(preset.id)} className="flex w-full items-start gap-3 py-3 text-left">
                          <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full" style={{ border: active ? '4px solid var(--accent)' : '1px solid var(--border-strong, var(--border-default))' }} />
                          <span>
                            <span className="block text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{preset.title}</span>
                            <span className="mt-0.5 block text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{preset.detail}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {accessPreset === 'custom' ? (
                    <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                      {ALL_SCOPES.map((scope) => (
                        <label key={scope} className="flex items-start gap-2 rounded-md p-2.5 text-[11px]" style={{ background: 'var(--surface-container)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>
                          <input type="checkbox" checked={customScopes.includes(scope)} onChange={() => toggleCustomScope(scope)} className="mt-0.5" />
                          <span><span className="font-medium" style={{ color: 'var(--text-primary)' }}>{scope}</span><span> - {SCOPE_LABELS[scope]}</span></span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <button type="button" onClick={() => setAccessPreset('custom')} className="mt-3 text-[11px] font-medium" style={{ color: 'var(--accent)' }}>
                      Review individual scopes
                    </button>
                  )}
                </div>

                <div className="min-w-0 border-t pt-5 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0" style={{ borderColor: 'var(--border-default)' }}>
                  <div className="flex items-center gap-2">
                    <KeyRound size={14} style={{ color: 'var(--accent)' }} />
                    <h4 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>3. Create connection</h4>
                  </div>
                  <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>Create one token for this app. The config appears after the token is generated.</p>
                  <label className="mt-4 block">
                    <span className="mb-1.5 block text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>Connection name</span>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <input value={tokenName} onChange={(event) => setTokenName(event.target.value)} className="h-10 min-w-0 flex-1 rounded-md px-3 text-[13px] outline-none" style={{ background: 'var(--surface-container)', color: 'var(--text-primary)', border: '1px solid var(--border-default)' }} />
                      <button type="button" disabled={busy || selectedScopes.length === 0} onClick={createToken} className="inline-flex h-10 items-center justify-center gap-2 rounded-full px-4 text-[13px] font-medium text-white disabled:opacity-50" style={{ background: 'var(--accent)' }}>
                        {busy ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
                        {newToken ? 'Create another' : 'Generate token'}
                      </button>
                    </div>
                  </label>

                  {newToken ? (
                    <div className="mt-4 space-y-3">
                      <div className="rounded-md p-3" style={{ background: 'color-mix(in srgb, var(--accent) 8%, var(--surface-container))', border: '1px solid var(--accent)' }}>
                        <div className="flex items-center justify-between gap-3">
                          <div><div className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>Token ready</div><p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>Copy it now. Deft will not show it again.</p></div>
                          <button type="button" onClick={() => copy('token', newToken)} className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-medium" style={{ background: 'var(--accent)', color: 'white' }}><Copy size={12} /> Copy token</button>
                        </div>
                        <pre className="mt-3 max-w-full overflow-x-auto rounded-md p-3 text-[11px]" style={{ background: 'var(--surface-container)', color: 'var(--text-primary)' }}>{newToken}</pre>
                      </div>
                      <div className="rounded-md p-3" style={{ background: 'var(--surface-container)', border: '1px solid var(--border-default)' }}>
                        <div className="flex items-start justify-between gap-3">
                          <div><div className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>{selectedSnippet.title}</div><p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>{selectedSnippet.detail}</p></div>
                          <button type="button" onClick={() => copy(selectedSnippet.title.toLowerCase(), selectedSnippet.value)} className="shrink-0 rounded-md p-1.5" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }} aria-label={`Copy ${selectedSnippet.title}`}><Copy size={13} /></button>
                        </div>
                        <pre className="mt-3 max-h-56 max-w-full overflow-x-auto rounded-md p-3 text-[11px]" style={{ background: 'var(--surface-container-high, var(--surface-container-low))', color: 'var(--text-primary)' }}>{selectedSnippet.value}</pre>
                      </div>
                      <div className="flex items-start justify-between gap-3 rounded-md px-3 py-2.5" style={{ background: 'var(--surface-container)' }}>
                        <div className="min-w-0"><div className="text-[11px] font-medium" style={{ color: 'var(--text-primary)' }}>Test the connection</div><p className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--text-secondary)' }}>{TEST_PROMPTS[0]}</p></div>
                        <button type="button" onClick={() => copy('test prompt', TEST_PROMPTS[0])} className="shrink-0 rounded-md p-1.5" style={{ color: 'var(--text-secondary)' }} aria-label="Copy test prompt"><Copy size={13} /></button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-4 flex items-start gap-3 rounded-md px-3 py-3" style={{ background: 'var(--surface-container)' }}>
                      <ShieldCheck size={15} className="mt-0.5 shrink-0" style={{ color: 'var(--text-tertiary)' }} />
                      <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>Your token and ready-to-copy {selectedClientOption.name} config will appear here. Every use is recorded in connection activity below.</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {selectedClientOption.setupKind === 'oauth' && (
              <div className="mt-5 border-t pt-5" style={{ borderColor: 'var(--border-default)' }}>
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-md flex items-center justify-center shrink-0" style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}>
                    <Globe2 size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h2 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                          {isClaudeConnector ? 'Claude connector setup' : 'Remote connector setup'}
                        </h2>
                        <p className="text-[12px] mt-1" style={{ color: 'var(--text-secondary)' }}>
                          {isClaudeConnector
                            ? 'Claude connectors are added from Claude settings at the account level. The URL/token cannot be pasted into an active chat and expected to work.'
                            : 'Use this path only when the hosted AI app asks for a remote MCP connector or OAuth metadata. For Codex and Claude Code, token setup is more direct.'}
                        </p>
                      </div>
                      <span className="text-[11px] rounded-md px-2 py-1 shrink-0" style={{ background: remote?.https_ready ? 'var(--accent-muted)' : 'var(--surface-container)', color: remote?.https_ready ? 'var(--accent)' : 'var(--text-tertiary)', border: '1px solid var(--border-default)' }}>
                        {remote?.https_ready ? 'HTTPS ready' : 'Needs public HTTPS'}
                      </span>
                    </div>
                    <div className="mt-4 rounded-md p-3" style={{ background: 'color-mix(in srgb, var(--accent) 7%, var(--surface-container))', border: '1px solid var(--border-default)' }}>
                      <div className="flex items-start gap-2">
                        <ShieldCheck size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--accent)' }} />
                        <div>
                          <div className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                            {isClaudeConnector ? 'Use Claude settings, not chat' : 'Use the app connector settings'}
                          </div>
                          <ol className="mt-2 space-y-1.5 text-[11px] leading-relaxed list-decimal pl-4" style={{ color: 'var(--text-secondary)' }}>
                            {remoteSteps.map((step) => <li key={step}>{step}</li>)}
                          </ol>
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 rounded-md p-3 text-[11px] leading-relaxed" style={{ background: 'var(--surface-container)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>
                      <strong style={{ color: 'var(--text-primary)' }}>Security note:</strong> never paste a live bearer token into Claude, ChatGPT, or any AI chat. If you already did, revoke that personal token below and generate a fresh one. Remote Claude connectors should authenticate through Deft OAuth.
                    </div>
                    {isClaudeConnector && (
                      <div className="mt-4 rounded-md p-3" style={{ background: 'var(--surface-container)', border: '1px solid var(--border-default)' }}>
                        <div className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>Fill Claude's four fields like this</div>
                        <div className="mt-3 grid gap-2">
                          {claudeConnectorFields.map((field) => (
                            <div key={field.label} className="rounded-md p-3" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>{field.label}</div>
                                  <div className="mt-1 text-[12px] font-medium break-all" style={{ color: field.value === 'Leave blank' ? 'var(--text-tertiary)' : 'var(--text-primary)' }}>{field.value}</div>
                                </div>
                                {field.copyValue && (
                                  <button type="button" onClick={() => copy(field.label.toLowerCase(), field.copyValue ?? '')} className="p-1.5 rounded-md shrink-0" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }} aria-label={`Copy ${field.label}`}>
                                    <Copy size={13} />
                                  </button>
                                )}
                              </div>
                              <p className="text-[11px] mt-1.5 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{field.help}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {!isClaudeConnector && (
                      <div className="grid md:grid-cols-2 gap-3 mt-4">
                        {remoteRows.slice(0, 3).map(([label, value]) => (
                          <div key={label} className="rounded-md p-3 min-w-0" style={{ background: 'var(--surface-container)', border: '1px solid var(--border-default)' }}>
                            <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>{label}</div>
                            <div className="mt-1 flex items-center gap-2 min-w-0">
                              <code className="text-[11px] truncate flex-1" style={{ color: 'var(--text-primary)' }}>{value ?? 'Not loaded'}</code>
                              {value && (
                                <button type="button" onClick={() => copy(label.toLowerCase(), value)} className="p-1 rounded-md" style={{ color: 'var(--text-secondary)' }} aria-label={`Copy ${label}`}>
                                  <Copy size={13} />
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <button type="button" onClick={() => setAdvancedOpen(true)} className="mt-3 inline-flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--accent)' }}>
                      <Settings2 size={13} /> Show all OAuth endpoints
                    </button>
                  </div>
                </div>
              </div>
            )}

            {selectedClientOption.setupKind === 'agent' && (
              <div className="mt-5 border-t pt-5" style={{ borderColor: 'var(--border-default)' }}>
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-md flex items-center justify-center shrink-0" style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}>
                    <Bot size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h2 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>Use Agent Employees for shared workers</h2>
                    <p className="text-[12px] mt-1" style={{ color: 'var(--text-secondary)' }}>
                      Personal AI app connections act as you. If Hermes, OpenClaw, Codex, or another runtime should be available to the whole company as an employee, onboard it as an Agent Employee instead.
                    </p>
                    <Link href="/settings/agent-employees" className="mt-4 inline-flex items-center gap-2 rounded-md px-3 py-2 text-[13px] font-medium text-white" style={{ background: 'var(--accent)' }}>
                      Open Agent Employees
                    </Link>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        <section id="active-connections" className="min-w-0 scroll-mt-4 rounded-lg p-4" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
          <div className="flex items-center gap-2 mb-3">
            <Activity size={15} style={{ color: 'var(--accent)' }} />
            <h2 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>Manage active connections</h2>
          </div>
          {loading ? (
            <div className="py-6 flex items-center justify-center"><Loader2 size={18} className="animate-spin" /></div>
          ) : (
            <div className="grid lg:grid-cols-2 gap-3">
              <div className="rounded-md p-3" style={{ background: 'var(--surface-container)', border: '1px solid var(--border-default)' }}>
                <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>Personal tokens</div>
                {tokens.length === 0 ? (
                  <p className="text-[12px] mt-2" style={{ color: 'var(--text-secondary)' }}>No personal MCP tokens yet.</p>
                ) : (
                  <div className="space-y-2 mt-3">
                    {tokens.map((token) => (
                      <div key={token.id} className="rounded-md p-3" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{token.name}</div>
                            <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                              {token.token_prefix}... / last used {formatDate(token.last_used_at)}
                            </div>
                          </div>
                          <button type="button" disabled={busy} onClick={() => revoke(token.id)} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] disabled:opacity-50 shrink-0" style={{ color: 'var(--danger)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)' }} aria-label={`Revoke ${token.name}`}>
                            <Trash2 size={13} /> Revoke
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-1 mt-2">
                          {isStale(token.last_used_at) && (
                            <span className="text-[10px] rounded px-1.5 py-0.5" style={{ color: 'var(--warning, #f59e0b)', border: '1px solid color-mix(in srgb, var(--warning, #f59e0b) 45%, transparent)' }}>
                              {token.last_used_at ? 'stale' : 'unused'}
                            </span>
                          )}
                          {token.scopes.map((scope) => (
                            <span key={scope} className="text-[10px] rounded px-1.5 py-0.5" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>{scope}</span>
                          ))}
                        </div>
                        <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border-default)' }}>
                          <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>Recent token activity</div>
                          <RecentActionList actions={token.recent_actions} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-md p-3" style={{ background: 'var(--surface-container)', border: '1px solid var(--border-default)' }}>
                <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>OAuth app grants</div>
                {grants.length === 0 ? (
                  <p className="text-[12px] mt-2" style={{ color: 'var(--text-secondary)' }}>No ChatGPT or Claude-style OAuth connections yet.</p>
                ) : (
                  <div className="space-y-2 mt-3">
                    {grants.map((grant) => (
                      <div key={grant.id} className="rounded-md p-3" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{grant.app_name}</div>
                            <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                              {grant.connector_profile} / last used {formatDate(grant.last_used_at)}
                            </div>
                          </div>
                          <button type="button" disabled={busy} onClick={() => revokeGrant(grant.id)} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] disabled:opacity-50 shrink-0" style={{ color: 'var(--danger)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)' }} aria-label={`Revoke ${grant.app_name}`}>
                            <Trash2 size={13} /> Revoke
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-1 mt-2">
                          {isStale(grant.last_used_at) && (
                            <span className="text-[10px] rounded px-1.5 py-0.5" style={{ color: 'var(--warning, #f59e0b)', border: '1px solid color-mix(in srgb, var(--warning, #f59e0b) 45%, transparent)' }}>
                              {grant.last_used_at ? 'stale' : 'unused'}
                            </span>
                          )}
                          {grant.scopes.map((scope) => (
                            <span key={scope} className="text-[10px] rounded px-1.5 py-0.5" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>{scope}</span>
                          ))}
                        </div>
                        <RecentActionList actions={grant.recent_actions} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="rounded-lg p-4" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
          <button
            type="button"
            onClick={() => setAdvancedOpen((value) => !value)}
            className="w-full flex items-center justify-between gap-3 text-left"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-md flex items-center justify-center shrink-0" style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}>
                <Settings2 size={16} />
              </div>
              <div className="min-w-0">
                <h2 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>Advanced MCP and OAuth details</h2>
                <p className="text-[12px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                  Raw endpoint, bearer header shape, and remote connector metadata for custom clients.
                </p>
              </div>
            </div>
            {advancedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>

          {advancedOpen && (
            <div className="grid md:grid-cols-2 gap-3 mt-4">
              {remoteRows.map(([label, value]) => (
                <div key={label} className="rounded-md p-3 min-w-0" style={{ background: 'var(--surface-container)', border: '1px solid var(--border-default)' }}>
                  <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>{label}</div>
                  <div className="mt-1 flex items-center gap-2 min-w-0">
                    <code className="text-[11px] truncate flex-1" style={{ color: 'var(--text-primary)' }}>{value ?? 'Not loaded'}</code>
                    {value && (
                      <button type="button" onClick={() => copy(label.toLowerCase(), value)} className="p-1 rounded-md" style={{ color: 'var(--text-secondary)' }} aria-label={`Copy ${label}`}>
                        <Copy size={13} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
              <div className="rounded-md p-3 min-w-0 md:col-span-2" style={{ background: 'var(--surface-container)', border: '1px solid var(--border-default)' }}>
                <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>Supported remote scopes</div>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {(remote?.scopes ?? ALL_SCOPES).map((scope) => <ScopePill key={scope} scope={scope} />)}
                </div>
              </div>
            </div>
          )}
        </section>

        <section className="rounded-lg p-4" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
          <button
            type="button"
            onClick={() => setHistoryOpen((value) => !value)}
            className="w-full flex items-center justify-between gap-3 text-left"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-md flex items-center justify-center shrink-0" style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}>
                <History size={16} />
              </div>
              <div className="min-w-0">
                <h2 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>Connection history</h2>
                <p className="text-[12px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                  Revoked personal tokens and AI app grants, with their last recorded actions.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[11px] rounded-md px-2 py-1" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>
                {historyCount} archived
              </span>
              {historyOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </div>
          </button>

          {historyOpen && (
            <div className="mt-4 space-y-4">
              {!history || historyCount === 0 ? (
                <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>No revoked connections yet.</p>
              ) : (
                <>
                  {history.revoked_tokens.length > 0 && (
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] mb-2" style={{ color: 'var(--text-tertiary)' }}>
                        Personal tokens
                      </div>
                      <div className="space-y-2">
                        {history.revoked_tokens.map((token) => (
                          <div key={token.id} className="rounded-md p-3" style={{ background: 'var(--surface-container)', border: '1px solid var(--border-default)' }}>
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{token.name}</div>
                                <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                                  {token.token_prefix}... / revoked {formatDate(token.revoked_at)} / last used {formatDate(token.last_used_at)}
                                </div>
                              </div>
                              <span className="text-[10px] rounded px-1.5 py-0.5" style={{ color: 'var(--danger)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)' }}>
                                revoked
                              </span>
                            </div>
                            <div className="flex flex-wrap gap-1 mt-2">
                              {token.scopes.map((scope) => (
                                <span key={scope} className="text-[10px] rounded px-1.5 py-0.5" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>{scope}</span>
                              ))}
                            </div>
                            <RecentActionList actions={token.recent_actions} />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {history.revoked_grants.length > 0 && (
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] mb-2" style={{ color: 'var(--text-tertiary)' }}>
                        AI app connections
                      </div>
                      <div className="space-y-2">
                        {history.revoked_grants.map((grant) => (
                          <div key={grant.id} className="rounded-md p-3" style={{ background: 'var(--surface-container)', border: '1px solid var(--border-default)' }}>
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{grant.app_name}</div>
                                <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                                  {grant.connector_profile} / revoked {formatDate(grant.revoked_at)} / last used {formatDate(grant.last_used_at)}
                                </div>
                              </div>
                              <span className="text-[10px] rounded px-1.5 py-0.5" style={{ color: 'var(--danger)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)' }}>
                                revoked
                              </span>
                            </div>
                            <div className="flex flex-wrap gap-1 mt-2">
                              {grant.scopes.map((scope) => (
                                <span key={scope} className="text-[10px] rounded px-1.5 py-0.5" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>{scope}</span>
                              ))}
                            </div>
                            <RecentActionList actions={grant.recent_actions} />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
