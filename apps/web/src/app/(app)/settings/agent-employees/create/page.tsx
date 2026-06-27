'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { AGENT_RUNTIMES, type AgentRuntimeId, getRuntimeById } from '@/lib/agent-runtime-catalog';
import { ArrowLeft, ArrowRight, Check, X, Copy, Bot } from 'lucide-react';

const AVATAR_COLORS = [
  '#6366f1',
  '#ec4899',
  '#f59e0b',
  '#10b981',
  '#3b82f6',
  '#ef4444',
  '#8b5cf6',
  '#14b8a6',
];

const ROLES = [
  { value: 'project_manager', label: 'Project Manager' },
  { value: 'engineering_lead', label: 'Engineering Lead' },
  { value: 'executive_assistant', label: 'Executive Assistant' },
  { value: 'product_designer', label: 'Product Designer' },
  { value: 'qa_engineer', label: 'QA Engineer' },
  { value: 'customer_success', label: 'Customer Success' },
  { value: 'community_manager', label: 'Community Manager' },
  { value: 'cfo', label: 'CFO' },
  { value: 'custom', label: 'Custom' },
];

const TRUST_LEVELS = [
  {
    value: 'conservative',
    label: 'Conservative',
    desc: 'All actions require approval before execution.',
  },
  {
    value: 'standard',
    label: 'Standard',
    desc: 'Low-risk actions auto-execute, high-risk actions require approval.',
  },
  {
    value: 'autonomous',
    label: 'Autonomous',
    desc: 'Most actions auto-execute. Only destructive actions need approval.',
  },
];

type Template = {
  role: string;
  name: string;
  system_prompt: string;
  expertise_description: string;
  heartbeat_config?: string;
};

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const MCP_ENDPOINT = `${API_BASE}/api/mcp/v1`;
const CHANNEL_ENDPOINT = `${API_BASE}/api/agent-channel/v1`;

export default function CreateAgentEmployeePage() {
  const router = useRouter();

  // Single-step BYOA wizard. We collect identity + trust level on one page,
  // POST to /api/agent-employees, then surface the API key + endpoint URL.
  const [templates, setTemplates] = useState<Template[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Identity
  const [selectedRuntimeId, setSelectedRuntimeId] = useState<AgentRuntimeId>('codex');
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [wakeMode, setWakeMode] = useState<'manual' | 'polling' | 'webhook' | 'external_chat'>('manual');
  const [avatarColor, setAvatarColor] = useState(AVATAR_COLORS[0]);
  const [expertiseDescription, setExpertiseDescription] = useState('');
  const [connectionNotes, setConnectionNotes] = useState('');

  // Trust + cap
  const [trustLevel, setTrustLevel] = useState('conservative');
  const [maxDailyActions, setMaxDailyActions] = useState(50);

  // Success modal
  const [mcpModal, setMcpModal] = useState<{ apiKey: string; channelKey: string | null; employeeId: string } | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [copiedChannelKey, setCopiedChannelKey] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedChannelUrl, setCopiedChannelUrl] = useState(false);
  const [copiedConfig, setCopiedConfig] = useState(false);

  useEffect(() => {
    const runtime = getRuntimeById(selectedRuntimeId);
    setName((current) => current || runtime.defaultName);
    setRole((current) => current || runtime.defaultRole);
    setJobTitle((current) => current || runtime.defaultJobTitle);
    setWakeMode(runtime.defaultWakeMode);
    setExpertiseDescription((current) => current || runtime.defaultExpertise);
  }, [selectedRuntimeId]);

  useEffect(() => {
    api.get('/api/agent-employees/templates').then(async (res) => {
      if (res.ok) {
        setTemplates(await res.json());
      }
    });
  }, []);

  const handleRoleChange = (newRole: string) => {
    setRole(newRole);
    const template = templates.find((t) => t.role === newRole);
    if (template) {
      setExpertiseDescription(template.expertise_description || '');
    } else if (newRole === 'custom') {
      setExpertiseDescription('');
    }
  };

  const selectedRuntime = getRuntimeById(selectedRuntimeId);
  const canSubmit = name.trim().length > 0 && role.length > 0 && !selectedRuntime.disabled;

  const handleSubmit = async () => {
    setError('');
    setSubmitting(true);
    try {
      const res = await api.post('/api/agent-employees', {
        name: name.trim(),
        role,
        runtime_kind: selectedRuntimeId,
        job_title: jobTitle.trim() || undefined,
        wake_mode: wakeMode,
        // BYOA agents own their full system prompt in their own runtime;
        // Deft only needs a placeholder for surfaces that show "what does
        // this agent do".
        system_prompt: `${name.trim()} connects to Deft via MCP.`,
        expertise_description: expertiseDescription.trim() || undefined,
        connection_notes: connectionNotes.trim() || undefined,
        trust_level: trustLevel,
        max_daily_actions: maxDailyActions,
        byoa_model_info: JSON.stringify({
          runtime: selectedRuntimeId,
          runtime_name: getRuntimeById(selectedRuntimeId).name,
          owns_identity: getRuntimeById(selectedRuntimeId).ownsIdentity,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create agent employee');
      }

      const data = await res.json();

      if (data.api_key) {
        setMcpModal({ apiKey: data.api_key, channelKey: data.channel_key ?? null, employeeId: data.employee.id });
      } else {
        // Fallback — shouldn't happen now that every employee is BYOA.
        router.push('/settings/agent-employees');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create agent employee');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyMcpKey = () => {
    if (mcpModal) {
      navigator.clipboard.writeText(mcpModal.apiKey);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    }
  };

  const handleCopyMcpUrl = () => {
    navigator.clipboard.writeText(MCP_ENDPOINT);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  const handleCopyChannelKey = () => {
    if (mcpModal?.channelKey) {
      navigator.clipboard.writeText(mcpModal.channelKey);
      setCopiedChannelKey(true);
      setTimeout(() => setCopiedChannelKey(false), 2000);
    }
  };

  const handleCopyChannelUrl = () => {
    navigator.clipboard.writeText(CHANNEL_ENDPOINT);
    setCopiedChannelUrl(true);
    setTimeout(() => setCopiedChannelUrl(false), 2000);
  };

  const mcpConfig = mcpModal
    ? JSON.stringify(
        {
          mcpServers: {
            deft: {
              url: MCP_ENDPOINT,
              headers: {
                Authorization: `Bearer ${mcpModal.apiKey}`,
              },
            },
          },
        },
        null,
        2,
      )
    : '';

  const channelEnv = mcpModal
    ? [
        `DEFT_CHANNEL_URL=${CHANNEL_ENDPOINT}`,
        `DEFT_CHANNEL_TOKEN=${mcpModal.channelKey ?? '<channel-token>'}`,
        `DEFT_MCP_URL=${MCP_ENDPOINT}`,
        `DEFT_MCP_TOKEN=${mcpModal.apiKey}`,
      ].join('\n')
    : '';

  const handleCopyMcpConfig = () => {
    if (!mcpConfig) return;
    navigator.clipboard.writeText(mcpConfig);
    setCopiedConfig(true);
    setTimeout(() => setCopiedConfig(false), 2000);
  };

  const handleCopyChannelEnv = () => {
    if (!channelEnv) return;
    navigator.clipboard.writeText(channelEnv);
    setCopiedConfig(true);
    setTimeout(() => setCopiedConfig(false), 2000);
  };

  const avatarLetter = name.trim().charAt(0).toUpperCase() || '?';

  return (
    <div className="h-full overflow-y-auto">
    <div className="p-6 max-w-[520px]">
      {/* Header */}
      <button
        onClick={() => router.push('/settings/agent-employees')}
        className="flex items-center gap-1 text-[12px] mb-4"
        style={{ color: 'var(--muted)' }}
      >
        <ArrowLeft size={13} />
        Back to Agent Employees
      </button>

      <h2
        className="text-[20px] font-semibold mb-2"
        style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)', letterSpacing: '-0.01em' }}
      >
        Connect Agent
      </h2>
      <p className="text-[12px] mb-6" style={{ color: 'var(--muted)' }}>
        Pick the runtime you already operate. Deft will create the employee
        record, issue MCP credentials, and show the exact endpoint to paste
        into that runtime.
      </p>

      {error && (
        <div
          className="mb-4 px-3 py-2 text-[12px] rounded"
          style={{ background: 'rgba(147,0,10,0.2)', color: 'var(--error)' }}
        >
          {error}
        </div>
      )}

      {/* Runtime */}
      <div
        className="rounded-xl p-5 mb-4"
        style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
      >
        <h3
          className="text-[13px] font-semibold uppercase tracking-wide mb-4"
          style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
        >
          Runtime
        </h3>
        <div className="grid grid-cols-1 gap-2">
          {AGENT_RUNTIMES.map((runtime) => (
            <button
              key={runtime.id}
              type="button"
              onClick={() => {
                if (runtime.disabled) return;
                setSelectedRuntimeId(runtime.id);
                setName(runtime.defaultName);
                setRole(runtime.defaultRole);
                setJobTitle(runtime.defaultJobTitle);
                setWakeMode(runtime.defaultWakeMode);
                setExpertiseDescription(runtime.defaultExpertise);
              }}
              className="flex items-start gap-3 p-3 text-left rounded-lg"
              style={{
                background: selectedRuntimeId === runtime.id ? 'var(--surface)' : 'transparent',
                border: `1px solid ${selectedRuntimeId === runtime.id ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 8,
                opacity: runtime.disabled ? 0.62 : 1,
                cursor: runtime.disabled ? 'not-allowed' : 'pointer',
              }}
              disabled={runtime.disabled}
            >
              <Bot size={15} style={{ color: 'var(--muted)', marginTop: 2 }} />
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-[13px] font-medium" style={{ color: 'var(--foreground)' }}>
                  <span>{runtime.name}</span>
                  {runtime.disabledReason && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--surface)', color: 'var(--muted)', border: '1px solid var(--border)' }}>
                      {runtime.disabledReason}
                    </span>
                  )}
                </span>
                <span className="block text-[11px] mt-0.5" style={{ color: 'var(--muted)' }}>
                  {runtime.description}
                </span>
              </span>
            </button>
          ))}
        </div>
        <div className="mt-4 rounded-md p-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <div className="text-[11px] font-medium mb-2" style={{ color: 'var(--foreground-secondary)' }}>
            Setup notes
          </div>
          <ul className="space-y-1">
            {getRuntimeById(selectedRuntimeId).setupNotes.map((note) => (
              <li key={note} className="text-[11px]" style={{ color: 'var(--muted)' }}>
                {note}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Identity */}
      <div
        className="rounded-xl p-5 mb-4"
        style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
      >
        <h3
          className="text-[13px] font-semibold uppercase tracking-wide mb-4"
          style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
        >
          Identity
        </h3>
        {getRuntimeById(selectedRuntimeId).ownsIdentity && (
          <p className="text-[11px] mb-4" style={{ color: 'var(--muted)' }}>
            This runtime brings its own system prompt and name. Deft only stores the employee
            record, trust policy, and MCP credentials.
          </p>
        )}

        {/* Name */}
        <label
          className="block text-[11px] font-medium mb-1"
          style={{ color: 'var(--foreground-secondary)' }}
        >
          Name
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Sprint Bot, Alex PM"
          className="w-full h-9 px-3 text-[13px] rounded-md outline-none mb-4"
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            color: 'var(--foreground)',
            borderRadius: 4,
          }}
        />

        {/* Role */}
        <label
          className="block text-[11px] font-medium mb-1"
          style={{ color: 'var(--foreground-secondary)' }}
        >
          Role
        </label>
        <select
          value={role}
          onChange={(e) => handleRoleChange(e.target.value)}
          className="w-full h-9 px-2 text-[13px] rounded-md outline-none mb-4"
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            color: role ? 'var(--foreground)' : 'var(--muted)',
            borderRadius: 4,
          }}
        >
          <option value="" disabled>
            Select a role...
          </option>
          {ROLES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>

        <label
          className="block text-[11px] font-medium mb-1"
          style={{ color: 'var(--foreground-secondary)' }}
        >
          Job title
        </label>
        <input
          type="text"
          value={jobTitle}
          onChange={(e) => setJobTitle(e.target.value)}
          placeholder="e.g. Marketing Agent, QA Engineer"
          className="w-full h-9 px-3 text-[13px] rounded-md outline-none mb-4"
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            color: 'var(--foreground)',
            borderRadius: 4,
          }}
        />

        <label
          className="block text-[11px] font-medium mb-1"
          style={{ color: 'var(--foreground-secondary)' }}
        >
          Wake mode
        </label>
        <select
          value={wakeMode}
          onChange={(e) => setWakeMode(e.target.value as typeof wakeMode)}
          className="w-full h-9 px-2 text-[13px] rounded-md outline-none mb-4"
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            color: 'var(--foreground)',
            borderRadius: 4,
          }}
        >
          <option value="manual">Manual / human prompted</option>
          <option value="polling">Runtime polls or heartbeats</option>
          <option value="webhook">Webhook triggered</option>
          <option value="external_chat">External chat surface</option>
        </select>

        {/* Avatar color */}
        <label
          className="block text-[11px] font-medium mb-2"
          style={{ color: 'var(--foreground-secondary)' }}
        >
          Avatar
        </label>
        <div className="flex items-center gap-3 mb-4">
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center text-[16px] font-medium text-white flex-shrink-0"
            style={{ background: avatarColor }}
          >
            {avatarLetter}
          </div>
          <div className="flex gap-2 flex-wrap">
            {AVATAR_COLORS.map((color) => (
              <button
                key={color}
                onClick={() => setAvatarColor(color)}
                className="w-7 h-7 rounded-full transition-transform"
                style={{
                  background: color,
                  border: avatarColor === color ? '2px solid var(--foreground)' : '2px solid transparent',
                  transform: avatarColor === color ? 'scale(1.1)' : 'scale(1)',
                }}
              />
            ))}
          </div>
        </div>

        {/* Expertise */}
        <label
          className="block text-[11px] font-medium mb-1"
          style={{ color: 'var(--foreground-secondary)' }}
        >
          Expertise (optional)
        </label>
        <input
          type="text"
          value={expertiseDescription}
          onChange={(e) => setExpertiseDescription(e.target.value)}
          placeholder="e.g. Sprint tracking, blocker detection"
          className="w-full h-9 px-3 text-[13px] rounded-md outline-none mb-4"
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            color: 'var(--foreground)',
            borderRadius: 4,
          }}
        />

        <label
          className="block text-[11px] font-medium mb-1"
          style={{ color: 'var(--foreground-secondary)' }}
        >
          Connection notes (optional)
        </label>
        <textarea
          value={connectionNotes}
          onChange={(e) => setConnectionNotes(e.target.value)}
          placeholder="Runtime already running, config path, operator notes, or restart requirement"
          className="w-full min-h-[76px] px-3 py-2 text-[13px] rounded-md outline-none resize-y"
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            color: 'var(--foreground)',
            borderRadius: 4,
          }}
        />
      </div>

      {/* Trust + cap */}
      <div
        className="rounded-xl p-5"
        style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
      >
        <h3
          className="text-[13px] font-semibold uppercase tracking-wide mb-4"
          style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
        >
          Trust &amp; Limits
        </h3>

        <label
          className="block text-[11px] font-medium mb-2"
          style={{ color: 'var(--foreground-secondary)' }}
        >
          Trust Level
        </label>
        <div className="space-y-2 mb-5">
          {TRUST_LEVELS.map((tl) => (
            <label
              key={tl.value}
              className="flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-colors"
              style={{
                background: trustLevel === tl.value ? 'var(--surface)' : 'transparent',
                border: `1px solid ${trustLevel === tl.value ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 8,
              }}
            >
              <input
                type="radio"
                name="trust_level"
                value={tl.value}
                checked={trustLevel === tl.value}
                onChange={() => setTrustLevel(tl.value)}
                className="mt-0.5 accent-current"
                style={{ accentColor: 'var(--accent)' }}
              />
              <div>
                <p
                  className="text-[13px] font-medium"
                  style={{ color: 'var(--foreground)' }}
                >
                  {tl.label}
                </p>
                <p className="text-[11px] mt-0.5" style={{ color: 'var(--muted)' }}>
                  {tl.desc}
                </p>
              </div>
            </label>
          ))}
        </div>

        <label
          className="block text-[11px] font-medium mb-1"
          style={{ color: 'var(--foreground-secondary)' }}
        >
          Max Daily Actions
        </label>
        <input
          type="number"
          value={maxDailyActions}
          onChange={(e) => setMaxDailyActions(Math.max(1, parseInt(e.target.value) || 1))}
          min={1}
          className="w-32 h-9 px-3 text-[13px] rounded-md outline-none"
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            color: 'var(--foreground)',
            borderRadius: 4,
          }}
        />
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end mt-5">
        <button
          onClick={handleSubmit}
          disabled={submitting || !canSubmit}
          className="flex items-center gap-1 px-4 py-2 text-[12px] font-medium rounded-md disabled:opacity-40"
          style={{
            background: 'var(--accent)',
            color: 'white',
            borderRadius: 6,
          }}
        >
          {submitting ? 'Creating...' : 'Create'}
          {!submitting && (
            <>
              <Check size={13} />
              <ArrowRight size={13} />
            </>
          )}
        </button>
      </div>

      {/* MCP Success Modal */}
      {mcpModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
          <div
            className="w-full max-w-md max-h-[90vh] overflow-y-auto mx-4 rounded-xl p-6"
            style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
          >
            <div className="flex items-center justify-between mb-4">
              <h3
                className="text-[16px] font-semibold"
                style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
              >
                Agent Connected
              </h3>
              <button
                type="button"
                onClick={() => {
                  setMcpModal(null);
                  router.push(mcpModal ? `/settings/agent-employees/${mcpModal.employeeId}/developer` : '/settings/agent-employees');
                }}
              >
                <X size={16} style={{ color: 'var(--muted)' }} />
              </button>
            </div>

            <p className="text-[12px] mb-4" style={{ color: 'var(--muted)' }}>
              Paste these credentials into your MCP client config. The bearer token is shown
              once — copy it now.
            </p>

            {/* MCP Endpoint URL */}
            <label
              className="block text-[11px] font-medium mb-1"
              style={{ color: 'var(--foreground-secondary)' }}
            >
              MCP Endpoint URL
            </label>
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-md mb-4"
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                fontFamily: 'monospace',
              }}
            >
              <code className="text-[12px] flex-1 break-all" style={{ color: 'var(--foreground)' }}>
                {MCP_ENDPOINT}
              </code>
              <button
                type="button"
                onClick={handleCopyMcpUrl}
                className="flex-shrink-0 p-1 rounded"
                style={{ color: copiedUrl ? 'var(--accent)' : 'var(--muted)' }}
                title="Copy endpoint URL"
              >
                {copiedUrl ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>

            {/* Agent Channel Endpoint URL */}
            <label
              className="block text-[11px] font-medium mb-1"
              style={{ color: 'var(--foreground-secondary)' }}
            >
              Agent Channel Endpoint URL
            </label>
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-md mb-4"
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                fontFamily: 'monospace',
              }}
            >
              <code className="text-[12px] flex-1 break-all" style={{ color: 'var(--foreground)' }}>
                {CHANNEL_ENDPOINT}
              </code>
              <button
                type="button"
                onClick={handleCopyChannelUrl}
                className="flex-shrink-0 p-1 rounded"
                style={{ color: copiedChannelUrl ? 'var(--accent)' : 'var(--muted)' }}
                title="Copy channel endpoint URL"
              >
                {copiedChannelUrl ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>

            {/* Bearer Token */}
            <label
              className="block text-[11px] font-medium mb-1"
              style={{ color: 'var(--foreground-secondary)' }}
            >
              Bearer Token
            </label>
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-md mb-5"
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                fontFamily: 'monospace',
              }}
            >
              <code className="text-[12px] flex-1 break-all" style={{ color: 'var(--foreground)' }}>
                {mcpModal.apiKey}
              </code>
              <button
                type="button"
                onClick={handleCopyMcpKey}
                className="flex-shrink-0 p-1 rounded"
                style={{ color: copiedKey ? 'var(--accent)' : 'var(--muted)' }}
                title="Copy bearer token"
              >
                {copiedKey ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>

            {/* Channel Token */}
            <label
              className="block text-[11px] font-medium mb-1"
              style={{ color: 'var(--foreground-secondary)' }}
            >
              Agent Channel Token
            </label>
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-md mb-5"
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                fontFamily: 'monospace',
              }}
            >
              <code className="text-[12px] flex-1 break-all" style={{ color: 'var(--foreground)' }}>
                {mcpModal.channelKey ?? 'Open Developer tab to generate a channel token'}
              </code>
              {mcpModal.channelKey && (
                <button
                  type="button"
                  onClick={handleCopyChannelKey}
                  className="flex-shrink-0 p-1 rounded"
                  style={{ color: copiedChannelKey ? 'var(--accent)' : 'var(--muted)' }}
                  title="Copy channel token"
                >
                  {copiedChannelKey ? <Check size={14} /> : <Copy size={14} />}
                </button>
              )}
            </div>

            <label
              className="block text-[11px] font-medium mb-1"
              style={{ color: 'var(--foreground-secondary)' }}
            >
              MCP Client Config
            </label>
            <div
              className="relative px-3 py-2 rounded-md mb-5"
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                fontFamily: 'monospace',
              }}
            >
              <pre className="text-[11px] whitespace-pre-wrap break-all pr-8" style={{ color: 'var(--foreground)' }}>
                {mcpConfig}
              </pre>
              <button
                type="button"
                onClick={handleCopyMcpConfig}
                className="absolute right-2 top-2 p-1 rounded"
                style={{ color: copiedConfig ? 'var(--accent)' : 'var(--muted)' }}
                title="Copy MCP client config"
              >
                {copiedConfig ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>

            <label
              className="block text-[11px] font-medium mb-1"
              style={{ color: 'var(--foreground-secondary)' }}
            >
              MCP + Agent Channel Environment
            </label>
            <div
              className="relative px-3 py-2 rounded-md mb-5"
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                fontFamily: 'monospace',
              }}
            >
              <pre className="text-[11px] whitespace-pre-wrap break-all pr-8" style={{ color: 'var(--foreground)' }}>
                {channelEnv}
              </pre>
              <button
                type="button"
                onClick={handleCopyChannelEnv}
                className="absolute right-2 top-2 p-1 rounded"
                style={{ color: copiedConfig ? 'var(--accent)' : 'var(--muted)' }}
                title="Copy channel env"
              >
                {copiedConfig ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>

            <p className="text-[11px] mb-4" style={{ color: 'var(--muted)' }}>
              In your MCP client config set{' '}
              <code style={{ fontFamily: 'monospace' }}>url</code> to the endpoint above
              and add an{' '}
              <code style={{ fontFamily: 'monospace' }}>Authorization: Bearer &lt;token&gt;</code>{' '}
              header. See the Deft docs for Claude Desktop and Claude Code examples.
            </p>

            <button
              type="button"
              onClick={() => {
                setMcpModal(null);
                router.push(`/settings/agent-employees/${mcpModal.employeeId}/developer`);
              }}
              className="w-full py-2 text-[12px] font-medium rounded-md"
              style={{
                background: 'var(--accent)',
                color: 'white',
                borderRadius: 6,
              }}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
    </div>
  );
}
