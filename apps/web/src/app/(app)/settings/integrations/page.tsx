'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { useSearchParams } from 'next/navigation';

type Connection = {
  id: string;
  provider: string;
  status: 'connected' | 'error' | 'expired';
  last_sync_at: string | null;
  sync_error: string | null;
  created_at: string;
};

const PROVIDERS = [
  {
    id: 'google_calendar',
    name: 'Google Calendar',
    description: 'Sync your calendar events. See your schedule on the dashboard and let Deft prepare you for meetings.',
    icon: '📅',
    available: true,
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Link pull requests to tasks. Auto-complete tasks when PRs merge. Track what shipped.',
    icon: '🐙',
    available: true,
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Bridge messages between Slack channels and Deft spaces. Coming soon.',
    icon: '💬',
    available: false,
  },
  {
    id: 'gmail',
    name: 'Gmail',
    description: 'Create tasks from emails. Get email summaries from Deft. Coming soon.',
    icon: '📧',
    available: false,
  },
];

export default function IntegrationsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState<string | null>(null);
  const searchParams = useSearchParams();

  useEffect(() => {
    loadConnections();
  }, []);

  const loadConnections = async () => {
    try {
      const res = await api.get('/api/connections');
      if (res.ok) setConnections(await res.json());
    } catch {}
    setLoading(false);
  };

  // Show success/error toast from OAuth callback redirect
  const connectedProvider = searchParams.get('connected');
  const errorProvider = searchParams.get('error');

  const handleConnect = async (provider: string) => {
    setConnecting(provider);
    try {
      const res = await api.post(`/api/connections/${provider}/connect`);
      if (res.ok) {
        const data = await res.json();
        if (data.url) {
          window.location.href = data.url; // Redirect to OAuth
        } else if (data.code === 'NOT_CONFIGURED') {
          alert(`${provider} is not configured. Add credentials to .env`);
        }
      }
    } catch {}
    setConnecting(null);
  };

  const handleDisconnect = async (provider: string) => {
    if (!confirm('Disconnect this service? Synced data will be removed.')) return;
    await api.delete(`/api/connections/${provider}`);
    setConnections(prev => prev.filter(c => c.provider !== provider));
  };

  const getConnection = (providerId: string) => connections.find(c => c.provider === providerId);

  const relativeTime = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  return (
    <div className="p-6 max-w-[640px]">
      <h2 className="text-[1.125rem] font-semibold mb-1" style={{ color: 'var(--on-surface)' }}>
        Integrations
      </h2>
      <p className="text-[0.8125rem] mb-6" style={{ color: 'var(--outline)' }}>
        Connect external tools to your workspace. Deft's AI agent will use these connections to answer questions and take actions.
      </p>

      {/* Success/error banners from OAuth redirect */}
      {connectedProvider && (
        <div className="mb-4 px-4 py-3 rounded-lg text-[0.8125rem]"
          style={{ background: 'rgba(48,164,108,0.1)', color: 'var(--status-green)' }}>
          ✓ Successfully connected {PROVIDERS.find(p => p.id === connectedProvider)?.name || connectedProvider}
        </div>
      )}
      {errorProvider && (
        <div className="mb-4 px-4 py-3 rounded-lg text-[0.8125rem]"
          style={{ background: 'rgba(229,72,77,0.1)', color: 'var(--status-red)' }}>
          Failed to connect {PROVIDERS.find(p => p.id === errorProvider)?.name || errorProvider}. Please try again.
        </div>
      )}

      <div className="space-y-3">
        {PROVIDERS.map(provider => {
          const conn = getConnection(provider.id);
          const isConnected = conn?.status === 'connected';
          const hasError = conn?.status === 'error';
          const isExpired = conn?.status === 'expired';

          return (
            <div key={provider.id} className="flex items-start gap-4 p-4 rounded-lg"
              style={{ background: 'var(--surface-container)' }}>
              {/* Icon */}
              <span className="text-2xl flex-shrink-0 mt-0.5">{provider.icon}</span>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[0.875rem] font-medium" style={{ color: 'var(--on-surface)' }}>
                    {provider.name}
                  </span>
                  {isConnected && (
                    <span className="flex items-center gap-1 text-[0.6875rem]" style={{ color: 'var(--status-green)' }}>
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--status-green)' }} />
                      Connected
                    </span>
                  )}
                  {hasError && (
                    <span className="flex items-center gap-1 text-[0.6875rem]" style={{ color: 'var(--status-red)' }}>
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--status-red)' }} />
                      Error
                    </span>
                  )}
                  {isExpired && (
                    <span className="flex items-center gap-1 text-[0.6875rem]" style={{ color: 'var(--status-amber)' }}>
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--status-amber)' }} />
                      Expired
                    </span>
                  )}
                  {!provider.available && !conn && (
                    <span className="text-[0.6875rem]" style={{ color: 'var(--outline)' }}>Coming soon</span>
                  )}
                </div>
                <p className="text-[0.75rem] mt-0.5" style={{ color: 'var(--outline)' }}>
                  {provider.description}
                </p>
                {conn?.last_sync_at && (
                  <p className="text-[0.6875rem] mt-1" style={{ color: 'var(--outline)', fontFamily: 'var(--font-mono)' }}>
                    Last synced {relativeTime(conn.last_sync_at)}
                  </p>
                )}
                {conn?.sync_error && (
                  <p className="text-[0.6875rem] mt-1" style={{ color: 'var(--status-red)' }}>
                    {conn.sync_error}
                  </p>
                )}
              </div>

              {/* Action */}
              <div className="flex-shrink-0">
                {conn ? (
                  <button
                    onClick={() => hasError || isExpired ? handleConnect(provider.id) : handleDisconnect(provider.id)}
                    className="px-3 py-1.5 text-[0.75rem] font-medium rounded-md"
                    style={{
                      background: hasError || isExpired ? 'var(--primary-container)' : 'var(--surface-container-high)',
                      color: hasError || isExpired ? '#fff' : 'var(--on-surface-variant)',
                    }}>
                    {hasError || isExpired ? 'Reconnect' : 'Disconnect'}
                  </button>
                ) : provider.available ? (
                  <button
                    onClick={() => handleConnect(provider.id)}
                    disabled={connecting === provider.id}
                    className="px-3 py-1.5 text-[0.75rem] font-medium rounded-md disabled:opacity-50"
                    style={{ background: 'var(--primary-container)', color: '#fff' }}>
                    {connecting === provider.id ? 'Connecting...' : 'Connect'}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
