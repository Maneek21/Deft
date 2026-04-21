'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { X } from 'lucide-react';

type McpConnection = {
  id: string;
  name: string;
  transport: 'sse' | 'streamable-http' | 'stdio';
  server_url: string | null;
  stdio_command: string | null;
  stdio_args: string[] | null;
  auth_type: string;
  auth_config_encrypted: Record<string, unknown> | null;
  default_trust_tier: 'auto' | 'quick' | 'full';
};

type Props = {
  connection?: McpConnection | null;
  onClose: () => void;
  onSaved: () => void;
  prefill?: {
    name: string;
    transport: 'sse' | 'streamable-http' | 'stdio';
    server_url?: string;
    stdio_command?: string;
    stdio_args?: string[];
    auth_type?: string;
    default_trust_tier?: 'auto' | 'quick' | 'full';
  } | null;
};

const TRUST_TIERS = [
  { value: 'auto', label: 'Auto-execute' },
  { value: 'quick', label: 'Quick-approve' },
  { value: 'full', label: 'Full-review' },
] as const;

const isSelfHosted = process.env.NEXT_PUBLIC_DEFT_SELF_HOSTED === 'true';

const TRANSPORT_OPTIONS = isSelfHosted
  ? (['sse', 'streamable-http', 'stdio'] as const)
  : (['sse', 'streamable-http'] as const);

export default function McpConnectionForm({ connection, onClose, onSaved, prefill }: Props) {
  const isEdit = !!connection;

  const [name, setName] = useState(connection?.name || prefill?.name || '');
  const [transport, setTransport] = useState<'sse' | 'streamable-http' | 'stdio'>(
    connection?.transport || prefill?.transport || 'sse'
  );
  const [serverUrl, setServerUrl] = useState(connection?.server_url || prefill?.server_url || '');
  const [stdioCommand, setStdioCommand] = useState(connection?.stdio_command || prefill?.stdio_command || '');
  const [stdioArgs, setStdioArgs] = useState(connection?.stdio_args?.join(' ') || prefill?.stdio_args?.join(' ') || '');
  const [authType, setAuthType] = useState(connection?.auth_type || prefill?.auth_type || 'none');
  const [apiKey, setApiKey] = useState('');
  const [defaultTrustTier, setDefaultTrustTier] = useState<'auto' | 'quick' | 'full'>(
    connection?.default_trust_tier || prefill?.default_trust_tier || 'full'
  );

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [error, setError] = useState('');

  // Reset prefill values when prefill changes
  useEffect(() => {
    if (prefill && !connection) {
      setName(prefill.name);
      setTransport(prefill.transport);
      if (prefill.server_url) setServerUrl(prefill.server_url);
      if (prefill.stdio_command) setStdioCommand(prefill.stdio_command);
      if (prefill.stdio_args) setStdioArgs(prefill.stdio_args.join(' '));
      if (prefill.auth_type) setAuthType(prefill.auth_type);
      if (prefill.default_trust_tier) setDefaultTrustTier(prefill.default_trust_tier);
    }
  }, [prefill, connection]);

  const buildPayload = () => {
    const payload: Record<string, unknown> = {
      name,
      transport,
      default_trust_tier: defaultTrustTier,
      auth_type: authType,
    };

    if (transport === 'stdio') {
      payload.stdio_command = stdioCommand;
      payload.stdio_args = stdioArgs.trim() ? stdioArgs.trim().split(/\s+/) : [];
      payload.server_url = null;
    } else {
      payload.server_url = serverUrl;
      payload.stdio_command = null;
      payload.stdio_args = null;
    }

    if (authType === 'api_key' && apiKey) {
      payload.auth_config_encrypted = { api_key: apiKey };
    }

    return payload;
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaving(true);

    try {
      const payload = buildPayload();
      const res = isEdit
        ? await api.fetch(`/api/mcp-connections/${connection.id}`, {
            method: 'PUT',
            body: JSON.stringify(payload),
          })
        : await api.post('/api/mcp-connections', payload);

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save');
      }

      onSaved();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!isEdit) return;
    setTesting(true);
    setTestResult(null);

    try {
      const res = await api.post(`/api/mcp-connections/${connection.id}/test`);
      const data = await res.json();

      if (data.success) {
        setTestResult({ success: true, message: `Connected successfully. ${data.tools_count} tool(s) discovered.` });
      } else {
        setTestResult({ success: false, message: data.error || 'Connection failed' });
      }
    } catch {
      setTestResult({ success: false, message: 'Network error' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop — sits behind the card; clicking it closes the modal */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className="relative z-10 w-full max-w-lg rounded-xl p-6"
        style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1 rounded"
          style={{ color: 'var(--muted)' }}
        >
          <X size={16} />
        </button>

        <h3
          className="text-[16px] font-semibold mb-5"
          style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
        >
          {isEdit ? 'Edit MCP Connection' : 'Add MCP Server'}
        </h3>

        {error && (
          <div
            className="mb-4 px-3 py-2 text-[12px] rounded"
            style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSave} className="space-y-4">
          {/* Name */}
          <div>
            <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--foreground-secondary)' }}>
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. My Zapier Server"
              required
              className="w-full h-9 px-3 text-[13px] rounded-md outline-none"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
            />
          </div>

          {/* Transport Type */}
          <div>
            <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--foreground-secondary)' }}>
              Transport Type
            </label>
            <div className="flex gap-2">
              {TRANSPORT_OPTIONS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTransport(t)}
                  className="px-3 py-1.5 text-[12px] font-medium rounded-md"
                  style={{
                    background: transport === t ? 'var(--accent)' : 'var(--surface)',
                    color: transport === t ? 'white' : 'var(--foreground-secondary)',
                    border: `1px solid ${transport === t ? 'var(--accent)' : 'var(--border)'}`,
                  }}
                >
                  {t === 'sse' ? 'SSE' : t === 'streamable-http' ? 'Streamable HTTP' : 'Stdio'}
                </button>
              ))}
            </div>
          </div>

          {/* Server URL (for SSE and Streamable HTTP) */}
          {transport !== 'stdio' && (
            <div>
              <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--foreground-secondary)' }}>
                Server URL
              </label>
              <input
                type="url"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://mcp.example.com/sse"
                required
                className="w-full h-9 px-3 text-[13px] rounded-md outline-none"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
              />
            </div>
          )}

          {/* Stdio Command and Args */}
          {transport === 'stdio' && (
            <>
              <div>
                <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--foreground-secondary)' }}>
                  Command
                </label>
                <input
                  type="text"
                  value={stdioCommand}
                  onChange={(e) => setStdioCommand(e.target.value)}
                  placeholder="e.g. npx"
                  required
                  className="w-full h-9 px-3 text-[13px] rounded-md outline-none"
                  style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
                />
              </div>
              <div>
                <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--foreground-secondary)' }}>
                  Arguments (space-separated)
                </label>
                <input
                  type="text"
                  value={stdioArgs}
                  onChange={(e) => setStdioArgs(e.target.value)}
                  placeholder="e.g. -y @modelcontextprotocol/server-filesystem /tmp"
                  className="w-full h-9 px-3 text-[13px] rounded-md outline-none"
                  style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
                />
              </div>
            </>
          )}

          {/* Auth Type */}
          <div>
            <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--foreground-secondary)' }}>
              Authentication
            </label>
            <div className="flex gap-2">
              {(['none', 'api_key', 'oauth'] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setAuthType(a)}
                  className="px-3 py-1.5 text-[12px] font-medium rounded-md"
                  style={{
                    background: authType === a ? 'var(--accent)' : 'var(--surface)',
                    color: authType === a ? 'white' : 'var(--foreground-secondary)',
                    border: `1px solid ${authType === a ? 'var(--accent)' : 'var(--border)'}`,
                  }}
                >
                  {a === 'none' ? 'None' : a === 'api_key' ? 'API Key' : 'OAuth'}
                </button>
              ))}
            </div>
          </div>

          {/* API Key input */}
          {authType === 'api_key' && (
            <div>
              <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--foreground-secondary)' }}>
                API Key
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={isEdit ? '(unchanged)' : 'Enter API key'}
                className="w-full h-9 px-3 text-[13px] rounded-md outline-none"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
              />
            </div>
          )}

          {/* Default Trust Tier */}
          <div>
            <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--foreground-secondary)' }}>
              Default Trust Tier
            </label>
            <select
              value={defaultTrustTier}
              onChange={(e) => setDefaultTrustTier(e.target.value as 'auto' | 'quick' | 'full')}
              className="h-9 px-3 text-[13px] rounded-md outline-none"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
            >
              {TRUST_TIERS.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          {/* Test Result */}
          {testResult && (
            <div
              className="px-3 py-2 text-[12px] rounded"
              style={{
                background: testResult.success ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                color: testResult.success ? '#22c55e' : '#ef4444',
              }}
            >
              {testResult.message}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-between pt-2">
            <div>
              {isEdit && (
                <button
                  type="button"
                  onClick={handleTest}
                  disabled={testing}
                  className="px-3 py-1.5 text-[12px] font-medium rounded-md disabled:opacity-50"
                  style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground-secondary)' }}
                >
                  {testing ? 'Testing...' : 'Test Connection'}
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-[12px] font-medium rounded-md"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground-secondary)' }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving || !name.trim()}
                className="px-4 py-1.5 text-[12px] font-medium rounded-md disabled:opacity-50"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                {saving ? 'Saving...' : isEdit ? 'Update' : 'Add Server'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
