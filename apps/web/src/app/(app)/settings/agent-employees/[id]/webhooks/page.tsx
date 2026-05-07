/**
 * UX sweep — webhook management page.
 *
 * Backend shipped in Block 3.3 but had no UI; this page lets users
 * list / create / revoke agent webhooks, shown the raw secret exactly
 * once at creation time (the API only stores a hash).
 */
'use client';
import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Copy, Loader2, Plus, Trash2, Webhook, AlertCircle } from 'lucide-react';

type Webhook = {
  id: string;
  agent_employee_id: string;
  slug: string;
  label: string | null;
  enabled: boolean;
  last_fired_at: string | null;
  fire_count: number;
  created_at: string;
};

export default function WebhooksPage() {
  const params = useParams();
  const router = useRouter();
  const employeeId = String(params?.id ?? '');
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<{ secret: string; slug: string; post_url: string } | null>(null);
  const [copyHint, setCopyHint] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await api.fetch(`/api/agent-webhooks?employee_id=${employeeId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      setWebhooks(body.webhooks ?? []);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [employeeId]);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setCreating(true);
    try {
      const res = await api.post('/api/agent-webhooks', {
        agent_employee_id: employeeId,
        label: newLabel || undefined,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = await res.json();
      setCreatedSecret({ secret: body.secret, slug: body.webhook.slug, post_url: body.post_url });
      setNewLabel('');
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string) => {
    if (!confirm('Revoke this webhook? External systems using it will start getting 404.')) return;
    try {
      const res = await api.delete(`/api/agent-webhooks/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyHint(`Copied ${label}`);
      setTimeout(() => setCopyHint(null), 1500);
    } catch {
      setCopyHint('Copy failed — select manually');
      setTimeout(() => setCopyHint(null), 2000);
    }
  };

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-4">
        <button
          type="button"
          onClick={() => router.push('/settings/agent')}
          className="text-xs text-muted-foreground hover:underline"
        >
          ← Back to agents
        </button>
        <h1 className="mt-2 text-2xl font-semibold flex items-center gap-2">
          <Webhook className="size-5" /> Webhooks
        </h1>
        <p className="text-sm text-muted-foreground">
          Expose this agent to external systems. POSTing JSON to the webhook URL with the secret as
          <code className="mx-1">Authorization: Bearer &lt;secret&gt;</code>
          fires the agent&apos;s <code>trigger_kind=&quot;webhook&quot;</code> playbook over the payload.
        </p>
      </div>

      {copyHint && <div className="mb-3 rounded bg-accent/60 px-3 py-1.5 text-xs">{copyHint}</div>}
      {err && (
        <div className="mb-3 flex items-start gap-2 rounded border border-destructive/30 bg-destructive/10 p-3 text-sm">
          <AlertCircle className="mt-0.5 size-4 text-destructive" />
          <span>{err}</span>
        </div>
      )}

      {createdSecret && (
        <div className="mb-4 rounded border border-amber-500/40 bg-amber-500/10 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <AlertCircle className="size-4 text-amber-500" />
            Save this secret now — it won&apos;t be shown again.
          </div>
          <div className="mt-2 space-y-2 text-xs">
            <KV label="Slug" value={createdSecret.slug} onCopy={() => copy('slug', createdSecret.slug)} />
            <KV label="POST URL" value={`${typeof window !== 'undefined' ? window.location.origin : ''}${createdSecret.post_url}`}
              onCopy={() => copy('URL', `${window.location.origin}${createdSecret.post_url}`)} />
            <KV label="Secret" value={createdSecret.secret} onCopy={() => copy('secret', createdSecret.secret)} mono />
          </div>
          <button
            type="button"
            onClick={() => setCreatedSecret(null)}
            className="mt-3 rounded border border-border px-3 py-1 text-xs hover:bg-accent"
          >
            I&apos;ve saved it — dismiss
          </button>
        </div>
      )}

      <section className="rounded border border-border bg-card p-4">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">New webhook</div>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Label (e.g. Stripe events)"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            className="flex-1 rounded border border-border bg-background px-2 py-1.5 text-sm"
          />
          <button
            type="button"
            onClick={create}
            disabled={creating}
            className="inline-flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {creating ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            Create webhook
          </button>
        </div>
      </section>

      <section className="mt-5">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Active webhooks</div>
        {loading ? (
          <div className="flex items-center gap-2 rounded border border-border bg-card p-3 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : webhooks.length === 0 ? (
          <div className="rounded border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
            No webhooks yet. Create one above.
          </div>
        ) : (
          <div className="space-y-2">
            {webhooks.map((w) => (
              <div key={w.id} className="rounded border border-border bg-card p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{w.label ?? '(unlabeled)'}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] font-mono text-muted-foreground">
                      <span className="break-all">{w.slug}</span>
                      <button
                        type="button"
                        onClick={() => copy('slug', w.slug)}
                        className="rounded border border-border px-1 py-0.5 hover:bg-accent"
                        aria-label="Copy slug"
                      >
                        <Copy className="size-3" />
                      </button>
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {w.fire_count} fires{w.last_fired_at ? ` · last ${new Date(w.last_fired_at).toLocaleString()}` : ' · never fired'} ·
                      created {new Date(w.created_at).toLocaleDateString()}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => revoke(w.id)}
                    aria-label={`Revoke webhook ${w.label ?? w.slug}`}
                    className="rounded border border-border p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function KV({ label, value, onCopy, mono }: { label: string; value: string; onCopy?: () => void; mono?: boolean }) {
  return (
    <div className="grid grid-cols-12 gap-2 items-center">
      <div className="col-span-2 text-muted-foreground">{label}</div>
      <div className={`col-span-9 rounded border border-border bg-background px-2 py-1 ${mono ? 'font-mono' : ''} truncate`}>
        {value}
      </div>
      {onCopy && (
        <button type="button" onClick={onCopy} className="col-span-1 rounded border border-border px-2 py-1 hover:bg-accent">
          <Copy className="size-3" />
        </button>
      )}
    </div>
  );
}
