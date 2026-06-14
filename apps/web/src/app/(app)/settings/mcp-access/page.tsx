'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Check, Copy, Globe2, KeyRound, Loader2, Plug, Trash2 } from 'lucide-react';
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
};

const READ_SCOPES = ['read:workspace', 'read:wiki', 'read:tasks', 'read:messages', 'read:calendar'];
const WRITE_SCOPES = ['write:tasks', 'write:messages', 'write:wiki'];

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
  profile: string;
};

type OAuthAuditAction = {
  id: string;
  event: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
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

function formatDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : 'never';
}

function actionTitle(action: OAuthAuditAction) {
  const metadata = action.metadata ?? {};
  const toolName = typeof metadata.tool_name === 'string' ? metadata.tool_name : null;
  return toolName ?? action.event.replaceAll('_', ' ');
}

function actionDetail(action: OAuthAuditAction) {
  const metadata = action.metadata ?? {};
  const pieces = [
    typeof metadata.surface === 'string' ? metadata.surface : null,
    typeof metadata.target_id === 'string' ? metadata.target_id : null,
    typeof metadata.success === 'boolean' ? (metadata.success ? 'ok' : 'failed') : null,
  ].filter(Boolean);
  return pieces.length > 0 ? pieces.join(' / ') : 'recorded';
}

function isStale(value: string | null | undefined) {
  if (!value) return true;
  return Date.now() - new Date(value).getTime() > 1000 * 60 * 60 * 24 * 14;
}

export default function McpAccessPage() {
  const [tokens, setTokens] = useState<McpToken[]>([]);
  const [remote, setRemote] = useState<RemoteReadiness | null>(null);
  const [grants, setGrants] = useState<OAuthGrant[]>([]);
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
      const [readinessRes, grantsRes] = await Promise.all([
        api.get('/api/oauth/readiness'),
        api.get('/api/oauth/grants'),
      ]);
      if (readinessRes.ok) setRemote(await readinessRes.json());
      if (grantsRes.ok) {
        const grantsBody = await grantsRes.json();
        setGrants(grantsBody.grants ?? []);
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

  const tokenForConfig = newToken ?? '<paste-token-here>';
  const clientConfig = JSON.stringify({
    mcpServers: {
      deft: {
        url: endpoint || '<deft-api-url>/api/mcp/v1',
        headers: { Authorization: `Bearer ${tokenForConfig}` },
      },
    },
  }, null, 2);

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
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>Client config</h2>
              <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>Use this shape in Claude Desktop, Claude Code, ChatGPT MCP apps, or any streamable HTTP MCP client.</p>
            </div>
            <button type="button" onClick={() => copy('config', clientConfig)} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px]" style={{ border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}>
              <Copy size={13} /> Copy
            </button>
          </div>
          <pre className="mt-3 overflow-x-auto rounded-md p-3 text-[11px]" style={{ background: 'var(--surface-container)', color: 'var(--text-primary)' }}>{clientConfig}</pre>
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
                        {grant.recent_actions?.length ? (
                          <div className="mt-2 space-y-1.5">
                            {grant.recent_actions.slice(0, 5).map((action) => (
                              <div key={action.id} className="grid grid-cols-[1fr_auto] gap-3 text-[11px]">
                                <span className="min-w-0 truncate" style={{ color: 'var(--text-secondary)' }}>
                                  {actionTitle(action)} <span style={{ color: 'var(--text-tertiary)' }}>({actionDetail(action)})</span>
                                </span>
                                <span style={{ color: 'var(--text-tertiary)' }}>{formatDate(action.created_at)}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="mt-2 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>No recent actions recorded.</div>
                        )}
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
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{token.name}</div>
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                      {token.token_prefix}... / created {formatDate(token.created_at)} / last used {formatDate(token.last_used_at)}
                    </div>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {token.scopes.map((scope) => (
                        <span key={scope} className="text-[10px] rounded px-1.5 py-0.5" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>{scope}</span>
                      ))}
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
      </div>
    </div>
  );
}
