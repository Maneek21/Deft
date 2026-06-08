'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Database, Eye, EyeOff, KeyRound, Loader2, Mic, RotateCcw, Save, Server, Sparkles, Trash2 } from 'lucide-react';

type Provider = 'anthropic' | 'openai' | 'openrouter' | 'ollama';
type Task = 'classify' | 'summarize' | 'reason' | 'extract';
type EmbedProvider = 'openai' | 'off';
type TranscriptionProvider = 'local' | 'openai' | 'deepgram';

type ModelRoute = { provider: Provider; model: string; baseUrl?: string };

type EmbedConfig = {
  provider: EmbedProvider;
  base_url: string;
  model: string;
  has_key: boolean;
};

type TranscriptionConfig = {
  provider: TranscriptionProvider;
  effective: TranscriptionProvider;
};

type AIConfig = {
  api_keys: Record<Provider, { configured: boolean; mask: string | null }>;
  ai_models: Partial<Record<Task, ModelRoute>>;
  ollama_url: string | null;
  env_fallback: Record<Provider, boolean>;
  has_provider: boolean;
  embed: EmbedConfig;
  transcription: TranscriptionConfig;
};

const PROVIDERS: { id: Provider; label: string; placeholder: string; hint: string }[] = [
  { id: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-…', hint: 'Optional managed provider for Claude models.' },
  { id: 'openai', label: 'OpenAI', placeholder: 'sk-…', hint: 'Optional managed provider for GPT models and compatible APIs.' },
  { id: 'openrouter', label: 'OpenRouter', placeholder: 'sk-or-…', hint: 'Proxy to dozens of models through a single key.' },
  { id: 'ollama', label: 'Ollama', placeholder: 'http://localhost:11434', hint: 'Self-hosted local models. Provide the server URL instead of a key.' },
];

const TASKS: { id: Task; label: string; description: string }[] = [
  { id: 'classify', label: 'Classify', description: 'Fast, cheap calls — message intents, urgency, entity extraction.' },
  { id: 'summarize', label: 'Summarize', description: 'Thread digests, daily standups, briefings.' },
  { id: 'reason', label: 'Reason', description: 'Multi-step planning, agent execution, hard questions.' },
  { id: 'extract', label: 'Extract', description: 'Structured output — task fields, dates, citations.' },
];

export default function AISettingsPage() {
  const { user, org } = useAuth();
  const [cfg, setCfg] = useState<AIConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');

  const isAdmin = user?.role === 'owner' || user?.role === 'admin';

  const refresh = async () => {
    const r = await api.get('/api/org/ai-config');
    if (!r.ok) {
      setError('Failed to load AI configuration.');
      setLoading(false);
      return;
    }
    setCfg(await r.json());
    setLoading(false);
  };

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    refresh();
  }, [isAdmin]);

  if (!isAdmin) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="p-6 max-w-[600px]">
          <h2
            className="text-[18px] font-semibold mb-3"
            style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
          >
            AI providers
          </h2>
          <div
            className="p-4 rounded-lg text-[13px] leading-relaxed"
            style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', color: 'var(--foreground-secondary)' }}
          >
            Only owners and admins can configure AI providers for this workspace.
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-full grid place-items-center">
        <Loader2 size={20} className="animate-spin" style={{ color: 'var(--muted)' }} />
      </div>
    );
  }

  if (!cfg) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <div className="text-[13px]" style={{ color: 'var(--error)' }}>{error || 'Failed to load.'}</div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-[720px]">
        <div className="mb-6">
          <h2
            className="text-[18px] font-semibold"
            style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
          >
            AI providers for {org?.name ?? 'your workspace'}
          </h2>
          <p className="text-[12px] mt-1 leading-relaxed" style={{ color: 'var(--muted)' }}>
            Bring your own provider. Deft can use managed keys or local Ollama, and the core workspace keeps
            working when no AI provider is configured. Keys are encrypted at rest and only used for this workspace.
          </p>
          {!cfg.has_provider && (
            <div
              className="mt-3 p-3 rounded-lg text-[12px] leading-relaxed"
              style={{ background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.25)', color: 'var(--foreground-secondary)' }}
            >
              AI is currently off. Chat, tasks, wiki, calendar, and approvals still work; Defty and AI-assisted
              features wake up after you configure any supported provider.
            </div>
          )}
        </div>

        <section className="mb-8">
          <h3
            className="text-[11px] font-semibold uppercase tracking-wide mb-3"
            style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
          >
            Provider keys
          </h3>
          <div className="space-y-2">
            {PROVIDERS.map((p) => (
              <ProviderCard
                key={p.id}
                provider={p.id}
                label={p.label}
                placeholder={p.placeholder}
                hint={p.hint}
                cfg={cfg}
                onSaved={refresh}
              />
            ))}
          </div>
        </section>

        <section className="mb-8">
          <h3
            className="text-[11px] font-semibold uppercase tracking-wide mb-1"
            style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
          >
            Model routing
          </h3>
          <p className="text-[12px] mb-3 leading-relaxed" style={{ color: 'var(--muted)' }}>
            Override which provider and model handle each kind of work. Leave a row at default to use Deft's tuned defaults.
          </p>
          <div className="space-y-2">
            {TASKS.map((t) => (
              <ModelRouteCard key={t.id} task={t.id} label={t.label} description={t.description} cfg={cfg} onSaved={refresh} />
            ))}
          </div>
        </section>

        <section className="mb-8">
          <h3
            className="text-[11px] font-semibold uppercase tracking-wide mb-1"
            style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
          >
            Embeddings
          </h3>
          <p className="text-[12px] mb-3 leading-relaxed" style={{ color: 'var(--muted)' }}>
            Powers semantic search across the wiki, tasks, and decisions. Falls back to keyword search when off.
          </p>
          <EmbedSection cfg={cfg} onSaved={refresh} />
        </section>

        <section>
          <h3
            className="text-[11px] font-semibold uppercase tracking-wide mb-1"
            style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
          >
            Voice transcription
          </h3>
          <p className="text-[12px] mb-3 leading-relaxed" style={{ color: 'var(--muted)' }}>
            Transcribes voice clips posted in chat. The default 'local' provider calls a self-hosted Whisper container — no audio leaves your infrastructure.
          </p>
          <TranscriptionSection cfg={cfg} onSaved={refresh} />
        </section>
      </div>
    </div>
  );
}

function ProviderCard({
  provider,
  label,
  placeholder,
  hint,
  cfg,
  onSaved,
}: {
  provider: Provider;
  label: string;
  placeholder: string;
  hint: string;
  cfg: AIConfig;
  onSaved: () => Promise<void>;
}) {
  const isOllama = provider === 'ollama';
  const meta = cfg.api_keys[provider];
  const envFallback = cfg.env_fallback[provider];
  const ollamaUrl = cfg.ollama_url;

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const configured = isOllama ? Boolean(ollamaUrl) : meta.configured;
  const display = isOllama ? ollamaUrl : meta.mask;

  const save = async () => {
    setSaving(true);
    setErr('');
    try {
      const body = isOllama
        ? { ollama_url: value }
        : { api_keys: { [provider]: value } };
      const r = await api.put('/api/org/ai-config', body);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || 'Save failed');
      }
      setValue('');
      setEditing(false);
      await onSaved();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    setErr('');
    try {
      const body = isOllama ? { ollama_url: null } : { api_keys: { [provider]: '' } };
      const r = await api.put('/api/org/ai-config', body);
      if (!r.ok) throw new Error('Clear failed');
      setValue('');
      setEditing(false);
      await onSaved();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="p-4 rounded-lg"
      style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-start gap-3">
        <div
          className="w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0"
          style={{ background: 'var(--surface)', color: 'var(--foreground-secondary)' }}
        >
          {isOllama ? <Server size={14} /> : <KeyRound size={14} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[13px] font-medium" style={{ color: 'var(--foreground)' }}>{label}</p>
            {configured ? (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded"
                style={{ background: 'rgba(34,197,94,0.15)', color: 'var(--success, #22c55e)' }}
              >
                Configured
              </span>
            ) : envFallback && !isOllama ? (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded"
                style={{ background: 'var(--surface)', color: 'var(--muted)' }}
              >
                env provider available
              </span>
            ) : (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded"
                style={{ background: 'var(--surface)', color: 'var(--muted)' }}
              >
                Not configured
              </span>
            )}
          </div>
          <p className="text-[12px] mt-0.5 leading-snug" style={{ color: 'var(--muted)' }}>
            {hint}
          </p>
          {configured && display && (
            <p className="text-[11px] mt-1 font-mono" style={{ color: 'var(--foreground-secondary)' }}>
              {display}
            </p>
          )}
        </div>
        {!editing && (
          <button
            onClick={() => { setEditing(true); setErr(''); setValue(''); }}
            className="text-[12px] font-medium px-3 py-1.5 rounded-md flex-shrink-0"
            style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
          >
            {configured ? 'Replace' : 'Add'}
          </button>
        )}
      </div>

      {editing && (
        <div className="mt-3">
          {err && (
            <div
              className="mb-2 px-3 py-2 text-[12px] rounded"
              style={{ background: 'rgba(147,0,10,0.2)', color: 'var(--error)' }}
            >
              {err}
            </div>
          )}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type={reveal || isOllama ? 'text' : 'password'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={placeholder}
                autoFocus
                className="w-full h-9 px-3 pr-9 text-[13px] rounded-md outline-none font-mono"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
              />
              {!isOllama && (
                <button
                  type="button"
                  onClick={() => setReveal((r) => !r)}
                  aria-label={reveal ? 'Hide' : 'Reveal'}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1"
                  style={{ color: 'var(--muted)' }}
                >
                  {reveal ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              )}
            </div>
            <button
              onClick={save}
              disabled={saving || !value.trim()}
              className="h-9 px-3 flex items-center gap-1.5 text-[12px] font-medium rounded-md disabled:opacity-50"
              style={{ background: 'var(--accent)', color: 'white' }}
            >
              <Save size={12} />
              {saving ? '...' : 'Save'}
            </button>
            <button
              onClick={() => { setEditing(false); setValue(''); setErr(''); }}
              className="h-9 px-3 text-[12px] font-medium rounded-md"
              style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
            >
              Cancel
            </button>
            {configured && (
              <button
                onClick={clear}
                disabled={saving}
                title="Clear stored value"
                className="h-9 px-3 flex items-center gap-1.5 text-[12px] font-medium rounded-md disabled:opacity-50"
                style={{ background: 'var(--surface)', color: 'var(--error)', border: '1px solid var(--border)' }}
              >
                <Trash2 size={12} />
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ModelRouteCard({
  task,
  label,
  description,
  cfg,
  onSaved,
}: {
  task: Task;
  label: string;
  description: string;
  cfg: AIConfig;
  onSaved: () => Promise<void>;
}) {
  const current = cfg.ai_models[task];
  const [editing, setEditing] = useState(false);
  const [provider, setProvider] = useState<Provider>(current?.provider ?? 'anthropic');
  const [model, setModel] = useState<string>(current?.model ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    if (!model.trim()) {
      setErr('Model name required');
      return;
    }
    setSaving(true);
    setErr('');
    try {
      const r = await api.put('/api/org/ai-config', {
        ai_models: { [task]: { provider, model: model.trim() } },
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || 'Save failed');
      }
      setEditing(false);
      await onSaved();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    setErr('');
    try {
      const r = await api.put('/api/org/ai-config', { ai_models: { [task]: null } });
      if (!r.ok) throw new Error('Reset failed');
      setEditing(false);
      await onSaved();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="p-4 rounded-lg"
      style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-start gap-3">
        <div
          className="w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0"
          style={{ background: 'var(--surface)', color: 'var(--foreground-secondary)' }}
        >
          <Sparkles size={14} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium" style={{ color: 'var(--foreground)' }}>{label}</p>
          <p className="text-[12px] mt-0.5 leading-snug" style={{ color: 'var(--muted)' }}>
            {description}
          </p>
          <p className="text-[11px] mt-1 font-mono" style={{ color: current ? 'var(--foreground-secondary)' : 'var(--muted)' }}>
            {current ? `${current.provider} · ${current.model}` : 'Default — uses the first configured provider'}
          </p>
        </div>
        {!editing && (
          <div className="flex gap-2 flex-shrink-0">
            <button
              onClick={() => { setEditing(true); setProvider(current?.provider ?? 'anthropic'); setModel(current?.model ?? ''); setErr(''); }}
              className="text-[12px] font-medium px-3 py-1.5 rounded-md"
              style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
            >
              {current ? 'Edit' : 'Set'}
            </button>
            {current && (
              <button
                onClick={reset}
                disabled={saving}
                title="Reset to default"
                className="text-[12px] font-medium px-2 py-1.5 rounded-md disabled:opacity-50"
                style={{ background: 'var(--surface)', color: 'var(--muted)', border: '1px solid var(--border)' }}
              >
                <RotateCcw size={12} />
              </button>
            )}
          </div>
        )}
      </div>

      {editing && (
        <div className="mt-3">
          {err && (
            <div
              className="mb-2 px-3 py-2 text-[12px] rounded"
              style={{ background: 'rgba(147,0,10,0.2)', color: 'var(--error)' }}
            >
              {err}
            </div>
          )}
          <div className="flex gap-2 flex-wrap">
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as Provider)}
              className="h-9 px-2 text-[12px] rounded-md outline-none"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
            >
              <option value="anthropic">anthropic</option>
              <option value="openai">openai</option>
              <option value="openrouter">openrouter</option>
              <option value="ollama">ollama</option>
            </select>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="e.g. claude-sonnet-4-20250514"
              className="flex-1 min-w-[200px] h-9 px-3 text-[12px] rounded-md outline-none font-mono"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
            />
            <button
              onClick={save}
              disabled={saving}
              className="h-9 px-3 text-[12px] font-medium rounded-md disabled:opacity-50"
              style={{ background: 'var(--accent)', color: 'white' }}
            >
              {saving ? '...' : 'Save'}
            </button>
            <button
              onClick={() => { setEditing(false); setErr(''); }}
              className="h-9 px-3 text-[12px] font-medium rounded-md"
              style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const DEFAULT_EMBED_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_EMBED_MODEL = 'text-embedding-3-small';

function EmbedSection({ cfg, onSaved }: { cfg: AIConfig; onSaved: () => Promise<void> }) {
  const [provider, setProvider] = useState<EmbedProvider>(cfg.embed.provider);
  const [model, setModel] = useState<string>(cfg.embed.model || DEFAULT_EMBED_MODEL);
  const [baseUrl, setBaseUrl] = useState<string>(cfg.embed.base_url || DEFAULT_EMBED_BASE_URL);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const off = provider === 'off';

  const dirty =
    provider !== cfg.embed.provider ||
    model.trim() !== cfg.embed.model ||
    baseUrl.trim() !== cfg.embed.base_url;

  const save = async () => {
    setSaving(true);
    setErr('');
    try {
      const r = await api.put('/api/org/ai-config', {
        embed: {
          provider,
          model: model.trim() || null,
          base_url: baseUrl.trim() || null,
        },
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || 'Save failed');
      }
      await onSaved();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-4 rounded-lg" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
      <div className="flex items-start gap-3">
        <div
          className="w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0"
          style={{ background: 'var(--surface)', color: 'var(--foreground-secondary)' }}
        >
          <Database size={14} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[13px] font-medium" style={{ color: 'var(--foreground)' }}>Vector embeddings</p>
            {off ? (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded"
                style={{ background: 'var(--surface)', color: 'var(--muted)' }}
              >
                Disabled
              </span>
            ) : cfg.embed.has_key ? (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded inline-flex items-center gap-1"
                style={{ background: 'rgba(34,197,94,0.15)', color: 'var(--success, #22c55e)' }}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--success, #22c55e)' }} />
                OpenAI key available
              </span>
            ) : (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded inline-flex items-center gap-1"
                style={{ background: 'rgba(245,158,11,0.15)', color: 'var(--warning, #f59e0b)' }}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--warning, #f59e0b)' }} />
                No OpenAI key — set one above
              </span>
            )}
          </div>
          <p className="text-[12px] mt-0.5 leading-snug" style={{ color: 'var(--muted)' }}>
            Vectors are pinned to 1536 dimensions. Self-hosters can run an OpenAI-compatible server (LM Studio, vllm, llama.cpp) that emits matching dims.
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {err && (
          <div className="px-3 py-2 text-[12px] rounded" style={{ background: 'rgba(147,0,10,0.2)', color: 'var(--error)' }}>
            {err}
          </div>
        )}

        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wide block mb-1.5" style={{ color: 'var(--muted)' }}>
            Provider
          </label>
          <div
            className="inline-flex gap-1 p-1 rounded-md"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
          >
            {(['openai', 'off'] as const).map((opt) => {
              const active = provider === opt;
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setProvider(opt)}
                  className="px-3 h-7 text-[12px] font-medium rounded transition-colors"
                  style={{
                    background: active ? 'var(--card-bg)' : 'transparent',
                    color: active ? 'var(--foreground)' : 'var(--muted)',
                    boxShadow: active ? '0 1px 2px rgba(0,0,0,0.2)' : 'none',
                  }}
                >
                  {opt === 'openai' ? 'OpenAI' : 'Off'}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wide block mb-1.5" style={{ color: 'var(--muted)' }}>
            Model
          </label>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={DEFAULT_EMBED_MODEL}
            disabled={off}
            className="w-full h-9 px-3 text-[13px] rounded-md outline-none font-mono disabled:opacity-50"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
          />
        </div>

        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wide block mb-1.5" style={{ color: 'var(--muted)' }}>
            Base URL
          </label>
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={DEFAULT_EMBED_BASE_URL}
            disabled={off}
            className="w-full h-9 px-3 text-[13px] rounded-md outline-none font-mono disabled:opacity-50"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
          />
          <p className="text-[11px] mt-1 leading-snug" style={{ color: 'var(--muted)' }}>
            Point at any OpenAI-compatible server (LM Studio, vllm, llama.cpp server) for fully local embeddings.
          </p>
        </div>

        {off && (
          <p className="text-[11px] leading-snug" style={{ color: 'var(--muted)' }}>
            Vector search disabled — using keyword fallback for wiki, tasks, and decisions.
          </p>
        )}

        <div className="flex justify-end">
          <button
            onClick={save}
            disabled={saving || !dirty}
            className="h-9 px-3 flex items-center gap-1.5 text-[12px] font-medium rounded-md disabled:opacity-50"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            <Save size={12} />
            {saving ? '...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

const TRANSCRIPTION_OPTIONS: { id: TranscriptionProvider; label: string; helper: string }[] = [
  {
    id: 'local',
    label: 'Local (Whisper container)',
    helper: 'Sends audio to the Whisper container at WHISPER_URL (default http://localhost:9000). No external API calls.',
  },
  {
    id: 'openai',
    label: 'OpenAI Whisper',
    helper: "Uses OpenAI's Whisper API. Requires OPENAI_API_KEY at the env level (not org-scoped today).",
  },
  {
    id: 'deepgram',
    label: 'Deepgram',
    helper: 'Uses Deepgram nova-2. Requires DEEPGRAM_API_KEY at the env level.',
  },
];

function TranscriptionSection({ cfg, onSaved }: { cfg: AIConfig; onSaved: () => Promise<void> }) {
  const [provider, setProvider] = useState<TranscriptionProvider>(cfg.transcription.provider);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const dirty = provider !== cfg.transcription.provider;

  const save = async () => {
    setSaving(true);
    setErr('');
    try {
      const r = await api.put('/api/org/ai-config', { transcription: { provider } });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || 'Save failed');
      }
      await onSaved();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    setErr('');
    try {
      const r = await api.put('/api/org/ai-config', { transcription: { provider: null } });
      if (!r.ok) throw new Error('Reset failed');
      await onSaved();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-4 rounded-lg" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
      <div className="flex items-start gap-3">
        <div
          className="w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0"
          style={{ background: 'var(--surface)', color: 'var(--foreground-secondary)' }}
        >
          <Mic size={14} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[13px] font-medium" style={{ color: 'var(--foreground)' }}>Transcription provider</p>
            <span
              className="text-[10px] px-1.5 py-0.5 rounded font-mono"
              style={{ background: 'var(--surface)', color: 'var(--foreground-secondary)' }}
            >
              currently: {cfg.transcription.effective}
            </span>
          </div>
          <p className="text-[12px] mt-0.5 leading-snug" style={{ color: 'var(--muted)' }}>
            Pick the engine used for voice clips in chat. The org override wins; clear it to fall back to the env default.
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {err && (
          <div className="px-3 py-2 text-[12px] rounded" style={{ background: 'rgba(147,0,10,0.2)', color: 'var(--error)' }}>
            {err}
          </div>
        )}

        <div className="space-y-1.5">
          {TRANSCRIPTION_OPTIONS.map((opt) => {
            const active = provider === opt.id;
            return (
              <label
                key={opt.id}
                className="flex items-start gap-3 p-3 rounded-md cursor-pointer"
                style={{
                  background: active ? 'var(--surface)' : 'transparent',
                  border: '1px solid',
                  borderColor: active ? 'var(--accent)' : 'var(--border)',
                }}
              >
                <input
                  type="radio"
                  name="transcription-provider"
                  checked={active}
                  onChange={() => setProvider(opt.id)}
                  className="mt-0.5"
                  style={{ accentColor: 'var(--accent)' }}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium" style={{ color: 'var(--foreground)' }}>{opt.label}</p>
                  <p className="text-[11px] mt-0.5 leading-snug" style={{ color: 'var(--muted)' }}>{opt.helper}</p>
                </div>
              </label>
            );
          })}
        </div>

        <div className="flex justify-between items-center pt-1">
          <button
            type="button"
            onClick={reset}
            disabled={saving}
            className="text-[12px] inline-flex items-center gap-1 disabled:opacity-50"
            style={{ color: 'var(--muted)' }}
          >
            <RotateCcw size={11} />
            Reset to env default
          </button>
          <button
            onClick={save}
            disabled={saving || !dirty}
            className="h-9 px-3 flex items-center gap-1.5 text-[12px] font-medium rounded-md disabled:opacity-50"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            <Save size={12} />
            {saving ? '...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
