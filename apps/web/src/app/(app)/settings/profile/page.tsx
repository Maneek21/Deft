'use client';

import { useRef, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Clock, KeyRound, Loader2, Save, X } from 'lucide-react';
import { BrowserNotificationSettings } from '@/components/browser-notification-settings';

const COMMON_TIMEZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Calcutta',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
];

const AVATAR_OPTIONS = [
  '/avatars/avatar-01-human-purple.png',
  '/avatars/avatar-02-human-coral.png',
  '/avatars/avatar-03-elder-cyan.png',
  '/avatars/avatar-04-elder-gold.png',
  '/avatars/avatar-05-alien-teal.png',
  '/avatars/avatar-06-mascot-purple.png',
  '/avatars/avatar-07-wizard.png',
  '/avatars/avatar-08-elf.png',
  '/avatars/avatar-09-fairy.png',
  '/avatars/avatar-10-vampire.png',
  '/avatars/avatar-11-dragon.png',
  '/avatars/avatar-12-unicorn.png',
  '/avatars/avatar-13-genie.png',
  '/avatars/avatar-14-ghost.png',
  '/avatars/avatar-15-mascot-red.png',
  '/avatars/avatar-16-pixel-alien.png',
  '/avatars/avatar-17-cloud.png',
  '/avatars/avatar-18-lava.png',
  '/avatars/avatar-19-cactus.png',
  '/avatars/avatar-20-mushroom.png',
  '/avatars/avatar-21-mascot-blue.png',
  '/avatars/avatar-22-skeleton.png',
];

type NotificationChannels = {
  chat: boolean;
  tasks: boolean;
  approvals: boolean;
  calendar: boolean;
  agents: boolean;
};

const DEFAULT_NOTIFICATION_CHANNELS: NotificationChannels = {
  chat: true,
  tasks: true,
  approvals: true,
  calendar: true,
  agents: true,
};

const NOTIFICATION_CHANNELS: Array<{
  key: keyof NotificationChannels;
  label: string;
  description: string;
}> = [
  { key: 'chat', label: 'Chat', description: 'Messages, mentions, and replies in spaces you follow.' },
  { key: 'tasks', label: 'Tasks', description: 'Assignments, status changes, comments, and due-date updates.' },
  { key: 'approvals', label: 'Approvals', description: 'Agent actions and governance items waiting on review.' },
  { key: 'calendar', label: 'Calendar', description: 'Meeting reminders, prep, and connected calendar changes.' },
  { key: 'agents', label: 'Agents', description: 'Agent activity, handoffs, health, and completion receipts.' },
];

function splitList(value: string): string[] {
  return Array.from(new Set(value.split(',').map((item) => item.trim()).filter(Boolean)));
}

function joinList(value: string[] | null | undefined): string {
  return (value ?? []).join(', ');
}

export default function ProfileSettingsPage() {
  const { user, refreshUser, replaceUser } = useAuth();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [profileSummary, setProfileSummary] = useState('');
  const [expertiseTags, setExpertiseTags] = useState('');
  const [notificationKeywords, setNotificationKeywords] = useState('');
  const [notificationChannels, setNotificationChannels] = useState<NotificationChannels>(DEFAULT_NOTIFICATION_CHANNELS);
  const [showReadReceipts, setShowReadReceipts] = useState(true);
  const [statusEmoji, setStatusEmoji] = useState('');
  const [statusText, setStatusText] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [error, setError] = useState('');
  const [hydratedUserId, setHydratedUserId] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordMessage, setPasswordMessage] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);

  const timezoneOptions = useMemo(() => {
    const browserTz = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : '';
    const supported = typeof Intl !== 'undefined'
      ? ((Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [])
      : [];
    return Array.from(new Set([browserTz, timezone, ...COMMON_TIMEZONES, ...supported].filter(Boolean))).sort();
  }, [timezone]);

  const localTime = useMemo(() => {
    try {
      return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: timezone || 'UTC' });
    } catch {
      return 'Invalid timezone';
    }
  }, [timezone]);

  useEffect(() => {
    if (!user) return;
    if (hydratedUserId === user.id) return;
    setName(user.name ?? '');
    setTitle(user.title ?? '');
    setAvatarUrl(user.avatar_url ?? '');
    setTimezone(user.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC');
    setProfileSummary(user.profile_summary ?? '');
    setExpertiseTags(joinList(user.expertise_tags));
    setNotificationKeywords(joinList(user.notification_preferences?.keywords ?? user.notification_keywords));
    setNotificationChannels({
      ...DEFAULT_NOTIFICATION_CHANNELS,
      ...(user.notification_preferences?.channels ?? {}),
    });
    setShowReadReceipts(user.show_read_receipts);
    setStatusEmoji(user.status_emoji ?? '');
    setStatusText(user.status_text ?? '');
    setHydratedUserId(user.id);
  }, [hydratedUserId, user]);

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaveMessage('');
    setError('');
    try {
      const profileRes = await api.patch('/api/auth/me', {
        name,
        title: title || null,
        avatar_url: avatarUrl || null,
        timezone,
        profile_summary: profileSummary || null,
        expertise_tags: splitList(expertiseTags),
        notification_keywords: splitList(notificationKeywords),
        notification_preferences: {
          keywords: splitList(notificationKeywords),
          channels: notificationChannels,
        },
        show_read_receipts: showReadReceipts,
      });
      const profileBody = await profileRes.json().catch(() => ({}));
      if (!profileRes.ok) throw new Error(profileBody.error || 'Failed to save profile');
      if (profileBody.user) {
        replaceUser(profileBody.user);
      }

      const statusRes = await api.patch('/api/users/status', {
        emoji: statusEmoji || null,
        text: statusText || null,
        expires_at: null,
      });
      const statusBody = await statusRes.json().catch(() => ({}));
      if (!statusRes.ok) throw new Error(statusBody.error || 'Failed to save status');

      await refreshUser();
      setSaveMessage('Profile saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save profile');
    } finally {
      setSaving(false);
    }
  };

  const handleDnd = async () => {
    setStatusEmoji('');
    setStatusText('Do Not Disturb');
    const res = await api.patch('/api/users/dnd', { enabled: true });
    if (res.ok) {
      await refreshUser();
      setSaveMessage('DND enabled');
    }
  };

  const handleClearStatus = async () => {
    setStatusEmoji('');
    setStatusText('');
    const res = await api.delete('/api/users/status');
    if (res.ok) {
      await refreshUser();
      setSaveMessage('Status cleared');
    }
  };

  const handleAvatarUpload = (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Choose an image file for your avatar.');
      return;
    }
    if (file.size > 1_500_000) {
      setError('Avatar image must be under 1.5MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setAvatarUrl(reader.result);
        setError('');
      }
    };
    reader.onerror = () => setError('Could not read that image.');
    reader.readAsDataURL(file);
  };

  const handlePasswordChange = async () => {
    setPasswordSaving(true);
    setPasswordMessage('');
    setPasswordError('');
    try {
      const res = await api.patch('/api/auth/password', {
        current_password: currentPassword,
        new_password: newPassword,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Failed to change password');
      setCurrentPassword('');
      setNewPassword('');
      setPasswordMessage('Password changed');
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : 'Failed to change password');
    } finally {
      setPasswordSaving(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-6 md:px-6 md:py-8">
        <div className="mb-6 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="eyebrow mb-2" style={{ fontFamily: 'var(--font-heading)' }}>Account</p>
            <h1 className="text-[28px] font-semibold leading-tight" style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}>
              My profile
            </h1>
            <p className="mt-2 max-w-2xl text-[14px] leading-6" style={{ color: 'var(--muted)' }}>
              Shape how teammates understand your role, availability, and collaboration preferences.
            </p>
          </div>
        </div>

        <form onSubmit={handleSave} className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section className="min-w-0 space-y-5">
            <div className="min-w-0 rounded-xl p-5" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
              <h2 className="mb-4 text-[15px] font-semibold" style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}>
                Work identity
              </h2>
              <div className="grid min-w-0 gap-4 md:grid-cols-2">
                <label className="space-y-1.5">
                  <span className="text-[12px] font-medium" style={{ color: 'var(--muted)' }}>Name</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-lg px-3 py-2 text-[14px] outline-none" style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }} />
                </label>
                <label className="space-y-1.5">
                  <span className="text-[12px] font-medium" style={{ color: 'var(--muted)' }}>Title</span>
                  <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Founder, Head Grower, Ops Lead..." className="w-full rounded-lg px-3 py-2 text-[14px] outline-none" style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }} />
                </label>
                <div className="min-w-0 space-y-2 md:col-span-2">
                  <div className="text-[12px] font-medium" style={{ color: 'var(--muted)' }}>Avatar</div>
                  <div className="-mx-1 flex w-full max-w-full gap-2 overflow-x-auto px-1 pb-2">
                    {AVATAR_OPTIONS.map((avatar, index) => {
                      const selected = avatarUrl === avatar;
                      return (
                        <button
                          key={avatar}
                          type="button"
                          onClick={() => setAvatarUrl(avatar)}
                          aria-label={`Choose avatar option ${index + 1}`}
                          title={`Avatar option ${index + 1}`}
                          className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl p-2 transition hover:scale-[1.02]"
                          style={{
                            background: selected ? 'color-mix(in srgb, var(--accent) 14%, var(--surface))' : 'var(--surface)',
                            border: selected ? '1px solid var(--accent)' : '1px solid var(--border)',
                            boxShadow: selected ? '0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent)' : 'none',
                          }}
                        >
                          <img src={avatar} alt="" className="h-16 w-16 rounded-full object-cover" />
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      className="hidden"
                      onChange={(e) => handleAvatarUpload(e.target.files?.[0] ?? null)}
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="rounded-lg px-3 py-2 text-[12px] font-medium"
                      style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
                    >
                      Upload image
                    </button>
                    {avatarUrl && (
                      <button
                        type="button"
                        onClick={() => setAvatarUrl('')}
                        className="rounded-lg px-3 py-2 text-[12px] font-medium"
                        style={{ background: 'var(--surface)', color: 'var(--muted)', border: '1px solid var(--border)' }}
                      >
                        Remove avatar
                      </button>
                    )}
                    <span className="text-[11px]" style={{ color: 'var(--muted)' }}>PNG, JPG, WebP, or GIF under 1.5MB.</span>
                  </div>
                </div>
                <label className="space-y-1.5 md:col-span-2">
                  <span className="text-[12px] font-medium" style={{ color: 'var(--muted)' }}>Profile summary</span>
                  <textarea value={profileSummary} onChange={(e) => setProfileSummary(e.target.value)} rows={4} placeholder="What should teammates know before working with you?" className="w-full resize-none rounded-lg px-3 py-2 text-[14px] leading-6 outline-none" style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }} />
                </label>
                <label className="space-y-1.5 md:col-span-2">
                  <span className="text-[12px] font-medium" style={{ color: 'var(--muted)' }}>Expertise tags</span>
                  <input value={expertiseTags} onChange={(e) => setExpertiseTags(e.target.value)} placeholder="pricing, greenhouse ops, buyer calls" className="w-full rounded-lg px-3 py-2 text-[14px] outline-none" style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }} />
                  <p className="text-[11px]" style={{ color: 'var(--muted)' }}>Comma separated. These are self-declared and separate from inferred expertise.</p>
                </label>
              </div>
            </div>

            <div className="rounded-xl p-5" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
              <h2 className="mb-4 text-[15px] font-semibold" style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}>
                Availability and preferences
              </h2>
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-1.5">
                  <span className="text-[12px] font-medium" style={{ color: 'var(--muted)' }}>Timezone</span>
                  <select value={timezone} onChange={(e) => setTimezone(e.target.value)} className="w-full rounded-lg px-3 py-2 text-[14px] outline-none" style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}>
                    {timezoneOptions.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                  </select>
                </label>
                <div className="flex items-end">
                  <div className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px]" style={{ background: 'var(--surface-container-low)', color: 'var(--foreground)', border: '1px solid var(--border)' }}>
                    <Clock size={15} />
                    Local time: {localTime}
                  </div>
                </div>
                <label className="space-y-1.5">
                  <span className="text-[12px] font-medium" style={{ color: 'var(--muted)' }}>Status marker</span>
                  <input value={statusEmoji} onChange={(e) => setStatusEmoji(e.target.value)} placeholder="Optional short marker" maxLength={8} className="w-full rounded-lg px-3 py-2 text-[14px] outline-none" style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }} />
                </label>
                <label className="space-y-1.5">
                  <span className="text-[12px] font-medium" style={{ color: 'var(--muted)' }}>Status text</span>
                  <input value={statusText} onChange={(e) => setStatusText(e.target.value)} placeholder="In field checks until 2pm" className="w-full rounded-lg px-3 py-2 text-[14px] outline-none" style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }} />
                </label>
                <div className="space-y-3 md:col-span-2">
                  <div>
                    <h3 className="text-[13px] font-semibold" style={{ color: 'var(--foreground)' }}>Notifications</h3>
                    <p className="mt-1 text-[11px] leading-5" style={{ color: 'var(--muted)' }}>
                      Choose the work surfaces that can interrupt you. Keyword alerts still work across enabled surfaces.
                    </p>
                  </div>
                  <div className="grid gap-2">
                    {NOTIFICATION_CHANNELS.map((channel) => (
                      <label
                        key={channel.key}
                        className="flex items-center justify-between gap-3 rounded-lg px-3 py-3"
                        style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border)' }}
                      >
                        <span className="min-w-0">
                          <span className="block text-[13px] font-medium" style={{ color: 'var(--foreground)' }}>{channel.label}</span>
                          <span className="block text-[11px] leading-5" style={{ color: 'var(--muted)' }}>{channel.description}</span>
                        </span>
                        <input
                          type="checkbox"
                          checked={notificationChannels[channel.key]}
                          onChange={(e) => setNotificationChannels((current) => ({ ...current, [channel.key]: e.target.checked }))}
                          className="h-4 w-4 shrink-0"
                        />
                      </label>
                    ))}
                  </div>
                  <label className="block space-y-1.5">
                    <span className="text-[12px] font-medium" style={{ color: 'var(--muted)' }}>Keyword alerts</span>
                    <input value={notificationKeywords} onChange={(e) => setNotificationKeywords(e.target.value)} placeholder="launch, buyer, blocker, invoice" className="w-full rounded-lg px-3 py-2 text-[14px] outline-none" style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }} />
                    <span className="block text-[11px]" style={{ color: 'var(--muted)' }}>Comma separated. These add attention, they do not replace mentions or assignments.</span>
                  </label>
                  <BrowserNotificationSettings />
                </div>
                <label className="flex items-center justify-between gap-3 rounded-lg px-3 py-3 md:col-span-2" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border)' }}>
                  <span>
                    <span className="block text-[13px] font-medium" style={{ color: 'var(--foreground)' }}>Show read receipts</span>
                    <span className="block text-[11px]" style={{ color: 'var(--muted)' }}>Let teammates see when you have read messages where receipts are supported.</span>
                  </span>
                  <input type="checkbox" checked={showReadReceipts} onChange={(e) => setShowReadReceipts(e.target.checked)} className="h-4 w-4" />
                </label>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" onClick={handleDnd} className="rounded-lg px-3 py-2 text-[12px] font-medium" style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}>
                  Set DND
                </button>
                <button type="button" onClick={handleClearStatus} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] font-medium" style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}>
                  <X size={13} />
                  Clear status
                </button>
              </div>
            </div>
          </section>

          <aside className="space-y-5">
            <div className="rounded-xl p-5" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
              <h2 className="mb-3 text-[15px] font-semibold" style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}>
                Preview
              </h2>
              <div className="flex items-start gap-3">
                {avatarUrl ? (
                  <img src={avatarUrl} alt="" className="h-12 w-12 rounded-full object-cover" />
                ) : (
                  <div className="flex h-12 w-12 items-center justify-center rounded-full text-[18px] font-semibold text-white" style={{ background: 'var(--accent)' }}>
                    {name.charAt(0).toUpperCase() || '?'}
                  </div>
                )}
                <div className="min-w-0">
                  <div className="truncate text-[14px] font-semibold" style={{ color: 'var(--foreground)' }}>{name || 'Unnamed'}</div>
                  <div className="truncate text-[12px]" style={{ color: 'var(--muted)' }}>{title || 'No title set'}</div>
                  {(statusEmoji || statusText) && (
                    <div className="mt-1 text-[12px]" style={{ color: 'var(--foreground-secondary)' }}>
                      {statusEmoji} {statusText}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="rounded-xl p-5" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
              <h2 className="mb-3 flex items-center gap-2 text-[15px] font-semibold" style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}>
                <KeyRound size={16} />
                Password
              </h2>
              <div className="space-y-3">
                <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} placeholder="Current password" className="w-full rounded-lg px-3 py-2 text-[14px] outline-none" style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }} />
                <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="New password" className="w-full rounded-lg px-3 py-2 text-[14px] outline-none" style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }} />
                {passwordError && <div className="text-[12px]" style={{ color: 'var(--status-red)' }}>{passwordError}</div>}
                {passwordMessage && <div className="text-[12px]" style={{ color: 'var(--status-green)' }}>{passwordMessage}</div>}
                <button type="button" onClick={handlePasswordChange} disabled={passwordSaving || !currentPassword || newPassword.length < 8} className="inline-flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-[12px] font-medium disabled:opacity-50" style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}>
                  {passwordSaving && <Loader2 size={13} className="animate-spin" />}
                  Change password
                </button>
              </div>
            </div>
          </aside>

          <div className="lg:col-span-2">
            {error && <div className="mb-3 text-[13px]" style={{ color: 'var(--status-red)' }}>{error}</div>}
            {saveMessage && <div className="mb-3 text-[13px]" style={{ color: 'var(--status-green)' }}>{saveMessage}</div>}
            <button type="submit" disabled={saving || !name.trim()} className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-[13px] font-semibold disabled:opacity-50" style={{ background: 'var(--accent)', color: 'white' }}>
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
              Save profile
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
