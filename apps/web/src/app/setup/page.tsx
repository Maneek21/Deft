'use client';

import { useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { useRouter } from 'next/navigation';

const STEPS = ['Welcome', 'Invite Team', 'Create Spaces', 'Create Project', 'Meet Deft'];

export default function SetupPage() {
  const { user, org } = useAuth();
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [orgName, setOrgName] = useState(org?.name || '');
  const [emails, setEmails] = useState('');
  const [selectedSpaces, setSelectedSpaces] = useState(['general', 'engineering', 'random']);
  const [projectName, setProjectName] = useState('');
  const [projectPrefix, setProjectPrefix] = useState('');
  const [loading, setLoading] = useState(false);

  const next = () => setStep(s => Math.min(s + 1, STEPS.length - 1));
  const skip = () => {
    if (step === STEPS.length - 1) {
      router.push('/dashboard');
    } else {
      next();
    }
  };

  const handleCreateSpaces = async () => {
    setLoading(true);
    for (const name of selectedSpaces) {
      await api.post('/api/spaces', { name, type: 'public' }).catch(() => {});
    }
    setLoading(false);
    next();
  };

  const handleCreateProject = async () => {
    if (!projectName.trim()) { next(); return; }
    setLoading(true);
    const prefix = projectPrefix || projectName.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 4);
    await api.post('/api/projects', { name: projectName, prefix }).catch(() => {});
    setLoading(false);
    next();
  };

  const finish = () => {
    // Mark onboarding complete
    api.patch('/api/auth/me', { onboarding_completed: true }).catch(() => {});
    router.push('/dashboard');
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'var(--surface-lowest)' }}>
      {/* Backdrop gradients */}
      <div className="fixed top-0 left-1/4 w-[500px] h-[500px] rounded-full pointer-events-none -z-10"
        style={{ background: 'rgba(144,128,250,0.04)', filter: 'blur(120px)' }} />

      <div className="w-full max-w-[480px]">
        {/* Progress dots */}
        <div className="flex justify-center gap-2 mb-8">
          {STEPS.map((_, i) => (
            <div key={i} className="w-2 h-2 rounded-full"
              style={{ background: i <= step ? 'var(--primary-container)' : 'var(--surface-container-highest)' }} />
          ))}
        </div>

        {/* Step content */}
        <div className="p-8" style={{
          background: 'var(--surface-dim)',
          borderRadius: '0.75rem',
          boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
          outline: '1px solid var(--ghost-border)',
        }}>
          {step === 0 && (
            <div className="text-center">
              <div className="w-12 h-12 mx-auto mb-4 flex items-center justify-center rounded-xl"
                style={{ background: 'var(--surface-container-low)' }}>
                <div className="flex flex-col items-center">
                  <div className="w-4 h-2 rounded-full" style={{ background: 'var(--primary)', opacity: 0.6 }} />
                  <div className="w-6 h-2 rounded-full -mt-0.5" style={{ background: 'var(--primary)', opacity: 0.8 }} />
                  <div className="w-8 h-2.5 rounded-full -mt-0.5" style={{ background: 'var(--primary-container)' }} />
                </div>
              </div>
              <h2 className="text-[1.25rem] font-semibold mb-1" style={{ color: 'var(--on-surface)' }}>Welcome to Deft</h2>
              <p className="text-[0.875rem] mb-6" style={{ color: 'var(--on-surface-variant)' }}>Let&apos;s set up your workspace</p>

              <div className="text-left mb-6">
                <label className="text-[0.6875rem] font-semibold uppercase block mb-2"
                  style={{ color: 'var(--on-surface-variant)', letterSpacing: '0.05em' }}>Workspace Name</label>
                <input value={orgName} onChange={e => setOrgName(e.target.value)}
                  className="w-full h-11 px-4 text-[0.875rem] outline-none"
                  style={{ background: 'var(--surface-container-high)', border: '1px solid var(--outline-variant)', borderRadius: '0.5rem', color: 'var(--on-surface)' }} />
              </div>
              <button onClick={next} className="w-full h-11 font-semibold text-[0.875rem] text-white"
                style={{ background: 'var(--primary-container)', borderRadius: '0.5rem' }}>Continue</button>
            </div>
          )}

          {step === 1 && (
            <div>
              <h2 className="text-[1.125rem] font-semibold mb-1" style={{ color: 'var(--on-surface)' }}>Invite your team</h2>
              <p className="text-[0.8125rem] mb-4" style={{ color: 'var(--on-surface-variant)' }}>Add teammates by email</p>
              <textarea value={emails} onChange={e => setEmails(e.target.value)}
                placeholder="name@company.com, another@company.com"
                className="w-full h-24 px-4 py-3 text-[0.875rem] outline-none resize-none mb-4"
                style={{ background: 'var(--surface-container-high)', border: '1px solid var(--outline-variant)', borderRadius: '0.5rem', color: 'var(--on-surface)' }} />
              <div className="flex gap-3">
                <button onClick={next} className="flex-1 h-10 font-semibold text-[0.8125rem] text-white"
                  style={{ background: 'var(--primary-container)', borderRadius: '0.5rem' }}>Send Invites</button>
                <button onClick={skip} className="px-4 h-10 text-[0.8125rem]"
                  style={{ color: 'var(--outline)' }}>Skip</button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <h2 className="text-[1.125rem] font-semibold mb-1" style={{ color: 'var(--on-surface)' }}>Create spaces</h2>
              <p className="text-[0.8125rem] mb-4" style={{ color: 'var(--on-surface-variant)' }}>Spaces are where your team communicates</p>
              <div className="space-y-2 mb-4">
                {['general', 'engineering', 'design', 'random'].map(name => (
                  <label key={name} className="flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer"
                    style={{ background: selectedSpaces.includes(name) ? 'rgba(144,128,250,0.1)' : 'var(--surface-container)' }}>
                    <input type="checkbox" checked={selectedSpaces.includes(name)}
                      onChange={e => setSelectedSpaces(prev => e.target.checked ? [...prev, name] : prev.filter(s => s !== name))}
                      className="w-4 h-4" />
                    <span className="text-[0.875rem]" style={{ color: 'var(--on-surface)' }}># {name}</span>
                  </label>
                ))}
              </div>
              <div className="flex gap-3">
                <button onClick={handleCreateSpaces} disabled={loading}
                  className="flex-1 h-10 font-semibold text-[0.8125rem] text-white disabled:opacity-50"
                  style={{ background: 'var(--primary-container)', borderRadius: '0.5rem' }}>
                  {loading ? 'Creating...' : 'Create Spaces'}
                </button>
                <button onClick={skip} className="px-4 h-10 text-[0.8125rem]" style={{ color: 'var(--outline)' }}>Skip</button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <h2 className="text-[1.125rem] font-semibold mb-1" style={{ color: 'var(--on-surface)' }}>Create a project</h2>
              <p className="text-[0.8125rem] mb-4" style={{ color: 'var(--on-surface-variant)' }}>Projects organize your tasks</p>
              <div className="space-y-3 mb-4">
                <input value={projectName} onChange={e => { setProjectName(e.target.value); setProjectPrefix(e.target.value.split(/\s+/).map(w=>w[0]||'').join('').toUpperCase().slice(0,4)); }}
                  placeholder="Project name"
                  className="w-full h-11 px-4 text-[0.875rem] outline-none"
                  style={{ background: 'var(--surface-container-high)', border: '1px solid var(--outline-variant)', borderRadius: '0.5rem', color: 'var(--on-surface)' }} />
                <input value={projectPrefix} onChange={e => setProjectPrefix(e.target.value.toUpperCase())}
                  placeholder="PREFIX" maxLength={6}
                  className="w-full h-11 px-4 text-[0.875rem] outline-none uppercase"
                  style={{ background: 'var(--surface-container-high)', border: '1px solid var(--outline-variant)', borderRadius: '0.5rem', color: 'var(--on-surface)', fontFamily: 'var(--font-mono)' }} />
              </div>
              <div className="flex gap-3">
                <button onClick={handleCreateProject} disabled={loading}
                  className="flex-1 h-10 font-semibold text-[0.8125rem] text-white disabled:opacity-50"
                  style={{ background: 'var(--primary-container)', borderRadius: '0.5rem' }}>
                  {loading ? 'Creating...' : 'Create Project'}
                </button>
                <button onClick={skip} className="px-4 h-10 text-[0.8125rem]" style={{ color: 'var(--outline)' }}>Skip</button>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="text-center">
              <div className="w-16 h-16 mx-auto mb-4 flex items-center justify-center rounded-xl"
                style={{ background: 'rgba(144,128,250,0.15)' }}>
                <span className="text-2xl" style={{ color: 'var(--primary-container)' }}>&#x25C7;</span>
              </div>
              <h2 className="text-[1.125rem] font-semibold mb-1" style={{ color: 'var(--on-surface)' }}>Meet Deft AI</h2>
              <p className="text-[0.8125rem] mb-6" style={{ color: 'var(--on-surface-variant)' }}>
                Your AI assistant can answer questions, create tasks, summarize conversations, and help you stay organized.
              </p>
              <div className="flex gap-3">
                <button onClick={() => router.push('/chat')}
                  className="flex-1 h-10 font-semibold text-[0.8125rem] text-white"
                  style={{ background: 'var(--primary-container)', borderRadius: '0.5rem' }}>
                  Try Deft AI
                </button>
                <button onClick={finish} className="flex-1 h-10 font-semibold text-[0.8125rem]"
                  style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface)', borderRadius: '0.5rem' }}>
                  Go to Dashboard
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
