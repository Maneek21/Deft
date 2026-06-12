'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/time';
import {
  Calendar,
  Copy,
  Check,
  RefreshCw,
  Trash2,
  Plus,
  KeyRound,
  ChevronDown,
  ChevronRight,
  Loader2,
  AlertCircle,
  Eye,
  PauseCircle,
  PlayCircle,
} from 'lucide-react';

type Subscription = {
  id: string;
  ics_url: string;
  label: string | null;
  sync_interval_min: number;
  is_active: boolean;
  last_synced_at: string | null;
  last_error: string | null;
  last_event_count: number | null;
  created_at: string;
  updated_at: string;
};

const INTERVAL_OPTIONS = [
  { value: 5, label: '5 min' },
  { value: 15, label: '15 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '60 min' },
];

const PROVIDERS = [
  { id: 'google', label: 'Google', hint: 'Settings -> calendar -> Integrate calendar -> Secret address in iCal format.' },
  { id: 'apple', label: 'Apple/iCloud', hint: 'Share Calendar -> Public Calendar -> copy the webcal URL.' },
  { id: 'outlook', label: 'Outlook', hint: 'Settings -> Calendar -> Shared calendars -> Publish -> ICS URL.' },
  { id: 'fastmail', label: 'Fastmail', hint: 'Calendar settings -> Sharing -> private iCalendar feed URL.' },
  { id: 'generic', label: 'Generic ICS', hint: 'Paste any private, public, or webcal ICS feed URL.' },
] as const;

type ProviderId = typeof PROVIDERS[number]['id'];

type FeedPreview = {
  calendar_name: string | null;
  event_count: number;
  upcoming: Array<{
    uid: string;
    title: string;
    starts_at: string;
    ends_at: string | null;
    all_day: boolean;
    location: string | null;
  }>;
};

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function formatDateTime(value: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function nextSyncAt(sub: Subscription): string {
  if (!sub.is_active) return 'Paused';
  if (!sub.last_synced_at) return 'Due now';
  const date = new Date(sub.last_synced_at);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  date.setMinutes(date.getMinutes() + sub.sync_interval_min);
  return formatDateTime(date.toISOString());
}

export default function CalendarSettingsPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-[720px]">
        <div className="mb-6">
          <h2
            className="text-[18px] font-semibold"
            style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
          >
            Calendar sync
          </h2>
          <p className="text-[12px] mt-1 leading-relaxed" style={{ color: 'var(--muted)' }}>
            Connect calendars with ICS links: show Deft work in your calendar, and read external calendar events into Deft without OAuth.
          </p>
        </div>

        <OutboundSection />
        <InboundSection />
      </div>
    </div>
  );
}

// ── Section A: Subscribe Deft to your calendar (outbound) ─────────────────────

function OutboundSection() {
  const [feedUrl, setFeedUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [howToOpen, setHowToOpen] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const r = await api.get('/api/ics/my-feed-url');
      if (r.ok) {
        const j = await r.json();
        setFeedUrl(j.feed_url);
      } else {
        setError('Failed to load feed URL.');
      }
      setLoading(false);
    })();
  }, []);

  const copy = async () => {
    if (!feedUrl) return;
    await navigator.clipboard.writeText(feedUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const regenerate = async () => {
    setRegenerating(true);
    setError('');
    try {
      const r = await api.post('/api/ics/my-feed-url/regenerate', {});
      if (!r.ok) throw new Error('Regenerate failed');
      const j = await r.json();
      setFeedUrl(j.feed_url);
      setConfirmRegen(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <section className="mb-10">
      <h3
        className="text-[11px] font-semibold uppercase tracking-wide mb-1"
        style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
      >
        Show Deft in your calendar
      </h3>
      <p className="text-[12px] mb-3 leading-relaxed" style={{ color: 'var(--muted)' }}>
        Paste this URL into your calendar app to see your Deft tasks alongside your other events. Your calendar app re-fetches automatically — no OAuth, no plugin.
      </p>

      <div
        className="p-4 rounded-lg"
        style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
      >
        <div className="flex items-start gap-3">
          <div
            className="w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0"
            style={{ background: 'var(--surface)', color: 'var(--foreground-secondary)' }}
          >
            <Calendar size={14} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-medium" style={{ color: 'var(--foreground)' }}>
              Your personal Deft feed URL
            </p>
            <p className="text-[12px] mt-0.5 leading-snug" style={{ color: 'var(--muted)' }}>
              Tasks with due dates and synced events for the next 12 months.
            </p>
          </div>
        </div>

        <div className="mt-3">
          {error && (
            <div
              className="mb-2 px-3 py-2 text-[12px] rounded"
              style={{ background: 'rgba(147,0,10,0.2)', color: 'var(--error)' }}
            >
              {error}
            </div>
          )}

          {loading ? (
            <div className="h-9 flex items-center text-[12px]" style={{ color: 'var(--muted)' }}>
              <Loader2 size={13} className="animate-spin mr-2" /> Loading…
            </div>
          ) : feedUrl ? (
            <div className="flex gap-2">
              <input
                type="text"
                readOnly
                value={feedUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="flex-1 h-9 px-3 text-[12px] rounded-md outline-none font-mono"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
              />
              <button
                type="button"
                onClick={copy}
                className="h-9 px-3 flex items-center gap-1.5 text-[12px] font-medium rounded-md"
                style={{
                  background: copied ? 'var(--accent)' : 'var(--surface)',
                  color: copied ? 'white' : 'var(--foreground)',
                  border: '1px solid var(--border)',
                }}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          ) : null}
        </div>

        {/* How to subscribe disclosure */}
        <button
          type="button"
          onClick={() => setHowToOpen((v) => !v)}
          className="mt-3 inline-flex items-center gap-1 text-[12px]"
          style={{ color: 'var(--muted)' }}
        >
          {howToOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          How to subscribe
        </button>

        {howToOpen && (
          <div className="mt-2 space-y-2 text-[12px] leading-relaxed" style={{ color: 'var(--foreground-secondary)' }}>
            <p>
              <span className="font-medium" style={{ color: 'var(--foreground)' }}>Apple Calendar.</span>{' '}
              File → New Calendar Subscription → paste the URL.
            </p>
            <p>
              <span className="font-medium" style={{ color: 'var(--foreground)' }}>Google Calendar.</span>{' '}
              On the web: Other calendars → + → From URL → paste.
            </p>
            <p>
              <span className="font-medium" style={{ color: 'var(--foreground)' }}>Outlook.</span>{' '}
              Add calendar → Subscribe from web → paste.
            </p>
          </div>
        )}

        {/* Regenerate */}
        <div className="mt-4 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
          {confirmRegen ? (
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="inline-flex items-center gap-1.5 text-[12px]"
                style={{ color: 'var(--foreground-secondary)' }}
              >
                <AlertCircle size={12} />
                This invalidates the current URL — calendars subscribed to it will stop receiving updates.
              </span>
              <div className="flex gap-2 ml-auto">
                <button
                  type="button"
                  onClick={() => setConfirmRegen(false)}
                  disabled={regenerating}
                  className="h-8 px-3 text-[12px] font-medium rounded-md"
                  style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={regenerate}
                  disabled={regenerating}
                  className="h-8 px-3 flex items-center gap-1.5 text-[12px] font-medium rounded-md disabled:opacity-50"
                  style={{ background: 'var(--error)', color: 'white' }}
                >
                  <RefreshCw size={12} className={regenerating ? 'animate-spin' : ''} />
                  {regenerating ? 'Rotating…' : 'Confirm regenerate'}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmRegen(true)}
              disabled={!feedUrl}
              className="inline-flex items-center gap-1.5 text-[12px] disabled:opacity-50"
              style={{ color: 'var(--muted)' }}
            >
              <KeyRound size={12} />
              Regenerate URL
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

// ── Section B: Subscribe Deft to other calendars (inbound) ────────────────────

function InboundSection() {
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [whereOpen, setWhereOpen] = useState(false);

  const refresh = async () => {
    const r = await api.get('/api/ics/subscriptions');
    if (r.ok) setSubs(await r.json());
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  return (
    <section>
      <div className="flex items-center justify-between mb-1">
        <h3
          className="text-[11px] font-semibold uppercase tracking-wide"
          style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
        >
          Connect external calendars to Deft
        </h3>
        {!showAdd && (
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1 px-3 py-1 rounded-md text-[12px] font-medium"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            <Plus size={12} />
            Add
          </button>
        )}
      </div>
      <p className="text-[12px] mb-3 leading-relaxed" style={{ color: 'var(--muted)' }}>
        Paste a secret ICS feed URL from Google, iCloud, or Outlook to read those events into Deft. The agent uses them for context — nothing's sent back.
      </p>

      {showAdd && (
        <AddSubscriptionForm
          onCreated={(sub) => {
            setSubs((prev) => [...prev, sub]);
            setShowAdd(false);
          }}
          onCancel={() => setShowAdd(false)}
        />
      )}

      <div className="space-y-2 mb-3">
        {loading ? (
          <div
            className="p-4 rounded-lg flex items-center gap-2 text-[12px]"
            style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', color: 'var(--muted)' }}
          >
            <Loader2 size={13} className="animate-spin" /> Loading subscriptions…
          </div>
        ) : subs.length === 0 ? (
          <div
            className="p-4 rounded-lg text-[12px] leading-relaxed"
            style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', color: 'var(--muted)' }}
          >
            No inbound calendar subscriptions yet. Add one above to start ingesting events.
          </div>
        ) : (
          subs.map((s) => (
            <SubscriptionRow
              key={s.id}
              sub={s}
              onChange={(next) => setSubs((prev) => prev.map((p) => (p.id === next.id ? next : p)))}
              onRemove={(id) => setSubs((prev) => prev.filter((p) => p.id !== id))}
            />
          ))
        )}
      </div>

      <button
        type="button"
        onClick={() => setWhereOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[12px]"
        style={{ color: 'var(--muted)' }}
      >
        {whereOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        How to find your secret ICS URL
      </button>

      {whereOpen && (
        <div className="mt-2 space-y-2 text-[12px] leading-relaxed" style={{ color: 'var(--foreground-secondary)' }}>
          <p>
            <span className="font-medium" style={{ color: 'var(--foreground)' }}>Google Calendar.</span>{' '}
            Settings → Settings for my calendars → pick the calendar → Integrate calendar → "Secret address in iCal format".
          </p>
          <p>
            <span className="font-medium" style={{ color: 'var(--foreground)' }}>iCloud.</span>{' '}
            On iCloud.com or in Calendar app: right-click the calendar → Share Calendar → enable Public Calendar → copy URL.
          </p>
          <p>
            <span className="font-medium" style={{ color: 'var(--foreground)' }}>Outlook.</span>{' '}
            Settings → Calendar → Shared calendars → Publish a calendar → copy the ICS URL.
          </p>
        </div>
      )}
    </section>
  );
}

function AddSubscriptionForm({
  onCreated,
  onCancel,
}: {
  onCreated: (sub: Subscription) => void;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [interval, setInterval] = useState<number>(15);
  const [submitting, setSubmitting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [provider, setProvider] = useState<ProviderId>('google');
  const [preview, setPreview] = useState<FeedPreview | null>(null);
  const [err, setErr] = useState('');

  const selectedProvider = PROVIDERS.find((item) => item.id === provider) ?? PROVIDERS[0];

  const previewFeed = async () => {
    setPreviewing(true);
    setErr('');
    setPreview(null);
    try {
      const trimmed = url.trim();
      if (!trimmed) throw new Error('URL required');
      const r = await api.post('/api/ics/preview', { ics_url: trimmed });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || j.error || 'Preview failed');
      setPreview(j as FeedPreview);
      if (!label.trim() && j.calendar_name) setLabel(j.calendar_name);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setPreviewing(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setErr('');
    try {
      const trimmed = url.trim();
      // The API auto-rewrites webcal:// → https://, but some browsers reject
      // webcal in <input type="url"> validation, so we accept it as text.
      if (!trimmed) throw new Error('URL required');
      const r = await api.post('/api/ics/subscriptions', {
        ics_url: trimmed,
        label: label.trim() || preview?.calendar_name || selectedProvider.label,
        sync_interval_min: interval,
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || j.detail || 'Failed to add subscription');
      onCreated(j as Subscription);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="mb-3 p-4 rounded-lg space-y-3"
      style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
    >
      {err && (
        <div className="px-3 py-2 text-[12px] rounded" style={{ background: 'rgba(147,0,10,0.2)', color: 'var(--error)' }}>
          {err}
        </div>
      )}
      <div>
        <label className="text-[11px] font-semibold uppercase tracking-wide block mb-1.5" style={{ color: 'var(--muted)' }}>
          Calendar provider
        </label>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-1">
          {PROVIDERS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setProvider(item.id)}
              className="h-8 px-2 text-[11px] font-medium rounded-md"
              style={{
                background: provider === item.id ? 'var(--accent)' : 'var(--surface)',
                color: provider === item.id ? 'white' : 'var(--foreground)',
                border: '1px solid var(--border)',
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[12px] leading-relaxed" style={{ color: 'var(--muted)' }}>
          {selectedProvider.hint}
        </p>
      </div>
      <div>
        <label className="text-[11px] font-semibold uppercase tracking-wide block mb-1.5" style={{ color: 'var(--muted)' }}>
          ICS URL
        </label>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://calendar.google.com/… or webcal://…"
          autoFocus
          required
          className="w-full h-9 px-3 text-[13px] rounded-md outline-none font-mono"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
        />
      </div>
      {preview && (
        <div className="rounded-md p-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-[13px] font-medium" style={{ color: 'var(--foreground)' }}>
                {preview.calendar_name || 'Calendar feed'}
              </p>
              <p className="text-[12px]" style={{ color: 'var(--muted)' }}>
                Found {preview.event_count} event{preview.event_count === 1 ? '' : 's'}.
              </p>
            </div>
            <span className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full" style={{ background: 'rgba(34,197,94,0.15)', color: 'var(--success, #22c55e)' }}>
              <Check size={11} /> Preview ok
            </span>
          </div>
          {preview.upcoming.length > 0 && (
            <div className="mt-3 space-y-1">
              {preview.upcoming.map((event) => (
                <div key={event.uid} className="flex justify-between gap-3 text-[12px]">
                  <span className="truncate" style={{ color: 'var(--foreground-secondary)' }}>{event.title}</span>
                  <span className="shrink-0" style={{ color: 'var(--muted)' }}>{formatDateTime(event.starts_at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="text-[11px] font-semibold uppercase tracking-wide block mb-1.5" style={{ color: 'var(--muted)' }}>
            Label <span className="font-normal normal-case" style={{ color: 'var(--muted)' }}>(optional)</span>
          </label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Personal calendar"
            maxLength={120}
            className="w-full h-9 px-3 text-[13px] rounded-md outline-none"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
          />
        </div>
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wide block mb-1.5" style={{ color: 'var(--muted)' }}>
            Sync every
          </label>
          <select
            value={interval}
            onChange={(e) => setInterval(Number(e.target.value))}
            className="h-9 px-2 text-[13px] rounded-md outline-none"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
          >
            {INTERVAL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="h-9 px-3 text-[12px] font-medium rounded-md"
          style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={previewFeed}
          disabled={previewing || submitting || !url.trim()}
          className="h-9 px-3 inline-flex items-center gap-1.5 text-[12px] font-medium rounded-md disabled:opacity-50"
          style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
        >
          <Eye size={12} />
          {previewing ? 'Previewing...' : 'Preview'}
        </button>
        <button
          type="submit"
          disabled={submitting || previewing || !url.trim()}
          className="h-9 px-4 text-[12px] font-medium rounded-md disabled:opacity-50"
          style={{ background: 'var(--accent)', color: 'white' }}
        >
          {submitting ? 'Adding…' : 'Add subscription'}
        </button>
      </div>
    </form>
  );
}

function SubscriptionRow({
  sub,
  onChange,
  onRemove,
}: {
  sub: Subscription;
  onChange: (next: Subscription) => void;
  onRemove: (id: string) => void;
}) {
  const [syncing, setSyncing] = useState(false);
  const [justSynced, setJustSynced] = useState(false);
  const [err, setErr] = useState('');

  const sync = async () => {
    setSyncing(true);
    setErr('');
    try {
      const r = await api.post(`/api/ics/subscriptions/${sub.id}/sync`, {});
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || j.error || 'Sync failed');
      if (j.subscription) onChange(j.subscription as Subscription);
      setJustSynced(true);
      setTimeout(() => setJustSynced(false), 2000);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSyncing(false);
    }
  };

  const remove = async () => {
    // Optimistic remove — the API is idempotent, and a 404 just means the row
    // was already gone, which is the same outcome.
    onRemove(sub.id);
    await api.delete(`/api/ics/subscriptions/${sub.id}`);
  };

  const toggleActive = async () => {
    const r = await api.patch(`/api/ics/subscriptions/${sub.id}`, { is_active: !sub.is_active });
    if (r.ok) onChange(await r.json());
  };

  const displayLabel = sub.label || truncate(sub.ics_url, 40);

  let status: { text: string; tone: 'ok' | 'muted' | 'error' };
  if (sub.last_error) {
    status = { text: `error: ${truncate(sub.last_error, 80)}`, tone: 'error' };
  } else if (sub.last_synced_at) {
    const count = sub.last_event_count ?? 0;
    status = {
      text: `synced ${count} event${count === 1 ? '' : 's'} ${formatRelative(sub.last_synced_at)}`,
      tone: 'ok',
    };
  } else {
    status = { text: 'never synced', tone: 'muted' };
  }

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
          <Calendar size={14} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium truncate" style={{ color: 'var(--foreground)' }}>
            {displayLabel}
          </p>
          {sub.label && (
            <p className="text-[11px] mt-0.5 truncate font-mono" style={{ color: 'var(--muted)' }}>
              {truncate(sub.ics_url, 60)}
            </p>
          )}
          <div className="mt-1 flex items-center gap-2 flex-wrap">
            <span
              className="text-[11px] px-1.5 py-0.5 rounded"
              style={{
                background: sub.is_active ? 'rgba(34,197,94,0.12)' : 'var(--surface)',
                color: sub.is_active ? 'var(--success, #22c55e)' : 'var(--muted)',
              }}
            >
              {sub.is_active ? 'active' : 'paused'}
            </span>
            <span
              className="text-[11px] px-1.5 py-0.5 rounded inline-flex items-center gap-1"
              style={{
                background:
                  status.tone === 'error'
                    ? 'rgba(147,0,10,0.15)'
                    : status.tone === 'ok'
                      ? 'rgba(34,197,94,0.15)'
                      : 'var(--surface)',
                color:
                  status.tone === 'error'
                    ? 'var(--error)'
                    : status.tone === 'ok'
                      ? 'var(--success, #22c55e)'
                      : 'var(--muted)',
              }}
            >
              {justSynced && <Check size={10} />}
              {status.text}
            </span>
            <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
              every {sub.sync_interval_min} min
            </span>
            <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
              next sync: {nextSyncAt(sub)}
            </span>
          </div>
          {err && (
            <p className="mt-2 text-[11px]" style={{ color: 'var(--error)' }}>
              {err}
            </p>
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={toggleActive}
            title={sub.is_active ? 'Pause subscription' : 'Resume subscription'}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md"
            style={{ background: 'var(--surface)', color: 'var(--muted)', border: '1px solid var(--border)' }}
          >
            {sub.is_active ? <PauseCircle size={12} /> : <PlayCircle size={12} />}
          </button>
          <button
            type="button"
            onClick={sync}
            disabled={syncing}
            title="Sync now"
            className="h-8 px-2 inline-flex items-center gap-1 text-[12px] font-medium rounded-md disabled:opacity-50"
            style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
          >
            <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} />
            Sync now
          </button>
          <button
            type="button"
            onClick={remove}
            title="Remove subscription"
            className="h-8 w-8 inline-flex items-center justify-center rounded-md"
            style={{ background: 'var(--surface)', color: 'var(--muted)', border: '1px solid var(--border)' }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}
