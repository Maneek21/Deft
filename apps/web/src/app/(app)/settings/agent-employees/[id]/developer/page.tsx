/**
 * Developer tab — BYOA credentials.
 *
 * Surfaces the MCP endpoint URL + bearer token for a single agent-employee
 * so the user can wire up Claude Desktop, Claude Code, or a custom MCP
 * client. Token reveal is admin-only (enforced server-side by
 * /api/agent-employees/:id/developer).
 */
'use client';
import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Copy, Eye, EyeOff, Loader2, Terminal } from 'lucide-react';

type DeveloperPayload = {
  employee: { id: string; slug: string };
  mcp_endpoint_url: string;
  mcp_token_masked: string | null;
  mcp_token: string | null;
};

export default function DeveloperPage() {
  const params = useParams();
  const router = useRouter();
  const employeeId = String(params?.id ?? '');
  const [data, setData] = useState<DeveloperPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copyHint, setCopyHint] = useState<string | null>(null);

  const load = useCallback(async (reveal: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.fetch(`/api/agent-employees/${employeeId}/developer${reveal ? '?reveal=1' : ''}`);
      if (!res.ok) {
        if (res.status === 403) {
          setError('Only org admins can reveal the bearer token.');
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      setData(await res.json());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [employeeId]);

  useEffect(() => { load(false); }, [load]);

  const toggleReveal = async () => {
    const next = !revealed;
    await load(next);
    setRevealed(next);
  };

  const copy = async (label: string, value: string | null | undefined) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopyHint(`Copied ${label}`);
      setTimeout(() => setCopyHint(null), 1500);
    } catch {
      setCopyHint('Copy failed — select manually');
      setTimeout(() => setCopyHint(null), 2000);
    }
  };

  if (loading && !data) {
    return (
      <div className="mx-auto max-w-4xl p-6 text-sm text-muted-foreground">
        <Loader2 className="inline-block mr-2 size-4 animate-spin" />
        Loading developer info…
      </div>
    );
  }
  if (error && !data) {
    return <div className="mx-auto max-w-4xl p-6 text-sm text-destructive">{error}</div>;
  }
  if (!data) return null;

  const claudeDesktopConfig = JSON.stringify(
    {
      mcpServers: {
        deft: {
          url: data.mcp_endpoint_url,
          headers: {
            Authorization: `Bearer ${revealed && data.mcp_token ? data.mcp_token : '<bearer-token>'}`,
          },
        },
      },
    },
    null,
    2,
  );

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-4">
        <button
          type="button"
          onClick={() => router.push('/settings/agent-employees')}
          className="text-xs text-muted-foreground hover:underline"
        >
          ← Back to agents
        </button>
        <h1 className="mt-2 text-2xl font-semibold flex items-center gap-2">
          <Terminal className="size-5" /> Developer
        </h1>
        <p className="text-sm text-muted-foreground">
          MCP credentials for connecting your agent runtime to Deft. Treat the
          bearer token like a password — it grants full read/write access via
          the MCP server.
        </p>
      </div>

      {copyHint && (
        <div className="mb-3 rounded bg-accent/60 px-3 py-1.5 text-xs">{copyHint}</div>
      )}
      {error && <div className="mb-3 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">{error}</div>}

      <section className="space-y-3">
        <Field
          label="Employee slug"
          value={data.employee.slug}
          onCopy={() => copy('slug', data.employee.slug)}
        />
        <Field
          label="MCP endpoint URL"
          value={data.mcp_endpoint_url}
          onCopy={() => copy('URL', data.mcp_endpoint_url)}
          mono
        />
        <Field
          label="Bearer token"
          value={revealed && data.mcp_token ? data.mcp_token : (data.mcp_token_masked ?? '(no token yet)')}
          mono
          trailing={(
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={toggleReveal}
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-accent"
              >
                {revealed ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                {revealed ? 'Hide' : 'Reveal'}
              </button>
              {revealed && data.mcp_token && (
                <button
                  type="button"
                  onClick={() => copy('token', data.mcp_token)}
                  className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-accent"
                >
                  <Copy className="size-3" /> Copy
                </button>
              )}
            </div>
          )}
        />
      </section>

      <section className="mt-6">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Claude Desktop / Claude Code config
        </div>
        <CodeBlock value={claudeDesktopConfig} onCopy={() => copy('config', claudeDesktopConfig)} />
        <p className="mt-1 text-[11px] text-muted-foreground">
          Drop this snippet into your MCP client config and restart the client.
          See the Deft docs for runtime-specific setup.
        </p>
      </section>
    </div>
  );
}

function Field({
  label,
  value,
  onCopy,
  mono,
  trailing,
}: {
  label: string;
  value: string;
  onCopy?: () => void;
  mono?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-12 gap-2 items-center">
      <div className="col-span-3 text-xs text-muted-foreground">{label}</div>
      <div className={`col-span-${trailing ? 6 : 9} rounded border border-border bg-background px-2 py-1.5 text-xs ${mono ? 'font-mono' : ''} truncate`}>
        {value}
      </div>
      {trailing
        ? <div className="col-span-3">{trailing}</div>
        : onCopy ? (
          <div className="col-span-0">
            <button
              type="button"
              onClick={onCopy}
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-accent"
            >
              <Copy className="size-3" />
            </button>
          </div>
        ) : null}
    </div>
  );
}

function CodeBlock({ value, onCopy }: { value: string; onCopy?: () => void }) {
  return (
    <div className="relative rounded border border-border bg-background p-3 font-mono text-[11px] overflow-x-auto">
      <pre className="whitespace-pre-wrap break-all">{value}</pre>
      {onCopy && (
        <button
          type="button"
          onClick={onCopy}
          className="absolute top-2 right-2 rounded border border-border bg-card p-1 hover:bg-accent"
          aria-label="Copy"
        >
          <Copy className="size-3" />
        </button>
      )}
    </div>
  );
}
