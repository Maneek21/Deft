'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { Logo } from '@/components/brand/logo';
import { Sparkles, MessageSquare, ListChecks, Users, ArrowRight, Check } from 'lucide-react';

type StepKey = 'welcome' | 'profile' | 'tour' | 'agent' | 'first_message';

const STEP_ORDER: StepKey[] = ['welcome', 'profile', 'tour', 'agent', 'first_message'];

export default function WelcomePage() {
  const { user, org, refreshUser } = useAuth();
  const router = useRouter();
  const [stepIdx, setStepIdx] = useState(0);
  const [name, setName] = useState(user?.name ?? '');
  const [timezone, setTimezone] = useState((user as { timezone?: string | null } | null)?.timezone ?? '');
  const [savingProfile, setSavingProfile] = useState(false);
  const [firstMessage, setFirstMessage] = useState('Hi team — happy to be here!');
  const [posting, setPosting] = useState(false);

  // Redirect to login if no auth, dashboard if already done
  useEffect(() => {
    if (!user) return;
    if (!name) setName(user.name);
    api.get('/api/auth/onboarding').then(async (r) => {
      if (!r.ok) return;
      const state = await r.json();
      if (state?.completed) router.replace('/dashboard');
    });
  }, [user, router]); // eslint-disable-line react-hooks/exhaustive-deps

  const step = STEP_ORDER[stepIdx]!;

  const advance = () => setStepIdx((i) => Math.min(i + 1, STEP_ORDER.length - 1));

  const finish = async () => {
    await api.patch('/api/auth/onboarding', { completed: true }).catch(() => {});
    router.push('/dashboard');
  };

  const skip = async () => {
    await api.patch('/api/auth/onboarding', { completed: true }).catch(() => {});
    router.push('/dashboard');
  };

  const saveProfile = async () => {
    setSavingProfile(true);
    const detected = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    await api.patch('/api/auth/me', { name, timezone: detected }).catch(() => {});
    await api.patch('/api/auth/onboarding', { profile_set: true }).catch(() => {});
    await refreshUser().catch(() => {});
    setSavingProfile(false);
    advance();
  };

  const postFirstMessage = async () => {
    if (!firstMessage.trim()) {
      advance();
      return;
    }
    setPosting(true);
    try {
      const spacesRes = await api.get('/api/spaces');
      if (spacesRes.ok) {
        const spaces: { id: string; is_default: boolean; name: string }[] = await spacesRes.json();
        const target = spaces.find((s) => s.is_default) ?? spaces.find((s) => s.name === 'general') ?? spaces[0];
        if (target) {
          await api.post(`/api/spaces/${target.id}/messages`, { content: firstMessage }).catch(() => {});
          await api.patch('/api/auth/onboarding', { first_message_sent: true }).catch(() => {});
        }
      }
    } finally {
      setPosting(false);
      finish();
    }
  };

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--surface-lowest)' }}>
        <Logo variant="icon" className="h-9 w-auto" />
      </div>
    );
  }

  const orgName = org?.name ?? 'your workspace';

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden" style={{ background: 'var(--surface-lowest)' }}>
      <div className="fixed top-0 left-1/4 w-[500px] h-[500px] rounded-full pointer-events-none -z-10"
        style={{ background: 'var(--accent-muted)', filter: 'blur(120px)', opacity: 0.3 }} />
      <div className="fixed bottom-0 right-1/4 w-[600px] h-[600px] rounded-full pointer-events-none -z-10"
        style={{ background: 'var(--accent-muted)', filter: 'blur(140px)', opacity: 0.2 }} />

      <main className="w-full max-w-[520px] flex flex-col items-center gap-6">
        <Logo variant="wordmark" className="h-10 w-auto" priority />

        {/* Progress dots */}
        <div className="flex items-center gap-2">
          {STEP_ORDER.map((_, i) => (
            <div
              key={i}
              className="h-1.5 rounded-full transition-all"
              style={{
                width: i === stepIdx ? '24px' : '8px',
                background: i <= stepIdx ? 'var(--primary)' : 'var(--ghost-border)',
              }}
            />
          ))}
        </div>

        <div className="w-full p-8 flex flex-col gap-5"
          style={{
            background: 'var(--surface-dim)',
            borderRadius: '0.75rem',
            boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
            outline: '1px solid var(--ghost-border)',
          }}>

          {step === 'welcome' && (
            <>
              <div className="flex flex-col gap-3">
                <h1 className="text-[1.5rem] font-semibold leading-tight" style={{ color: 'var(--on-surface)' }}>
                  Welcome to {orgName}, {user.name.split(' ')[0]}
                </h1>
                <p className="text-[0.9375rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
                  Deft is the team workspace where chat, tasks, and your AI agent live in one place. We'll walk you through it in under a minute.
                </p>
              </div>
              <FeatureRow icon={<MessageSquare size={16} />} title="Talk in spaces" body="Team channels and DMs. Your team is here." />
              <FeatureRow icon={<ListChecks size={16} />} title="Track tasks" body="Kanban, list, calendar — pick the view, the data follows." />
              <FeatureRow icon={<Sparkles size={16} />} title="Defty, your built-in agent" body="@deft anywhere to ask questions or kick off work." />
              <button onClick={advance} className="self-end mt-2 h-10 px-5 flex items-center gap-2 text-[0.875rem] font-semibold"
                style={{ background: 'var(--primary-container)', color: '#FFFFFF', borderRadius: '0.5rem' }}>
                Let's go <ArrowRight size={14} />
              </button>
            </>
          )}

          {step === 'profile' && (
            <>
              <div className="flex flex-col gap-1.5">
                <h2 className="text-[1.25rem] font-semibold leading-tight" style={{ color: 'var(--on-surface)' }}>Make it yours</h2>
                <p className="text-[0.875rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
                  Confirm your display name and time zone — these show up on messages and tasks.
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-[0.6875rem] font-semibold uppercase" style={{ color: 'var(--on-surface-variant)', letterSpacing: '0.05em' }}>Display name</label>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)}
                  className="w-full h-11 px-4 text-[0.875rem] outline-none"
                  style={{ background: 'var(--surface-container-low)', border: '1px solid var(--outline-variant)', borderRadius: '0.5rem', color: 'var(--on-surface)' }} />
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-[0.6875rem] font-semibold uppercase" style={{ color: 'var(--on-surface-variant)', letterSpacing: '0.05em' }}>Time zone</label>
                <input type="text"
                  value={timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || ''}
                  onChange={(e) => setTimezone(e.target.value)}
                  placeholder="America/Los_Angeles"
                  className="w-full h-11 px-4 text-[0.875rem] outline-none font-mono"
                  style={{ background: 'var(--surface-container-low)', border: '1px solid var(--outline-variant)', borderRadius: '0.5rem', color: 'var(--on-surface)' }} />
                <p className="text-[0.75rem]" style={{ color: 'var(--on-surface-variant)' }}>
                  We auto-detect this from your browser. Leave it as-is unless it's wrong.
                </p>
              </div>

              <div className="flex justify-between mt-2">
                <button onClick={skip} className="text-[0.8125rem]" style={{ color: 'var(--on-surface-variant)' }}>Skip onboarding</button>
                <button onClick={saveProfile} disabled={savingProfile}
                  className="h-10 px-5 flex items-center gap-2 text-[0.875rem] font-semibold disabled:opacity-50"
                  style={{ background: 'var(--primary-container)', color: '#FFFFFF', borderRadius: '0.5rem' }}>
                  {savingProfile ? 'Saving…' : <>Save and continue <ArrowRight size={14} /></>}
                </button>
              </div>
            </>
          )}

          {step === 'tour' && (
            <>
              <div className="flex flex-col gap-1.5">
                <h2 className="text-[1.25rem] font-semibold leading-tight" style={{ color: 'var(--on-surface)' }}>How Deft is laid out</h2>
                <p className="text-[0.875rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
                  Three surfaces and one sidebar. The sidebar is where you live; everything else opens from there.
                </p>
              </div>
              <FeatureRow icon={<MessageSquare size={16} />} title="Chat" body="Public spaces, private spaces, and DMs. Threads keep the noise low." />
              <FeatureRow icon={<ListChecks size={16} />} title="Tasks" body="Every project has a board. Tasks can be created from chat with @deft create task." />
              <FeatureRow icon={<Users size={16} />} title="Knowledge" body="A wiki, decisions log, and notes. Defty pulls from these to answer questions." />
              <p className="text-[0.8125rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
                Use <kbd style={{ background: 'var(--surface-container-low)', padding: '1px 6px', borderRadius: '4px', fontSize: '0.75rem' }}>Cmd/Ctrl + K</kbd> to jump anywhere.
              </p>
              <div className="flex justify-between mt-2">
                <button onClick={skip} className="text-[0.8125rem]" style={{ color: 'var(--on-surface-variant)' }}>Skip onboarding</button>
                <button onClick={advance} className="h-10 px-5 flex items-center gap-2 text-[0.875rem] font-semibold"
                  style={{ background: 'var(--primary-container)', color: '#FFFFFF', borderRadius: '0.5rem' }}>
                  Continue <ArrowRight size={14} />
                </button>
              </div>
            </>
          )}

          {step === 'agent' && (
            <>
              <div className="flex flex-col gap-1.5">
                <h2 className="text-[1.25rem] font-semibold leading-tight" style={{ color: 'var(--on-surface)' }}>Meet Defty</h2>
                <p className="text-[0.875rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
                  Defty is the agent built into your workspace. It reads your team's data directly — chat, tasks, decisions, the wiki — and can take action on your behalf.
                </p>
              </div>
              <div className="p-4 rounded-lg" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--outline-variant)' }}>
                <p className="text-[0.8125rem] mb-2 font-semibold" style={{ color: 'var(--on-surface)' }}>Try Defty by:</p>
                <ul className="text-[0.8125rem] leading-relaxed space-y-1.5" style={{ color: 'var(--on-surface-variant)' }}>
                  <li>• Mentioning <code style={{ color: 'var(--on-surface)' }}>@deft</code> in any space</li>
                  <li>• Asking it to summarize a thread or draft a task</li>
                  <li>• Letting it nudge stalled tasks for you</li>
                </ul>
              </div>
              <p className="text-[0.75rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
                Defty's autonomy level is set per workspace by your admin — by default it asks before doing anything outside chat.
              </p>
              <div className="flex justify-between mt-2">
                <button onClick={skip} className="text-[0.8125rem]" style={{ color: 'var(--on-surface-variant)' }}>Skip onboarding</button>
                <button
                  onClick={() => { api.patch('/api/auth/onboarding', { agent_tried: true }).catch(() => {}); advance(); }}
                  className="h-10 px-5 flex items-center gap-2 text-[0.875rem] font-semibold"
                  style={{ background: 'var(--primary-container)', color: '#FFFFFF', borderRadius: '0.5rem' }}>
                  Got it <ArrowRight size={14} />
                </button>
              </div>
            </>
          )}

          {step === 'first_message' && (
            <>
              <div className="flex flex-col gap-1.5">
                <h2 className="text-[1.25rem] font-semibold leading-tight" style={{ color: 'var(--on-surface)' }}>Say hello in #general</h2>
                <p className="text-[0.875rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
                  Post a quick intro so your team knows you're here. You can always edit or delete it later.
                </p>
              </div>
              <textarea
                value={firstMessage}
                onChange={(e) => setFirstMessage(e.target.value)}
                rows={3}
                className="w-full px-4 py-3 text-[0.875rem] outline-none resize-none"
                style={{ background: 'var(--surface-container-low)', border: '1px solid var(--outline-variant)', borderRadius: '0.5rem', color: 'var(--on-surface)' }}
                placeholder="Hi team — excited to be here!"
              />
              <div className="flex justify-between mt-2">
                <button onClick={finish} className="text-[0.8125rem]" style={{ color: 'var(--on-surface-variant)' }}>Skip — finish onboarding</button>
                <button onClick={postFirstMessage} disabled={posting}
                  className="h-10 px-5 flex items-center gap-2 text-[0.875rem] font-semibold disabled:opacity-50"
                  style={{ background: 'var(--primary-container)', color: '#FFFFFF', borderRadius: '0.5rem' }}>
                  {posting ? 'Posting…' : <>Post and finish <Check size={14} /></>}
                </button>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function FeatureRow({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{ background: 'var(--surface-container-low)', color: 'var(--primary)' }}>
        {icon}
      </div>
      <div className="flex-1">
        <p className="text-[0.875rem] font-semibold leading-tight" style={{ color: 'var(--on-surface)' }}>{title}</p>
        <p className="text-[0.8125rem] leading-relaxed mt-0.5" style={{ color: 'var(--on-surface-variant)' }}>{body}</p>
      </div>
    </div>
  );
}
