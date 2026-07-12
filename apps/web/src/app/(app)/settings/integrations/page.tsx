'use client';

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import Link from 'next/link';
import { Bot, CalendarDays, ChevronDown, ChevronRight, Globe, RefreshCw, Trash2, Zap, Plug, Users } from 'lucide-react';
import McpConnectionForm from '@/components/mcp-connection-form';


type McpTool = {
  name: string;
  description?: string;
};

type McpToolOverride = {
  id: string;
  tool_name: string;
  trust_tier_override: 'auto' | 'quick' | 'full' | null;
  is_disabled: boolean;
};

type McpConnection = {
  id: string;
  name: string;
  transport: 'sse' | 'streamable-http' | 'stdio';
  server_url: string | null;
  stdio_command: string | null;
  stdio_args: string[] | null;
  auth_type: string;
  auth_config_encrypted: Record<string, unknown> | null;
  is_active: boolean;
  last_connected_at: string | null;
  connection_error: string | null;
  tools_cache: McpTool[] | null;
  tools_cached_at: string | null;
  default_trust_tier: 'auto' | 'quick' | 'full';
  enabled_tools: string[] | null;
  created_at: string;
  tool_overrides?: McpToolOverride[];
};


const TRUST_TIER_OPTIONS = [
  { value: 'auto', label: 'Auto-execute' },
  { value: 'quick', label: 'Quick-approve' },
  { value: 'full', label: 'Full-review' },
] as const;

function getStatusInfo(conn: McpConnection): { color: string; label: string } {
  if (conn.connection_error) {
    return { color: '#ef4444', label: 'Error' };
  }
  if (conn.last_connected_at) {
    const ago = Date.now() - new Date(conn.last_connected_at).getTime();
    if (ago < 24 * 60 * 60 * 1000) {
      return { color: '#22c55e', label: 'Connected' };
    }
    return { color: '#6b7280', label: 'Stale' };
  }
  return { color: '#6b7280', label: 'Never connected' };
}

function transportLabel(t: string): string {
  if (t === 'sse') return 'SSE';
  if (t === 'streamable-http') return 'HTTP';
  if (t === 'stdio') return 'Stdio';
  return t;
}

export default function IntegrationsPage() {

  // MCP state
  const [mcpConnections, setMcpConnections] = useState<McpConnection[]>([]);
  const [mcpLoading, setMcpLoading] = useState(true);
  const [showMcpForm, setShowMcpForm] = useState(false);
  const [editingMcp, setEditingMcp] = useState<McpConnection | null>(null);
  const [expandedMcp, setExpandedMcp] = useState<string | null>(null);
  const [mcpPrefill, setMcpPrefill] = useState<{
    name: string;
    transport: 'sse' | 'streamable-http' | 'stdio';
    server_url?: string;
    stdio_command?: string;
    stdio_args?: string[];
    auth_type?: string;
    default_trust_tier?: 'auto' | 'quick' | 'full';
  } | null>(null);
  const [actionLoading, setActionLoading] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    loadMcpConnections();
  }, []);


  const loadMcpConnections = useCallback(async () => {
    try {
      const res = await api.get('/api/mcp-connections');
      if (res.ok) {
        const list: McpConnection[] = await res.json();
        // Load overrides for expanded connection
        setMcpConnections(list);
      }
    } catch { /* ignore */ }
    setMcpLoading(false);
  }, []);

  const loadMcpDetail = async (id: string) => {
    try {
      const res = await api.get(`/api/mcp-connections/${id}`);
      if (res.ok) {
        const detail: McpConnection = await res.json();
        setMcpConnections(prev => prev.map(c => c.id === id ? detail : c));
      }
    } catch { /* ignore */ }
  };

  const handleExpandMcp = (id: string) => {
    if (expandedMcp === id) {
      setExpandedMcp(null);
    } else {
      setExpandedMcp(id);
      loadMcpDetail(id);
    }
  };

  const handleTestMcp = async (id: string) => {
    setActionLoading(prev => ({ ...prev, [id]: 'testing' }));
    try {
      const res = await api.post(`/api/mcp-connections/${id}/test`);
      const data = await res.json();
      if (!data.success) {
        // Error will appear in connection_error on reload
      }
      await loadMcpConnections();
      if (expandedMcp === id) loadMcpDetail(id);
    } catch { /* ignore */ }
    setActionLoading(prev => { const n = { ...prev }; delete n[id]; return n; });
  };

  const handleRefreshTools = async (id: string) => {
    setActionLoading(prev => ({ ...prev, [id]: 'refreshing' }));
    try {
      await api.post(`/api/mcp-connections/${id}/refresh-tools`);
      await loadMcpConnections();
      if (expandedMcp === id) loadMcpDetail(id);
    } catch { /* ignore */ }
    setActionLoading(prev => { const n = { ...prev }; delete n[id]; return n; });
  };

  const handleDeleteMcp = async (id: string) => {
    try {
      await api.delete(`/api/mcp-connections/${id}`);
      setMcpConnections(prev => prev.filter(c => c.id !== id));
      setConfirmDelete(null);
      if (expandedMcp === id) setExpandedMcp(null);
    } catch { /* ignore */ }
  };

  const handleToolOverride = async (connectionId: string, toolName: string, update: { trust_tier_override?: string | null; is_disabled?: boolean }) => {
    try {
      await api.fetch(`/api/mcp-connections/${connectionId}/tools/${encodeURIComponent(toolName)}`, {
        method: 'PUT',
        body: JSON.stringify(update),
      });
      loadMcpDetail(connectionId);
    } catch { /* ignore */ }
  };

  return (
    <div className="h-full overflow-y-auto">
    <div className="p-6 max-w-[640px]">
      <h2 className="text-[1.125rem] font-semibold mb-1" style={{ color: 'var(--on-surface)' }}>
        Integrations
      </h2>
      <p className="text-[0.8125rem] mb-6" style={{ color: 'var(--outline)' }}>
        Connect calendar feeds and MCP-compatible tool servers. Agent employees can bring their own external tools through MCP.
      </p>

      <div className="grid gap-3 md:grid-cols-3 mb-6">
        <IntegrationRoute icon={CalendarDays} title="Calendar feeds" body="Subscribe to ICS calendars and publish your Deft task feed." href="/settings/calendar" />
        <IntegrationRoute icon={Bot} title="Personal AI apps" body="Connect Claude, Codex, and other MCP clients as yourself." href="/settings/mcp-access" />
        <IntegrationRoute icon={Users} title="Shared agents" body="Onboard agent employees for the whole workspace." href="/settings/agent-employees" />
      </div>

      {/* Calendar feeds */}
      <div className="mb-6 p-4 rounded-lg"
        style={{ background: 'var(--surface-container)', border: '1px solid var(--border)' }}>
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface-variant)' }}>
            <CalendarDays size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[0.875rem] font-medium" style={{ color: 'var(--on-surface)' }}>
                Calendar feeds
              </span>
              <span className="text-[0.6875rem] px-1.5 py-0.5 rounded"
                style={{ background: 'rgba(34,197,94,0.12)', color: 'var(--status-green)' }}>
                Recommended
              </span>
            </div>
            <p className="text-[0.75rem] mt-0.5 leading-relaxed" style={{ color: 'var(--outline)' }}>
              Use ICS URLs to read external and shared calendars into Deft without granting provider account access. Deft also gives you a personal feed URL for tasks with due dates.
            </p>
          </div>
          <Link
            href="/settings/calendar"
            className="px-3 py-1.5 text-[0.75rem] font-medium rounded-md flex-shrink-0"
            style={{ background: 'var(--primary-container)', color: '#fff' }}>
            Manage
          </Link>
        </div>
      </div>

      <div className="mt-10">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-[1.125rem] font-semibold" style={{ color: 'var(--on-surface)' }}>
            MCP Connections
          </h2>
          <button
            onClick={() => { setEditingMcp(null); setMcpPrefill(null); setShowMcpForm(true); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium"
            style={{ background: 'var(--accent)', color: 'white', fontFamily: 'var(--font-heading)' }}
          >
            <Plug size={13} />
            Add MCP Server
          </button>
        </div>
        <p className="text-[0.8125rem] mb-4" style={{ color: 'var(--outline)' }}>
          Connect MCP-compatible tool servers (Zapier, n8n, custom) to extend agent capabilities.
        </p>

        {/* Quick-connect buttons */}
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => {
              setEditingMcp(null);
              setMcpPrefill({ name: 'Zapier MCP', server_url: 'https://actions.zapier.com/mcp/sse', transport: 'sse' });
              setShowMcpForm(true);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium"
            style={{ background: 'var(--surface-container)', border: '1px solid var(--border)', color: 'var(--foreground-secondary)' }}
          >
            <Zap size={13} />
            Connect Zapier
          </button>
          <button
            onClick={() => {
              setEditingMcp(null);
              setMcpPrefill({ name: 'n8n MCP', server_url: 'http://localhost:5678/mcp/sse', transport: 'sse' });
              setShowMcpForm(true);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium"
            style={{ background: 'var(--surface-container)', border: '1px solid var(--border)', color: 'var(--foreground-secondary)' }}
          >
            <Plug size={13} />
            Connect n8n
          </button>
          <button
            onClick={() => {
              setEditingMcp(null);
              setMcpPrefill({
                name: 'Playwright Browser',
                transport: 'stdio',
                stdio_command: 'npx',
                stdio_args: ['-y', '@playwright/mcp@latest', '--headless'],
                auth_type: 'none',
                default_trust_tier: 'full',
              });
              setShowMcpForm(true);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium"
            style={{ background: 'var(--surface-container)', border: '1px solid var(--border)', color: 'var(--foreground-secondary)' }}
          >
            <Globe size={13} />
            Connect Playwright
          </button>
        </div>

        {/* MCP Connection List */}
        {mcpLoading ? (
          <p className="text-[13px] py-4" style={{ color: 'var(--muted)' }}>Loading...</p>
        ) : mcpConnections.length === 0 ? (
          <div
            className="rounded-lg p-6 text-center"
            style={{ background: 'var(--surface-container)', border: '1px solid var(--border)' }}
          >
            <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
              No MCP connections yet. Add a server to extend agent tools.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {mcpConnections.map(conn => {
              const status = getStatusInfo(conn);
              const isExpanded = expandedMcp === conn.id;
              const tools = conn.tools_cache || [];
              const loadingAction = actionLoading[conn.id];

              return (
                <div
                  key={conn.id}
                  className="rounded-lg overflow-hidden"
                  style={{ background: 'var(--surface-container)', border: '1px solid var(--border)' }}
                >
                  {/* Card Header */}
                  <div
                    className="flex items-center gap-3 px-4 py-3 cursor-pointer"
                    onClick={() => handleExpandMcp(conn.id)}
                  >
                    {isExpanded ? <ChevronDown size={14} style={{ color: 'var(--muted)' }} /> : <ChevronRight size={14} style={{ color: 'var(--muted)' }} />}

                    {/* Status dot */}
                    <span
                      className="flex-shrink-0 rounded-full"
                      style={{ width: 8, height: 8, background: status.color }}
                    />

                    {/* Name */}
                    <span className="text-[14px] font-medium flex-1 min-w-0 truncate" style={{ color: 'var(--foreground)' }}>
                      {conn.name}
                    </span>

                    {/* Transport badge */}
                    <span
                      className="text-[10px] font-medium px-1.5 py-0.5 rounded"
                      style={{ background: 'var(--surface)', color: 'var(--foreground-secondary)', border: '1px solid var(--border)' }}
                    >
                      {transportLabel(conn.transport)}
                    </span>

                    {/* Tool count */}
                    <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                      {tools.length} tool{tools.length !== 1 ? 's' : ''}
                    </span>

                    {/* Action buttons (stop propagation) */}
                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => handleTestMcp(conn.id)}
                        disabled={!!loadingAction}
                        className="px-2 py-1 text-[11px] font-medium rounded disabled:opacity-50"
                        style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground-secondary)' }}
                        title="Test connection"
                      >
                        {loadingAction === 'testing' ? '...' : 'Test'}
                      </button>
                      <button
                        onClick={() => handleRefreshTools(conn.id)}
                        disabled={!!loadingAction}
                        className="p-1 rounded disabled:opacity-50"
                        style={{ color: 'var(--muted)' }}
                        title="Refresh tools"
                      >
                        <RefreshCw size={13} className={loadingAction === 'refreshing' ? 'animate-spin' : ''} />
                      </button>
                      {confirmDelete === conn.id ? (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleDeleteMcp(conn.id)}
                            className="px-2 py-0.5 text-[11px] rounded"
                            style={{ background: '#ef4444', color: 'white' }}
                          >
                            Confirm
                          </button>
                          <button onClick={() => setConfirmDelete(null)} className="p-0.5">
                            <span className="text-[11px]" style={{ color: 'var(--muted)' }}>Cancel</span>
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmDelete(conn.id)}
                          className="p-1 rounded"
                          style={{ color: 'var(--muted)' }}
                          title="Delete connection"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Connection error */}
                  {conn.connection_error && (
                    <div
                      className="mx-4 mb-2 px-3 py-2 text-[12px] rounded"
                      style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}
                    >
                      {conn.connection_error}
                    </div>
                  )}

                  {/* Expanded: Tool list */}
                  {isExpanded && (
                    <div className="px-4 pb-3 pt-1" style={{ borderTop: '1px solid var(--border)' }}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
                          Tools
                        </span>
                        <button
                          onClick={() => { setEditingMcp(conn); setMcpPrefill(null); setShowMcpForm(true); }}
                          className="text-[11px] font-medium"
                          style={{ color: 'var(--accent)' }}
                        >
                          Edit Connection
                        </button>
                      </div>

                      {tools.length === 0 ? (
                        <p className="text-[12px] py-2" style={{ color: 'var(--muted)' }}>
                          No tools discovered yet. Click &quot;Refresh&quot; to discover tools.
                        </p>
                      ) : (
                        <div className="space-y-1">
                          {tools.map((tool) => {
                            const override = conn.tool_overrides?.find(o => o.tool_name === tool.name);
                            const isDisabled = override?.is_disabled ?? false;
                            const tierOverride = override?.trust_tier_override ?? null;

                            return (
                              <div
                                key={tool.name}
                                className="flex items-center gap-3 px-3 py-2 rounded"
                                style={{ background: 'var(--surface)', opacity: isDisabled ? 0.5 : 1 }}
                              >
                                {/* Enable/disable toggle */}
                                <button
                                  onClick={() => handleToolOverride(conn.id, tool.name, { is_disabled: !isDisabled })}
                                  className="flex-shrink-0 rounded-full relative"
                                  style={{
                                    width: 32,
                                    height: 18,
                                    background: isDisabled ? 'var(--border)' : '#22c55e',
                                    transition: 'background 0.2s',
                                  }}
                                  title={isDisabled ? 'Enable tool' : 'Disable tool'}
                                >
                                  <span
                                    className="absolute rounded-full"
                                    style={{
                                      width: 14,
                                      height: 14,
                                      top: 2,
                                      left: isDisabled ? 2 : 16,
                                      background: 'white',
                                      transition: 'left 0.2s',
                                    }}
                                  />
                                </button>

                                {/* Tool name and description */}
                                <div className="flex-1 min-w-0">
                                  <span className="text-[12px] font-medium block truncate" style={{ color: 'var(--foreground)', fontFamily: 'var(--font-mono)' }}>
                                    {tool.name}
                                  </span>
                                  {tool.description && (
                                    <span className="text-[11px] block truncate" style={{ color: 'var(--muted)' }}>
                                      {tool.description}
                                    </span>
                                  )}
                                </div>

                                {/* Trust tier dropdown */}
                                <select
                                  value={tierOverride || conn.default_trust_tier}
                                  onChange={(e) => {
                                    const val = e.target.value as 'auto' | 'quick' | 'full';
                                    handleToolOverride(conn.id, tool.name, {
                                      trust_tier_override: val === conn.default_trust_tier ? null : val,
                                    });
                                  }}
                                  className="text-[11px] px-1.5 py-0.5 rounded outline-none"
                                  style={{
                                    background: 'var(--surface-container)',
                                    border: '1px solid var(--border)',
                                    color: 'var(--foreground-secondary)',
                                  }}
                                >
                                  {TRUST_TIER_OPTIONS.map(t => (
                                    <option key={t.value} value={t.value}>{t.label}</option>
                                  ))}
                                </select>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* MCP Connection Form Modal */}
      {showMcpForm && (
        <McpConnectionForm
          connection={editingMcp}
          prefill={mcpPrefill}
          onClose={() => { setShowMcpForm(false); setEditingMcp(null); setMcpPrefill(null); }}
          onSaved={() => { setShowMcpForm(false); setEditingMcp(null); setMcpPrefill(null); loadMcpConnections(); }}
        />
      )}
    </div>
    </div>
  );
}

function IntegrationRoute({
  icon: Icon,
  title,
  body,
  href,
}: {
  icon: typeof CalendarDays;
  title: string;
  body: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="rounded-xl p-4"
      style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default, var(--outline-variant))' }}
    >
      <Icon size={16} strokeWidth={1.75} style={{ color: 'var(--accent)' }} />
      <p className="text-[13px] font-semibold mt-3" style={{ color: 'var(--foreground)' }}>{title}</p>
      <p className="text-[12px] leading-relaxed mt-1" style={{ color: 'var(--muted)' }}>{body}</p>
    </Link>
  );
}
