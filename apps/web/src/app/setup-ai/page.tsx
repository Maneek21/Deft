'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowRight, Eye, EyeOff, Loader2, Sparkles } from 'lucide-react';
import { Logo } from '@/components/brand/logo';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

type Provider = 'anthropic' | 'openai' | 'openrouter' | 'ollama';

const TABS: { id: Provider; label: string; placeholder: string; blurb: string; isUrl?: boolean }[] = [
  { id: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-…', blurb: 'Claude — recommended. Get a key at console.anthropic.com.' },
  { id: 'openai', label: 'OpenAI', placeholder: 'sk-…', blurb: 'GPT-4 family. Get a key at platform.openai.com.' },
  { id: 'openrouter', label: 'OpenRouter', placeholder: 'sk-or-…', blurb: 'One key, many models. Get a key at openrouter.ai.' },
  { id: 'ollama', label: 'Ollama', placeholder: 'http://localhost:11434', blurb: 'Run open-source models on your own machine.', isUrl: true },
];

export default function SetupAIPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [tab, setTab] = useState<Provider>('anthropic');
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [bootstrapped, setBootstrapped] = useState(false);
  const [hasEnvFallback, setHasEnvFallback] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.replace('/login');
      return;
    }
    api.get('/api/org/ai-config').then(async (r) => {
      if (!r.ok) { setBootstrapped(true); return; }
      const data = await r.json();
      // Org-configured provider already exists — no reason to be here.
      const hasOrgKey = Object.values(data.api_keys ?? {}).some((k: any) => k?.configured);
      if (hasOrgKey) {
        router.replace('/dashboard');
        return;
      }
      setHasEnvFallback(Boolean(data.has_provider));
      setBootstrapped(true);
    }).catch(() => setBootstrapped(true));
  }, [authLoading, user, router]);

  const active = TABS.find((t) => t.id === tab)!;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (!value.trim()) {
      setErr('Enter a value to continue, or pick "Skip for now".');
      return;
    }
    setSaving(true);
    try {
      const body = active.isUrl ? { ollama_url: value.trim() } : { api_keys: { [tab]: value.trim() } };
      const r = await api.put('/api/org/ai-config', body);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || 'Save failed');
      }
      router.push('/dashboard');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (authLoading || !bootstrapped) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--surface-lowest)' }}>
        <Loader2 size={20} className="animate-spin" style={{ color: 'var(--on-surface-variant)' }} />
      </div>
    );
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden"
      style={{ background: 'var(--surface-lowest)' }}
    >
      <div
        className="fixed top-0 left-1/4 w-[500px] h-[500px] rounded-full pointer-events-none -z-10"
        style={{ background: 'var(--accent-muted)', filter: 'blur(120px)', opacity: 0.3 }}
      />
      <div
        className="fixed bottom-0 right-1/4 w-[600px] h-[600px] rounded-full pointer-events-none -z-10"
        style={{ background: 'var(--accent-muted)', filter: 'blur(140px)', opacity: 0.2 }}
      />

      <main className="w-full max-w-[520px] flex flex-col items-center gap-6">
        <Logo variant="wordmark" className="h-10 w-auto" priority />

        <div
          className="w-full p-8 flex flex-col gap-5"
          style={{
            background: 'var(--surface-dim)',
            borderRadius: '0.75rem',
            boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
            outline: '1px solid var(--ghost-border)',
          }}
        >
          <div className="flex items-start gap-3">
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ background: 'var(--surface-container-low)', color: 'var(--primary)' }}
            >
              <Sparkles size={16} />
            </div>
            <div className="flex flex-col gap-1.5">
              <h1 className="text-[1.25rem] font-semibold leading-tight" style={{ color: 'var(--on-surface)' }}>
                {hasEnvFallback ? 'AI is already on' : 'Bring your own AI key'}
              </h1>
              <p className="text-[0.875rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
                {hasEnvFallback
                  ? 'This Deft instance has a shared AI key configured at the server level, so the agent and AI features will work out of the box. You can still add a per-workspace key from Settings to override it.'
                  : 'Deft uses your own provider key — that means full control over your data, your bills, and which model handles what. Drop in one key now and the agent comes online immediately.'}
              </p>
            </div>
          </div>

          {hasEnvFallback ? (
            <div className="flex justify-end mt-2">
              <button
                onClick={() => router.push('/dashboard')}
                className="h-10 px-5 flex items-center gap-2 text-[0.875rem] font-semibold"
                style={{ background: 'var(--primary-container)', color: '#FFFFFF', borderRadius: '0.5rem' }}
              >
                Continue <ArrowRight size={14} />
              </button>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="flex flex-col gap-4">
              <div
                className="flex gap-1 p-1 rounded-lg"
                style={{ background: 'var(--surface-container-low)', border: '1px solid var(--outline-variant)' }}
              >
                {TABS.map((t) => {
                  const isActive = t.id === tab;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => { setTab(t.id); setValue(''); setErr(''); }}
                      className="flex-1 h-8 text-[0.75rem] font-medium rounded-md transition-colors"
                      style={{
                        background: isActive ? 'var(--surface-dim)' : 'transparent',
                        color: isActive ? 'var(--on-surface)' : 'var(--on-surface-variant)',
                        boxShadow: isActive ? '0 1px 2px rgba(0,0,0,0.2)' : 'none',
                      }}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>

              <p className="text-[0.8125rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
                {active.blurb}
              </p>

              {err && (
                <div
                  className="px-3 py-2 text-[0.8125rem] rounded-md"
                  style={{ background: 'rgba(147,0,10,0.2)', color: 'var(--error)' }}
                >
                  {err}
                </div>
              )}

              <div className="flex flex-col gap-2">
                <label
                  className="text-[0.6875rem] font-semibold uppercase"
                  style={{ color: 'var(--on-surface-variant)', letterSpacing: '0.05em' }}
                >
                  {active.isUrl ? 'Server URL' : 'API key'}
                </label>
                <div className="relative">
                  <input
                    type={reveal || active.isUrl ? 'text' : 'password'}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder={active.placeholder}
                    autoFocus
                    className="w-full h-11 px-4 pr-10 text-[0.875rem] outline-none font-mono"
                    style={{
                      background: 'var(--surface-container-low)',
                      border: '1px solid var(--outline-variant)',
                      borderRadius: '0.5rem',
                      color: 'var(--on-surface)',
                    }}
                  />
                  {!active.isUrl && (
                    <button
                      type="button"
                      onClick={() => setReveal((r) => !r)}
                      aria-label={reveal ? 'Hide' : 'Reveal'}
                      className="absolute right-3 top-1/2 -translate-y-1/2 p-1"
                      style={{ color: 'var(--on-surface-variant)' }}
                    >
                      {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  )}
                </div>
                <p className="text-[0.75rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
                  Stored encrypted in this workspace only. We never log keys, never send them anywhere except the chosen provider.
                </p>
              </div>

              <div className="flex justify-between items-center mt-2">
                <Link
                  href="/dashboard"
                  className="text-[0.8125rem]"
                  style={{ color: 'var(--on-surface-variant)' }}
                >
                  Skip for now
                </Link>
                <button
                  type="submit"
                  disabled={saving}
                  className="h-10 px-5 flex items-center gap-2 text-[0.875rem] font-semibold disabled:opacity-50"
                  style={{ background: 'var(--primary-container)', color: '#FFFFFF', borderRadius: '0.5rem' }}
                >
                  {saving ? 'Saving…' : <>Save and continue <ArrowRight size={14} /></>}
                </button>
              </div>

              <p className="text-[0.75rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
                You can add or change this later from Settings → AI.
              </p>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
