'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Activity, Bot, Check, ChevronDown, ChevronRight, Copy, FileText, Globe2, History, KeyRound, Loader2, Plug, Terminal, Trash2 } from 'lucide-react';
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
const WRITE_SCOPES = ['write:tasks', 'write:messages', 'write:wiki'];

const SCOPE_LABELS: Record<string, string> = {
  'read:workspace': 'Workspace map, teammates, projects, and activity context',
  'read:wiki': 'Company, channel, and personal memory packets',
  'read:tasks': 'Task lists, task detail, comments, and progress',
  'read:messages': 'Visible spaces, threads, and chat search',
  'read:calendar': 'Native and ICS calendar context',
  'write:tasks': 'Create, update, transition, and comment on tasks',
  'write:messages': 'Post messages into spaces you belong to',
  'write:wiki': 'Save or update wiki knowledge as you',
};

const CLIENT_CARDS = [
  {
    name: 'Codex / Claude Code',
    fit: 'Works now',
    detail: 'Use the streamable HTTP endpoint with a bearer token. Best for task and workspace workflows.',
  },
  {
    name: 'Claude Desktop',
    fit: 'Works with HTTP MCP config',
    detail: 'Add Deft as an HTTP MCP server and paste the bearer header from a personal token.',
  },
  {
    name: 'ChatGPT / Claude web',
    fit: 'Use OAuth connector path',
    detail: 'Use the public OAuth metadata below when the client expects a remote connector flow.',
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
    if (toolName === 'message_post') return 'Posted message';
    if (toolName === 'memory_write') return 'Saved memory';
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
  if (toolName === 'message_post' && result) {
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
  if (toolName === 'message_post' && typeof result.id === 'string' && typeof result.space_id === 'string') {
    return `/chat?space=${encodeURIComponent(result.space_id)}&message=${encodeURIComponent(result.id)}`;
  }
  return null;
}

function isStale(value: string | null | undefined) {
  if (!value) return true;
  return Date.now() - new Date(value).getTime() > 1000 * 60 * 60 * 24 * 14;
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

export default function McpAccessPage() {
  const [tokens, setTokens] = useState<McpToken[]>([]);
  const [remote, setRemote] = useState<RemoteReadiness | null>(null);
  const [grants, setGrants] = useState<OAuthGrant[]>([]);
  const [history, setHistory] = useState<McpAccessHistory | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tokenName, setTokenName] = useState('Personal AI client');
  const [writeEnabled, setWriteEnabled] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedScopes = useMemo(
    () => writeEnabled ? [...READ_SCOPES, ...WRITE_SCOPES] : READ_SCOPES,
    [writeEnabled],
  );

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
        name: tokenName.trim() || 'Personal AI client',
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
  const configSnippets = useMemo(() => [
    {
      id: 'codex',
      title: 'Codex config',
      detail: 'Paste into Codex MCP server config when using streamable HTTP with a personal bearer token.',
      value: [
        '[mcp_servers.deft]',
        `url = "${endpointForConfig}"`,
        `http_headers = { Authorization = "Bearer ${tokenForConfig}" }`,
      ].join('\n'),
    },
    {
      id: 'claude-desktop',
      title: 'Claude Desktop / Claude Code JSON',
      detail: 'Paste into a client that accepts mcpServers JSON with HTTP headers.',
      value: JSON.stringify({
        mcpServers: {
          deft: {
            type: 'http',
            url: endpointForConfig,
            headers: { Authorization: `Bearer ${tokenForConfig}` },
          },
        },
      }, null, 2),
    },
    {
      id: 'raw',
      title: 'Raw endpoint and header',
      detail: 'Use this when a client asks for the MCP URL and bearer header separately.',
      value: [
        `MCP URL: ${endpointForConfig}`,
        `Authorization: Bearer ${tokenForConfig}`,
      ].join('\n'),
    },
  ], [endpointForConfig, tokenForConfig]);
  const historyCount = (history?.revoked_tokens.length ?? 0) + (history?.revoked_grants.length ?? 0);

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <PageHeader
        title="MCP Access"
        description="Connect personal AI clients and agent employees to Deft's workspace tools."
        secondary={
          <TabStrip>
            <Link href="/settings/mcp-access" className="px-3 py-2 text-[13px] font-medium" style={{ color: 'var(--accent)', borderBottom: '2px solid var(--accent)' }}>
              My AI Clients
            </Link>
            <Link href="/settings/agent-employees" className="px-3 py-2 text-[13px] font-medium" style={{ color: 'var(--text-tertiary)', borderBottom: '2px solid transparent' }}>
              Agent Employees
            </Link>
          </TabStrip>
        }
        compact
      />

      <div className="max-w-4xl w-full mx-auto px-4 md:px-6 pb-8 space-y-4">
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

        <section className="rounded-lg p-4" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-md flex items-center justify-center shrink-0" style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}>
              <Bot size={16} />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>Connect an AI app to Deft</h2>
              <p className="text-[12px] mt-1" style={{ color: 'var(--text-secondary)' }}>
                Deft exposes your workspace as MCP tools. A connected app can read the same work record you use in Deft,
                then write back tasks, messages, or wiki updates only inside the scopes you grant.
              </p>
              <div className="grid md:grid-cols-3 gap-3 mt-4">
                {CLIENT_CARDS.map((card) => (
                  <div key={card.name} className="rounded-md p-3" style={{ background: 'var(--surface-container)', border: '1px solid var(--border-default)' }}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{card.name}</div>
                      <span className="text-[10px] rounded px-1.5 py-0.5 shrink-0" style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)' }}>{card.fit}</span>
                    </div>
                    <p className="text-[11px] mt-2 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{card.detail}</p>
                  </div>
                ))}
              </div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] mt-4" style={{ color: 'var(--text-tertiary)' }}>
                Context packets available to clients
              </div>
              <div className="grid md:grid-cols-3 gap-3 mt-3">
                {CONTEXT_PACKET_CARDS.map((card) => (
                  <div key={card.title} className="rounded-md p-3" style={{ background: 'var(--surface-container)', border: '1px solid var(--border-default)' }}>
                    <div className="flex items-center gap-2 text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                      <FileText size={13} /> {card.title}
                    </div>
                    <p className="text-[11px] mt-1 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{card.detail}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-lg p-4" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-md flex items-center justify-center" style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}>
              <KeyRound size={16} />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>Create a personal MCP token</h2>
              <p className="text-[12px] mt-1" style={{ color: 'var(--text-secondary)' }}>
                Personal tokens act as you. Reads follow your workspace access; writes create tasks, messages, and wiki pages under your user.
              </p>
              <div className="grid md:grid-cols-[1fr_auto] gap-3 mt-4">
                <input
                  value={tokenName}
                  onChange={(e) => setTokenName(e.target.value)}
                  className="h-10 rounded-md px-3 text-[13px] outline-none"
                  style={{ background: 'var(--surface-container)', color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
                />
                <label className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  <input type="checkbox" checked={writeEnabled} onChange={(e) => setWriteEnabled(e.target.checked)} />
                  Allow writes
                </label>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-3">
                {selectedScopes.map((scope) => (
                  <span key={scope} className="text-[11px] rounded-md px-2 py-1" style={{ background: 'var(--surface-container)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>
                    {scope}
                  </span>
                ))}
              </div>
              <div className="grid md:grid-cols-2 gap-2 mt-3">
                {selectedScopes.map((scope) => (
                  <div key={`${scope}-detail`} className="text-[11px] rounded-md px-2.5 py-2" style={{ background: 'var(--surface-container)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{scope}</span>
                    <span> - {SCOPE_LABELS[scope] ?? 'Scoped MCP permission'}</span>
                  </div>
                ))}
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={createToken}
                className="mt-4 inline-flex items-center gap-2 rounded-md px-3 py-2 text-[13px] font-medium text-white disabled:opacity-50"
                style={{ background: 'var(--accent)' }}
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
                Generate token
              </button>
            </div>
          </div>
        </section>

        {newToken && (
          <section className="rounded-lg p-4" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--accent)' }}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>New token</h2>
                <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>Copy it now. Deft will not show it again.</p>
              </div>
              <button type="button" onClick={() => copy('token', newToken)} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px]" style={{ border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}>
                <Copy size={13} /> Copy
              </button>
            </div>
            <pre className="mt-3 overflow-x-auto rounded-md p-3 text-[11px]" style={{ background: 'var(--surface-container)', color: 'var(--text-primary)' }}>{newToken}</pre>
          </section>
        )}

        <section className="rounded-lg p-4" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-md flex items-center justify-center shrink-0" style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}>
              <Terminal size={16} />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>One-click client config</h2>
              <p className="text-[12px] mt-1" style={{ color: 'var(--text-secondary)' }}>
                Generate a token above, then copy the snippet that matches your AI client. Each config points at Deft's streamable HTTP MCP endpoint.
              </p>
              <div className="grid md:grid-cols-3 gap-3 mt-4">
                {configSnippets.map((snippet) => (
                  <div key={snippet.id} className="rounded-md p-3 min-w-0" style={{ background: 'var(--surface-container)', border: '1px solid var(--border-default)' }}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{snippet.title}</div>
                        <p className="text-[11px] mt-1 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{snippet.detail}</p>
                      </div>
                      <button type="button" onClick={() => copy(snippet.title.toLowerCase(), snippet.value)} className="p-1.5 rounded-md shrink-0" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }} aria-label={`Copy ${snippet.title}`}>
                        <Copy size={13} />
                      </button>
                    </div>
                    <pre className="mt-3 overflow-x-auto rounded-md p-3 text-[11px] max-h-52" style={{ background: 'var(--surface-container-high, var(--surface-container-low))', color: 'var(--text-primary)' }}>{snippet.value}</pre>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-lg p-4" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-md flex items-center justify-center" style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}>
              <Globe2 size={16} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>Connected AI apps</h2>
                  <p className="text-[12px] mt-1" style={{ color: 'var(--text-secondary)' }}>
                    For ChatGPT, Claude web, Codex, and OAuth MCP clients. Connected apps act as you, inside the scopes you approve.
                  </p>
                </div>
                <span className="text-[11px] rounded-md px-2 py-1" style={{ background: remote?.https_ready ? 'var(--accent-muted)' : 'var(--surface-container)', color: remote?.https_ready ? 'var(--accent)' : 'var(--text-tertiary)', border: '1px solid var(--border-default)' }}>
                  {remote?.https_ready ? 'HTTPS ready' : 'Needs public HTTPS'}
                </span>
              </div>

              <div className="grid md:grid-cols-2 gap-3 mt-4">
                {([
                  ['Connector URL', remote?.mcp_endpoint_url],
                  ['Protected resource metadata', remote?.protected_resource_metadata],
                  ['OAuth metadata', remote?.authorization_server_metadata],
                  ['Authorization endpoint', remote?.authorization_endpoint],
                  ['Token endpoint', remote?.token_endpoint],
                  ['Registration endpoint', remote?.registration_endpoint],
                ] as Array<[string, string | undefined]>).map(([label, value]) => (
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

              <div className="flex flex-wrap gap-1.5 mt-3">
                {(remote?.scopes ?? READ_SCOPES).map((scope) => (
                  <span key={scope} className="text-[11px] rounded-md px-2 py-1" style={{ background: 'var(--surface-container)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>
                    {scope}
                  </span>
                ))}
              </div>

              <h3 className="text-[13px] font-semibold mt-5 mb-2" style={{ color: 'var(--text-primary)' }}>App connections</h3>
              {grants.length === 0 ? (
                <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>No ChatGPT or Claude-style OAuth connections yet.</p>
              ) : (
                <div className="space-y-3">
                  {grants.map((grant) => (
                    <div key={grant.id} className="rounded-md p-3" style={{ background: 'var(--surface-container)', border: '1px solid var(--border-default)' }}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{grant.app_name}</div>
                          <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                            {grant.connector_profile} / {grant.client_id}
                          </div>
                          <div className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
                            connected {formatDate(grant.created_at)} / last used {formatDate(grant.last_used_at)}
                          </div>
                        </div>
                        <button type="button" disabled={busy} onClick={() => revokeGrant(grant.id)} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] disabled:opacity-50" style={{ color: 'var(--danger)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)' }} aria-label={`Revoke ${grant.app_name}`}>
                          <Trash2 size={13} /> Revoke
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-1 mt-3">
                        {isStale(grant.last_used_at) && (
                          <span className="text-[10px] rounded px-1.5 py-0.5" style={{ color: 'var(--warning, #f59e0b)', border: '1px solid color-mix(in srgb, var(--warning, #f59e0b) 45%, transparent)' }}>
                            {grant.last_used_at ? 'stale' : 'unused'}
                          </span>
                        )}
                        {grant.scopes.map((scope) => (
                          <span key={scope} className="text-[10px] rounded px-1.5 py-0.5" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>{scope}</span>
                        ))}
                      </div>
                      <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border-default)' }}>
                        <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>Recent actions</div>
                        <RecentActionList actions={grant.recent_actions} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="rounded-lg p-4" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
          <h2 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>Active personal tokens</h2>
          {loading ? (
            <div className="py-6 flex items-center justify-center"><Loader2 size={18} className="animate-spin" /></div>
          ) : tokens.length === 0 ? (
            <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>No personal MCP tokens yet.</p>
          ) : (
            <div className="space-y-2">
              {tokens.map((token) => (
                <div key={token.id} className="flex items-start justify-between gap-3 rounded-md p-3" style={{ background: 'var(--surface-container)', border: '1px solid var(--border-default)' }}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{token.name}</div>
                        <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                          {token.token_prefix}... / created {formatDate(token.created_at)} / last used {formatDate(token.last_used_at)}
                        </div>
                      </div>
                      {isStale(token.last_used_at) && (
                        <span className="text-[10px] rounded px-1.5 py-0.5 shrink-0" style={{ color: 'var(--warning, #f59e0b)', border: '1px solid color-mix(in srgb, var(--warning, #f59e0b) 45%, transparent)' }}>
                          {token.last_used_at ? 'stale' : 'unused'}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {token.scopes.map((scope) => (
                        <span key={scope} className="text-[10px] rounded px-1.5 py-0.5" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>{scope}</span>
                      ))}
                    </div>
                    <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border-default)' }}>
                      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
                        <Activity size={12} /> Recent token activity
                      </div>
                      <RecentActionList actions={token.recent_actions} />
                    </div>
                  </div>
                  <button type="button" disabled={busy} onClick={() => revoke(token.id)} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] disabled:opacity-50 shrink-0" style={{ color: 'var(--danger)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)' }} aria-label={`Revoke ${token.name}`}>
                    <Trash2 size={13} /> Revoke
                  </button>
                </div>
              ))}
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
