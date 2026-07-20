'use client';

import { useEffect, useMemo, useState } from 'react';
import { BellRing, Check, Loader2, Monitor, Send, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

type PushPreferences = {
  enabled: boolean;
  chat: boolean;
  tasks: boolean;
  approvals: boolean;
  calendar: boolean;
  agents: boolean;
  quiet_hours: { enabled: boolean; start: string; end: string };
};

type Device = {
  id: string;
  device_name: string | null;
  user_agent: string | null;
  last_used_at: string | null;
  created_at: string;
};

const DEFAULT_PUSH: PushPreferences = {
  enabled: false,
  chat: true,
  tasks: true,
  approvals: true,
  calendar: true,
  agents: true,
  quiet_hours: { enabled: false, start: '22:00', end: '08:00' },
};

const CATEGORIES: Array<{ key: keyof Pick<PushPreferences, 'chat' | 'tasks' | 'approvals' | 'calendar' | 'agents'>; label: string }> = [
  { key: 'chat', label: 'Chat' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'approvals', label: 'Approvals' },
  { key: 'calendar', label: 'Calendar' },
  { key: 'agents', label: 'Agents' },
];

function decodeApplicationKey(value: string) {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const decoded = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function browserLabel() {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'Microsoft Edge';
  if (/Chrome\//.test(ua)) return 'Google Chrome';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'This browser';
}

export function BrowserNotificationSettings() {
  const { user, refreshUser } = useAuth();
  const [preferences, setPreferences] = useState<PushPreferences>(DEFAULT_PUSH);
  const [configured, setConfigured] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('default');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const supported = useMemo(() => typeof window !== 'undefined'
    && 'Notification' in window
    && 'serviceWorker' in navigator
    && 'PushManager' in window, []);

  const loadStatus = async () => {
    const response = await api.get('/api/push/status');
    if (!response.ok) return;
    const body = await response.json();
    setConfigured(Boolean(body.configured));
    setPublicKey(typeof body.public_key === 'string' ? body.public_key : null);
    setDevices(Array.isArray(body.devices) ? body.devices : []);
  };

  useEffect(() => {
    setPreferences({
      ...DEFAULT_PUSH,
      ...(user?.notification_preferences?.push ?? {}),
      quiet_hours: {
        ...DEFAULT_PUSH.quiet_hours,
        ...(user?.notification_preferences?.push?.quiet_hours ?? {}),
      },
    });
  }, [user?.notification_preferences?.push]);

  useEffect(() => {
    setPermission(supported ? Notification.permission : 'unsupported');
    void loadStatus();
  }, [supported]);

  const savePreferences = async (next: PushPreferences) => {
    setPreferences(next);
    const response = await api.patch('/api/auth/me', { notification_preferences: { push: next } });
    if (!response.ok) throw new Error('Could not save notification preferences');
    await refreshUser();
  };

  const enable = async () => {
    if (!supported || !configured || !publicKey) return;
    setBusy(true);
    setMessage('');
    try {
      const nextPermission = await Notification.requestPermission();
      setPermission(nextPermission);
      if (nextPermission !== 'granted') throw new Error('Browser permission was not granted');
      const registration = await navigator.serviceWorker.register('/deft-sw.js');
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeApplicationKey(publicKey),
      });
      const json = subscription.toJSON();
      const response = await api.post('/api/push/subscribe', {
        endpoint: subscription.endpoint,
        keys: json.keys,
        device_name: browserLabel(),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Could not register this browser');
      await savePreferences({ ...preferences, enabled: true });
      await loadStatus();
      setMessage('Browser notifications enabled');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not enable browser notifications');
    } finally {
      setBusy(false);
    }
  };

  const update = async (next: PushPreferences) => {
    setBusy(true);
    setMessage('');
    try {
      await savePreferences(next);
      setMessage('Preferences saved');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save preferences');
    } finally {
      setBusy(false);
    }
  };

  const removeDevice = async (id: string) => {
    setBusy(true);
    const response = await api.delete(`/api/push/${id}`);
    if (response.ok) await loadStatus();
    setBusy(false);
  };

  const test = async () => {
    setBusy(true);
    setMessage('');
    const response = await api.post('/api/push/test');
    const body = await response.json().catch(() => ({}));
    setMessage(response.ok && body.sent > 0 ? 'Test notification sent' : body.error || 'No registered device received the test');
    setBusy(false);
  };

  return (
    <div className="space-y-3 rounded-xl p-4" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border)' }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ background: 'var(--surface)', color: 'var(--accent)' }}>
            <BellRing size={17} />
          </div>
          <div>
            <h4 className="text-[13px] font-semibold" style={{ color: 'var(--foreground)' }}>Browser notifications</h4>
            <p className="mt-0.5 text-[11px] leading-5" style={{ color: 'var(--muted)' }}>
              Only time-sensitive work leaves Deft. Every alert opens the source item.
            </p>
          </div>
        </div>
        {preferences.enabled && devices.length > 0 ? (
          <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium" style={{ background: 'color-mix(in srgb, var(--success) 12%, transparent)', color: 'var(--success)' }}>
            <Check size={12} /> Enabled
          </span>
        ) : (
          <button type="button" onClick={enable} disabled={busy || !supported || !configured || permission === 'denied'} className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-[12px] font-semibold text-white disabled:opacity-50" style={{ background: 'var(--accent)' }}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <BellRing size={13} />} Enable
          </button>
        )}
      </div>

      {!supported && <p className="text-[11px]" style={{ color: 'var(--warning)' }}>This browser does not support Web Push.</p>}
      {supported && !configured && <p className="text-[11px]" style={{ color: 'var(--warning)' }}>Your Deft administrator has not configured browser notifications yet.</p>}
      {supported && configured && permission === 'denied' && <p className="text-[11px]" style={{ color: 'var(--danger)' }}>Notifications are blocked in browser settings. Allow them there, then reload this page.</p>}

      {preferences.enabled && (
        <>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((category) => (
              <button key={category.key} type="button" disabled={busy} onClick={() => void update({ ...preferences, [category.key]: !preferences[category.key] })} className="rounded-full px-3 py-1.5 text-[11px] font-medium" style={{ background: preferences[category.key] ? 'color-mix(in srgb, var(--accent) 14%, var(--surface))' : 'var(--surface)', color: preferences[category.key] ? 'var(--accent)' : 'var(--muted)', border: '1px solid var(--border)' }}>
                {category.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3 rounded-lg p-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            <label className="flex items-center gap-2 text-[12px] font-medium" style={{ color: 'var(--foreground)' }}>
              <input type="checkbox" checked={preferences.quiet_hours.enabled} onChange={(event) => void update({ ...preferences, quiet_hours: { ...preferences.quiet_hours, enabled: event.target.checked } })} /> Quiet hours
            </label>
            <input type="time" value={preferences.quiet_hours.start} disabled={!preferences.quiet_hours.enabled || busy} onChange={(event) => setPreferences({ ...preferences, quiet_hours: { ...preferences.quiet_hours, start: event.target.value } })} onBlur={() => void update(preferences)} className="rounded-md px-2 py-1 text-[12px]" style={{ background: 'var(--surface-container-low)', color: 'var(--foreground)', border: '1px solid var(--border)' }} />
            <span className="text-[11px]" style={{ color: 'var(--muted)' }}>to</span>
            <input type="time" value={preferences.quiet_hours.end} disabled={!preferences.quiet_hours.enabled || busy} onChange={(event) => setPreferences({ ...preferences, quiet_hours: { ...preferences.quiet_hours, end: event.target.value } })} onBlur={() => void update(preferences)} className="rounded-md px-2 py-1 text-[12px]" style={{ background: 'var(--surface-container-low)', color: 'var(--foreground)', border: '1px solid var(--border)' }} />
          </div>
          <div className="space-y-2">
            {devices.map((device) => (
              <div key={device.id} className="flex items-center justify-between gap-3 text-[12px]">
                <span className="inline-flex min-w-0 items-center gap-2" style={{ color: 'var(--foreground-secondary)' }}><Monitor size={13} /><span className="truncate">{device.device_name || 'Browser device'}</span></span>
                <button type="button" onClick={() => void removeDevice(device.id)} disabled={busy} aria-label="Remove device" className="rounded-full p-1.5" style={{ color: 'var(--muted)' }}><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={test} disabled={busy || devices.length === 0} className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-medium disabled:opacity-50" style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}><Send size={12} /> Send test</button>
            <button type="button" onClick={() => void update({ ...preferences, enabled: false })} disabled={busy} className="rounded-full px-3 py-1.5 text-[11px] font-medium" style={{ color: 'var(--muted)' }}>Pause alerts</button>
          </div>
        </>
      )}
      {message && <p className="text-[11px]" style={{ color: message.includes('Could not') || message.includes('blocked') ? 'var(--danger)' : 'var(--muted)' }}>{message}</p>}
    </div>
  );
}
