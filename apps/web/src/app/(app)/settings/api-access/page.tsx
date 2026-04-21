'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { Trash2, X, Plus, Copy, Check, Key } from 'lucide-react';

type ApiKey = {
  id: string;
  name: string;
  key_prefix: string;
  agent_employee_id: string | null;
  permissions: string[];
  rate_limit_per_minute: number;
  rate_limit_per_day: number;
  last_used_at: string | null;
  request_count: number;
  is_active: boolean;
  expires_at: string | null;
  created_at: string;
};

type AgentEmployee = {
  id: string;
  name: string;
  role: string;
  is_active: boolean;
};

export default function ApiAccessPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [employees, setEmployees] = useState<AgentEmployee[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);

  // Create form state
  const [name, setName] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [scope, setScope] = useState<'mcp:full' | 'mcp:read'>('mcp:full');
  const [ratePerMin, setRatePerMin] = useState(60);
  const [ratePerDay, setRatePerDay] = useState(10000);
  const [expiresAt, setExpiresAt] = useState('');
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState('');

  const fetchKeys = async () => {
    const res = await api.get('/api/api-keys');
    if (res.ok) setKeys(await res.json());
  };

  useEffect(() => {
    Promise.all([
      api.get('/api/api-keys').then(async res => {
        if (res.ok) setKeys(await res.json());
      }),
      api.get('/api/agent-employees').then(async res => {
        if (res.ok) setEmployees(await res.json());
      }),
    ]).finally(() => setLoading(false));
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError('');
    setCreateLoading(true);
    try {
      const res = await api.post('/api/api-keys', {
        name,
        agent_employee_id: employeeId || null,
        permissions: [scope],
        rate_limit_per_minute: ratePerMin,
        rate_limit_per_day: ratePerDay,
        expires_at: expiresAt || null,
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create key');
      }
      const data = await res.json();
      setCreatedKey(data.raw_key);
      setShowCreate(false);
      setName('');
      setEmployeeId('');
      setScope('mcp:full');
      setRatePerMin(60);
      setRatePerDay(10000);
      setExpiresAt('');
      fetchKeys();
    } catch (err: any) {
      setCreateError(err.message);
    } finally {
      setCreateLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    const res = await api.delete(`/api/api-keys/${id}`);
    if (res.ok) {
      setKeys(prev => prev.filter(k => k.id !== id));
    }
    setConfirmDelete(null);
  };

  const handleToggleActive = async (key: ApiKey) => {
    const res = await api.fetch(`/api/api-keys/${key.id}`, {
      method: 'PUT',
      body: JSON.stringify({ is_active: !key.is_active }),
    });
    if (res.ok) {
      setKeys(prev => prev.map(k => k.id === key.id ? { ...k, is_active: !k.is_active } : k));
    }
  };

  const handleCopy = () => {
    if (createdKey) {
      navigator.clipboard.writeText(createdKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const getEmployeeName = (id: string | null) => {
    if (!id) return null;
    const emp = employees.find(e => e.id === id);
    return emp?.name || null;
  };

  if (loading) {
    return (
      <div className="p-6 max-w-[700px]">
        <p className="text-[13px]" style={{ color: 'var(--muted)' }}>Loading...</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
    <div className="p-6 max-w-[700px]">
      <div className="flex items-center justify-between mb-4">
        <h2
          className="text-[18px] font-semibold"
          style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
        >
          API Access
        </h2>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium"
          style={{
            background: 'var(--accent)',
            color: 'white',
            fontFamily: 'var(--font-heading)',
          }}
        >
          <Plus size={13} />
          Create API Key
        </button>
      </div>

      {/* One-time key display modal */}
      {createdKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
          <div
            className="w-full max-w-md rounded-xl p-6"
            style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
          >
            <div className="flex items-center justify-between mb-4">
              <h3
                className="text-[15px] font-semibold"
                style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
              >
                API Key Created
              </h3>
              <button onClick={() => { setCreatedKey(null); setCopied(false); }}>
                <X size={16} style={{ color: 'var(--muted)' }} />
              </button>
            </div>
            <p className="text-[12px] mb-3" style={{ color: 'var(--muted)' }}>
              Copy this key now. It will not be shown again.
            </p>
            <div
              className="flex items-center gap-2 p-3 rounded-lg mb-4"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
            >
              <code
                className="flex-1 text-[12px] break-all"
                style={{ fontFamily: 'monospace', color: 'var(--foreground)' }}
              >
                {createdKey}
              </code>
              <button
                onClick={handleCopy}
                className="flex-shrink-0 p-1.5 rounded"
                style={{ background: 'var(--surface-container)', color: copied ? 'var(--accent)' : 'var(--muted)' }}
                title="Copy to clipboard"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
            <button
              onClick={() => { setCreatedKey(null); setCopied(false); }}
              className="w-full py-2 rounded-lg text-[13px] font-medium"
              style={{ background: 'var(--accent)', color: 'white' }}
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* Create form */}
      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="mb-4 p-4 rounded-lg space-y-3"
          style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
        >
          {createError && (
            <div className="px-3 py-2 text-[12px] rounded" style={{ background: 'rgba(147,0,10,0.2)', color: 'var(--error)' }}>
              {createError}
            </div>
          )}
          <div>
            <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--muted)' }}>Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Production MCP Key"
              className="w-full h-9 px-3 text-[13px] rounded-md outline-none"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
              required
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--muted)' }}>Link to Agent Employee</label>
            <select
              value={employeeId}
              onChange={e => setEmployeeId(e.target.value)}
              className="w-full h-9 px-2 text-[13px] rounded-md outline-none"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
            >
              <option value="">None</option>
              {employees.map(emp => (
                <option key={emp.id} value={emp.id}>{emp.name} ({emp.role})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--muted)' }}>Access scope</label>
            <select
              value={scope}
              onChange={e => setScope(e.target.value as 'mcp:full' | 'mcp:read')}
              className="w-full h-9 px-2 text-[13px] rounded-md outline-none"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
            >
              <option value="mcp:full">Full access — read + write + execute tools</option>
              <option value="mcp:read">Read-only — list tools and resources, no mutations</option>
            </select>
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--muted)' }}>Requests / minute</label>
              <input
                type="number"
                value={ratePerMin}
                onChange={e => setRatePerMin(Number(e.target.value))}
                min={1}
                className="w-full h-9 px-3 text-[13px] rounded-md outline-none"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
              />
            </div>
            <div className="flex-1">
              <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--muted)' }}>Requests / day</label>
              <input
                type="number"
                value={ratePerDay}
                onChange={e => setRatePerDay(Number(e.target.value))}
                min={1}
                className="w-full h-9 px-3 text-[13px] rounded-md outline-none"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
              />
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--muted)' }}>Expiration date (optional)</label>
            <input
              type="date"
              value={expiresAt}
              onChange={e => setExpiresAt(e.target.value)}
              className="w-full h-9 px-3 text-[13px] rounded-md outline-none"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => { setShowCreate(false); setCreateError(''); }}
              className="px-3 py-1.5 text-[12px] rounded-md"
              style={{ color: 'var(--muted)' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createLoading}
              className="px-4 py-1.5 text-[12px] font-medium rounded-md disabled:opacity-50"
              style={{ background: 'var(--accent)', color: 'white' }}
            >
              {createLoading ? 'Creating...' : 'Create Key'}
            </button>
          </div>
        </form>
      )}

      {/* Key list */}
      {keys.length === 0 ? (
        <div
          className="rounded-xl p-8 text-center"
          style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
        >
          <Key size={32} style={{ color: 'var(--muted)', margin: '0 auto 12px' }} />
          <p className="text-[14px] font-medium mb-1" style={{ color: 'var(--foreground)' }}>
            No API keys yet
          </p>
          <p className="text-[12px]" style={{ color: 'var(--muted)' }}>
            Create a key to let external agents connect.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {keys.map(k => (
            <div
              key={k.id}
              className="flex items-center gap-3 px-4 py-3 rounded-lg"
              style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', opacity: k.is_active ? 1 : 0.6 }}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p
                    className="text-[14px] font-medium truncate"
                    style={{ color: 'var(--foreground)' }}
                  >
                    {k.name}
                  </p>
                  {!k.is_active && (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded"
                      style={{ background: 'var(--surface)', color: 'var(--muted)' }}
                    >
                      Inactive
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-1">
                  <code
                    className="text-[12px]"
                    style={{ fontFamily: 'monospace', color: 'var(--muted)' }}
                  >
                    {k.key_prefix}...
                  </code>
                  {getEmployeeName(k.agent_employee_id) && (
                    <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                      {getEmployeeName(k.agent_employee_id)}
                    </span>
                  )}
                  <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'var(--surface)', color: 'var(--muted)' }}>
                    {k.permissions.includes('mcp:read') && !k.permissions.includes('mcp:full') ? 'read-only' : 'full access'}
                  </span>
                  {k.last_used_at && (
                    <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                      Last used {new Date(k.last_used_at).toLocaleDateString('en', { month: 'short', day: 'numeric' })}
                    </span>
                  )}
                  <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                    {k.request_count.toLocaleString()} requests
                  </span>
                </div>
              </div>

              {/* Active toggle */}
              <button
                onClick={() => handleToggleActive(k)}
                className="relative w-8 h-[18px] rounded-full transition-colors flex-shrink-0"
                style={{
                  background: k.is_active ? 'var(--accent)' : 'var(--border)',
                }}
                title={k.is_active ? 'Deactivate' : 'Activate'}
              >
                <div
                  className="absolute top-[2px] w-[14px] h-[14px] rounded-full transition-all"
                  style={{
                    background: 'white',
                    left: k.is_active ? '16px' : '2px',
                  }}
                />
              </button>

              {/* Delete */}
              {confirmDelete === k.id ? (
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => handleDelete(k.id)}
                    className="text-[11px] px-2 py-0.5 rounded"
                    style={{ background: 'var(--error)', color: 'white' }}
                  >
                    Confirm
                  </button>
                  <button onClick={() => setConfirmDelete(null)}>
                    <X size={12} style={{ color: 'var(--muted)' }} />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDelete(k.id)}
                  className="p-1 rounded flex-shrink-0"
                  style={{ color: 'var(--muted)' }}
                  title="Delete key"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
    </div>
  );
}
