'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Sparkles, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

const DISMISS_KEY = 'deft-ai-banner-dismissed';

export function AIProviderBanner() {
  const { user } = useAuth();
  const [banner, setBanner] = useState<{ title: string; body: string } | null>(null);

  const isAdmin = user?.role === 'owner' || user?.role === 'admin';

  useEffect(() => {
    if (!isAdmin) return;
    if (typeof window !== 'undefined' && sessionStorage.getItem(DISMISS_KEY) === '1') return;
    let cancelled = false;
    api.get('/api/org/ai-config').then(async (r) => {
      if (cancelled) return;
      if (!r.ok) return;
      const data = await r.json();
      if (!data?.has_provider) {
        setBanner({
          title: 'AI features are off',
          body: 'Add a provider key to unlock Defty, summaries, classification, and more.',
        });
      } else if (!data?.has_reason_provider) {
        setBanner({
          title: 'Defty needs a reasoning model',
          body: data?.reason_provider?.reason || 'Configure a usable reasoning provider so Defty can answer and plan work.',
        });
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isAdmin]);

  if (!banner) return null;

  const dismiss = () => {
    if (typeof window !== 'undefined') sessionStorage.setItem(DISMISS_KEY, '1');
    setBanner(null);
  };

  return (
    <div
      className="flex items-center gap-3 px-4 py-3 mb-4 rounded-lg"
      style={{
        background: 'var(--surface-container-low)',
        border: '1px solid var(--outline-variant)',
      }}
    >
      <div
        className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
        style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}
      >
        <Sparkles size={14} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium" style={{ color: 'var(--on-surface)' }}>
          {banner.title}
        </p>
        <p className="text-[12px] leading-snug" style={{ color: 'var(--on-surface-variant)' }}>
          {banner.body}
        </p>
      </div>
      <Link
        href="/settings/ai"
        className="text-[12px] font-medium px-3 py-1.5 rounded-md flex-shrink-0"
        style={{ background: 'var(--accent)', color: 'white' }}
      >
        Configure
      </Link>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="p-1 rounded flex-shrink-0"
        style={{ color: 'var(--on-surface-variant)' }}
      >
        <X size={14} />
      </button>
    </div>
  );
}
