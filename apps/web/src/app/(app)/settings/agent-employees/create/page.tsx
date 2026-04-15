'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { ArrowLeft, ArrowRight, Check, X, Copy } from 'lucide-react';

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
  native_tools: string[] | null;
  heartbeat_config?: string;
};

const isSelfHosted = process.env.NEXT_PUBLIC_DEFT_SELF_HOSTED === 'true';

export default function CreateAgentEmployeePage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Step 1 — Identity
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [avatarColor, setAvatarColor] = useState(AVATAR_COLORS[0]);

  // Step 2 — Instructions
  const [systemPrompt, setSystemPrompt] = useState('');
  const [expertiseDescription, setExpertiseDescription] = useState('');

  // Step 3 — Tools & Trust
  const [trustLevel, setTrustLevel] = useState('conservative');
  const [maxDailyActions, setMaxDailyActions] = useState(50);

  // Step 4 — Heartbeat
  const [heartbeatEnabled, setHeartbeatEnabled] = useState(false);
  const [heartbeatInterval, setHeartbeatInterval] = useState(30);
  const [heartbeatConfig, setHeartbeatConfig] = useState('');

  // API key modal (BYOA)
  const [apiKeyModal, setApiKeyModal] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
      setSystemPrompt(template.system_prompt);
      setExpertiseDescription(template.expertise_description || '');
      if (template.heartbeat_config) {
        setHeartbeatConfig(template.heartbeat_config);
        setHeartbeatEnabled(true);
      }
    } else {
      // Custom role — clear pre-fill
      if (newRole === 'custom') {
        setSystemPrompt('');
        setExpertiseDescription('');
        setHeartbeatConfig('');
        setHeartbeatEnabled(false);
      }
    }
  };

  const canProceedStep1 = name.trim().length > 0 && role.length > 0;
  const canProceedStep2 = systemPrompt.trim().length > 0;

  const handleSubmit = async () => {
    setError('');
    setSubmitting(true);
    try {
      const res = await api.post('/api/agent-employees', {
        name: name.trim(),
        role,
        system_prompt: systemPrompt.trim(),
        expertise_description: expertiseDescription.trim() || undefined,
        trust_level: trustLevel,
        max_daily_actions: maxDailyActions,
        is_byoa: isSelfHosted,
        heartbeat_enabled: heartbeatEnabled,
        heartbeat_interval_min: heartbeatInterval,
        heartbeat_config: heartbeatConfig || undefined,
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create agent employee');
      }

      const data = await res.json();

      if (data.api_key) {
        setApiKeyModal(data.api_key);
      } else {
        router.push('/settings/agent-employees');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create agent employee');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyKey = () => {
    if (apiKeyModal) {
      navigator.clipboard.writeText(apiKeyModal);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const avatarLetter = name.trim().charAt(0).toUpperCase() || '?';

  return (
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
        className="text-[20px] font-semibold mb-6"
        style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)', letterSpacing: '-0.01em' }}
      >
        Create Agent Employee
      </h2>

      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-6">
        {[1, 2, 3, 4].map((s) => (
          <div key={s} className="flex items-center gap-2">
            <div
              className="w-2 h-2 rounded-full transition-colors"
              style={{
                background: s === step ? 'var(--accent)' : s < step ? 'var(--accent)' : 'var(--border)',
                opacity: s <= step ? 1 : 0.5,
              }}
            />
            {s < 4 && (
              <div
                className="w-6 h-px"
                style={{ background: s < step ? 'var(--accent)' : 'var(--border)' }}
              />
            )}
          </div>
        ))}
        <span className="text-[11px] ml-2" style={{ color: 'var(--muted)' }}>
          Step {step} of 4
        </span>
      </div>

      {error && (
        <div
          className="mb-4 px-3 py-2 text-[12px] rounded"
          style={{ background: 'rgba(147,0,10,0.2)', color: 'var(--error)' }}
        >
          {error}
        </div>
      )}

      {/* Step 1: Identity */}
      {step === 1 && (
        <div
          className="rounded-xl p-5"
          style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
        >
          <h3
            className="text-[13px] font-semibold uppercase tracking-wide mb-4"
            style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
          >
            Identity
          </h3>

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

          {/* Avatar color */}
          <label
            className="block text-[11px] font-medium mb-2"
            style={{ color: 'var(--foreground-secondary)' }}
          >
            Avatar
          </label>
          <div className="flex items-center gap-3">
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
        </div>
      )}

      {/* Step 2: Instructions */}
      {step === 2 && (
        <div
          className="rounded-xl p-5"
          style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
        >
          <h3
            className="text-[13px] font-semibold uppercase tracking-wide mb-4"
            style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
          >
            Instructions
          </h3>

          {/* System prompt */}
          <label
            className="block text-[11px] font-medium mb-1"
            style={{ color: 'var(--foreground-secondary)' }}
          >
            System Prompt
          </label>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="Describe what this agent should do, how it should behave, and any constraints..."
            rows={8}
            className="w-full px-3 py-2 text-[13px] rounded-md outline-none resize-y mb-4"
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              color: 'var(--foreground)',
              borderRadius: 4,
              minHeight: 120,
            }}
          />

          {/* Expertise */}
          <label
            className="block text-[11px] font-medium mb-1"
            style={{ color: 'var(--foreground-secondary)' }}
          >
            Expertise Description
          </label>
          <input
            type="text"
            value={expertiseDescription}
            onChange={(e) => setExpertiseDescription(e.target.value)}
            placeholder="e.g. Sprint tracking, blocker detection, team coordination"
            className="w-full h-9 px-3 text-[13px] rounded-md outline-none"
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              color: 'var(--foreground)',
              borderRadius: 4,
            }}
          />
        </div>
      )}

      {/* Step 3: Tools & Trust */}
      {step === 3 && (
        <div
          className="rounded-xl p-5"
          style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
        >
          <h3
            className="text-[13px] font-semibold uppercase tracking-wide mb-4"
            style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
          >
            Tools & Trust
          </h3>

          {/* Trust level */}
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

          {/* Max daily actions */}
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
            className="w-32 h-9 px-3 text-[13px] rounded-md outline-none mb-4"
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              color: 'var(--foreground)',
              borderRadius: 4,
            }}
          />

          {/* Note */}
          <p className="text-[11px] mt-2" style={{ color: 'var(--muted)' }}>
            Tool and MCP configuration can be done after creation.
          </p>
        </div>
      )}

      {/* Step 4: Heartbeat */}
      {step === 4 && (
        <div
          className="rounded-xl p-5"
          style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
        >
          <h3
            className="text-[13px] font-semibold uppercase tracking-wide mb-1"
            style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
          >
            Heartbeat
          </h3>
          <p className="text-[11px] mb-4" style={{ color: 'var(--muted)' }}>
            Configure proactive monitoring. The agent wakes up at the specified interval and checks its task list. If nothing needs attention, it stays silent.
          </p>

          {/* Enable checkbox */}
          <label
            className="flex items-center gap-2 cursor-pointer mb-4"
          >
            <input
              type="checkbox"
              checked={heartbeatEnabled}
              onChange={(e) => setHeartbeatEnabled(e.target.checked)}
              className="accent-current"
              style={{ accentColor: 'var(--accent)' }}
            />
            <span className="text-[13px]" style={{ color: 'var(--foreground)' }}>
              Enable heartbeat monitoring
            </span>
          </label>

          {heartbeatEnabled && (
            <>
              {/* Interval */}
              <label
                className="block text-[11px] font-medium mb-1"
                style={{ color: 'var(--foreground-secondary)' }}
              >
                Check every (minutes)
              </label>
              <input
                type="number"
                value={heartbeatInterval}
                onChange={(e) => setHeartbeatInterval(Math.max(5, Math.min(1440, parseInt(e.target.value) || 5)))}
                min={5}
                max={1440}
                className="w-32 h-9 px-3 text-[13px] rounded-md outline-none mb-4"
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  color: 'var(--foreground)',
                  borderRadius: 4,
                }}
              />

              {/* Heartbeat checklist */}
              <label
                className="block text-[11px] font-medium mb-1"
                style={{ color: 'var(--foreground-secondary)' }}
              >
                Heartbeat Checklist
              </label>
              <textarea
                value={heartbeatConfig}
                onChange={(e) => setHeartbeatConfig(e.target.value)}
                placeholder={"### Every 30 minutes:\n- Check for overdue tasks..."}
                rows={8}
                className="w-full px-3 py-2 text-[13px] rounded-md outline-none resize-y mb-2"
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  color: 'var(--foreground)',
                  borderRadius: 4,
                  minHeight: 120,
                }}
              />
              <p className="text-[11px]" style={{ color: 'var(--muted)' }}>
                Write in plain English. Use ### headings for different intervals.
              </p>
            </>
          )}
        </div>
      )}

      {/* Navigation */}
      <div className="flex items-center justify-between mt-5">
        <div>
          {step > 1 && (
            <button
              onClick={() => setStep(step - 1)}
              className="flex items-center gap-1 px-4 py-2 text-[12px] font-medium rounded-md"
              style={{
                background: 'var(--surface)',
                color: 'var(--foreground)',
                border: '1px solid var(--border)',
                borderRadius: 6,
              }}
            >
              <ArrowLeft size={13} />
              Back
            </button>
          )}
        </div>
        <div>
          {step < 4 ? (
            <button
              onClick={() => setStep(step + 1)}
              disabled={step === 1 ? !canProceedStep1 : step === 2 ? !canProceedStep2 : false}
              className="flex items-center gap-1 px-4 py-2 text-[12px] font-medium rounded-md disabled:opacity-40"
              style={{
                background: 'var(--accent)',
                color: 'white',
                borderRadius: 6,
              }}
            >
              Next
              <ArrowRight size={13} />
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="flex items-center gap-1 px-4 py-2 text-[12px] font-medium rounded-md disabled:opacity-40"
              style={{
                background: 'var(--accent)',
                color: 'white',
                borderRadius: 6,
              }}
            >
              {submitting ? 'Creating...' : 'Create'}
              {!submitting && <Check size={13} />}
            </button>
          )}
        </div>
      </div>

      {/* API Key Modal (BYOA) */}
      {apiKeyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
          <div
            className="w-full max-w-md mx-4 rounded-xl p-6"
            style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
          >
            <div className="flex items-center justify-between mb-4">
              <h3
                className="text-[16px] font-semibold"
                style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
              >
                API Key Created
              </h3>
              <button
                onClick={() => {
                  setApiKeyModal(null);
                  router.push('/settings/agent-employees');
                }}
              >
                <X size={16} style={{ color: 'var(--muted)' }} />
              </button>
            </div>

            <p className="text-[12px] mb-3" style={{ color: 'var(--muted)' }}>
              Copy this API key now. You will not be able to see it again.
            </p>

            <div
              className="flex items-center gap-2 px-3 py-2 rounded-md mb-4"
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                fontFamily: 'monospace',
              }}
            >
              <code className="text-[12px] flex-1 break-all" style={{ color: 'var(--foreground)' }}>
                {apiKeyModal}
              </code>
              <button
                onClick={handleCopyKey}
                className="flex-shrink-0 p-1 rounded"
                style={{ color: copied ? 'var(--accent)' : 'var(--muted)' }}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>

            <button
              onClick={() => {
                setApiKeyModal(null);
                router.push('/settings/agent-employees');
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
  );
}
