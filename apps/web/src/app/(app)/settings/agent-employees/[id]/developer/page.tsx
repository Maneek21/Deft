/**
 * Developer tab — BYOA credentials.
 *
 * Surfaces the MCP endpoint URL + bearer token state for a single agent-employee
 * so the user can wire up Claude Desktop, Claude Code, or a custom MCP
 * client. Raw tokens are shown once at creation or regeneration.
 */
'use client';
import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Check, Copy, Loader2, Play, RefreshCw, RotateCcw, Terminal, X } from 'lucide-react';

type DeveloperPayload = {
  employee: {
    id: string;
    slug: string;
    name?: string;
    runtime_kind?: string | null;
    job_title?: string | null;
    wake_mode?: string | null;
    certification_status?: string | null;
    last_verified_at?: string | null;
    last_mcp_call_at?: string | null;
    last_work_outcome_at?: string | null;
    connection_notes?: string | null;
    last_heartbeat_at?: string | null;
    is_byoa?: boolean;
    byoa_model_info?: string | null;
  };
  certification: {
    id: string;
    status: string;
    nonce: string;
    required_tools: string[];
    failure_reason?: string | null;
    started_at: string;
    completed_at?: string | null;
    instructions: string;
    stages?: Array<{
      key: string;
      label: string;
      status: 'pass' | 'pending';
      detail: string;
    }>;
  } | null;
  runtime_setup: {
    runtime_kind: string;
    tool_server_name: string | null;
    channel_protocol_version: string;
    channel_capabilities: string[];
    integration_version: string | null;
    integration_bundle_url: string | null;
    mcp_endpoint_url: string;
    channel_endpoint_url: string;
    tool_name_style: 'bare' | 'server_prefixed';
    tool_call_names: string[];
    setup_steps: string[];
    commands: Array<{
      label: string;
      command: string;
      description: string;
    }>;
    config_snippet: string | null;
    bridge_script: string | null;
    certification_prompt: string;
    troubleshooting: string[];
  };
  diagnostics: {
    recent_mcp_calls: Array<{
      id: string;
      tool_name: string;
      success: boolean;
      error?: string | null;
      created_at: string;
    }>;
    recent_cooperative_log: Array<{
      id: string;
      kind: string;
      summary: string;
      created_at: string;
    }>;
    recent_channel_events: Array<{
      id: string;
      kind: string;
      status: string;
      source_kind?: string | null;
      source_id?: string | null;
      delivery_count: number;
      claim_owner?: string | null;
      lease_expires_at?: string | null;
      work_outcome?: string | null;
      outcome_detail?: string | null;
      outcome_at?: string | null;
      error?: string | null;
      created_at: string;
      updated_at: string;
    }>;
    activity: Array<{
      id: string;
      kind: 'delivery' | 'action' | 'tool_call' | 'session' | 'record';
      label: string;
      status: 'queued' | 'running' | 'approval_pending' | 'completed' | 'failed' | 'cancelled';
      detail?: string | null;
      occurred_at: string;
      target_url?: string | null;
      error?: string | null;
    }>;
  };
  mcp_endpoint_url: string;
  mcp_token_masked: string | null;
  mcp_token: string | null;
  channel_endpoint_url: string;
  channel_token_masked: string | null;
  channel_token: string | null;
  channel: {
    protocol_version: string;
    connection: {
      status: string;
      runtime_kind: string;
      protocol_version: string;
      last_seen_at?: string | null;
      last_event_id?: string | null;
      last_error?: string | null;
    } | null;
    token: {
      token_prefix: string;
      last_used_at?: string | null;
      created_at: string;
    } | null;
    queue: {
      pending: number;
      delivered: number;
      completed: number;
      failed: number;
      cancelled: number;
    };
    metrics: {
      sample_count: number;
      delivery: { p50_ms: number | null; p95_ms: number | null };
      acknowledgement: { p50_ms: number | null; p95_ms: number | null };
      completion: { p50_ms: number | null; p95_ms: number | null };
      oldest_open_age_ms: number | null;
    };
    recovery: {
      state: 'healthy' | 'setup_required' | 'offline' | 'delivery_failed' | 'backlogged';
      title: string;
      detail: string;
      action: 'none' | 'regenerate_channel_token' | 'send_channel_test' | 'inspect_queue';
    };
  };
};

type RegeneratePayload = {
  api_key: string;
  mcp_endpoint_url: string;
  employee: { id: string; slug: string; name?: string };
};

type RegenerateChannelPayload = {
  channel_key: string;
  channel_endpoint_url: string;
  channel_token_prefix: string;
  employee: { id: string; slug: string; name?: string };
};

export default function DeveloperPage() {
  const params = useParams();
  const router = useRouter();
  const employeeId = String(params?.id ?? '');
  const [data, setData] = useState<DeveloperPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [newChannelToken, setNewChannelToken] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regeneratingChannel, setRegeneratingChannel] = useState(false);
  const [copyHint, setCopyHint] = useState<string | null>(null);
  const [certBusy, setCertBusy] = useState(false);
  const [certResult, setCertResult] = useState<string | null>(null);
  const [channelTestBusy, setChannelTestBusy] = useState(false);
  const [queueBusy, setQueueBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.fetch(`/api/agent-employees/${employeeId}/developer`);
      if (!res.ok) {
        if (res.status === 403) {
          setError('Only org admins can view developer credentials.');
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

  useEffect(() => { load(); }, [load]);

  const regenerateToken = async () => {
    setRegenerating(true);
    setError(null);
    try {
      const res = await api.post(`/api/agent-employees/${employeeId}/regenerate-token`);
      if (!res.ok) {
        if (res.status === 403) {
          setError('Only org owners or admins can regenerate this token.');
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const payload = (await res.json()) as RegeneratePayload;
      setNewToken(payload.api_key);
      setData((current) => current
        ? { ...current, mcp_endpoint_url: payload.mcp_endpoint_url, mcp_token_masked: '********' }
        : current);
      setCopyHint('New token generated. Copy it now.');
      setTimeout(() => setCopyHint(null), 2500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRegenerating(false);
    }
  };

  const regenerateChannelToken = async () => {
    setRegeneratingChannel(true);
    setError(null);
    try {
      const res = await api.post(`/api/agent-employees/${employeeId}/regenerate-channel-token`);
      if (!res.ok) {
        if (res.status === 403) {
          setError('Only org owners, admins, or the employee creator can regenerate this channel token.');
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const payload = (await res.json()) as RegenerateChannelPayload;
      setNewChannelToken(payload.channel_key);
      setData((current) => current
        ? {
            ...current,
            channel_endpoint_url: payload.channel_endpoint_url,
            channel_token_masked: `${payload.channel_token_prefix}********`,
          }
        : current);
      setCopyHint('New channel token generated. Copy it now.');
      setTimeout(() => setCopyHint(null), 2500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRegeneratingChannel(false);
    }
  };

  const certificationAction = async (action: 'start' | 'check' | 'reset') => {
    setCertBusy(true);
    setCertResult(null);
    setError(null);
    try {
      const res = await api.post(`/api/agent-employees/${employeeId}/certification/${action}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      if (action === 'check') {
        const missing = payload.missing_tools?.length ? ` Missing: ${payload.missing_tools.join(', ')}.` : '';
        const reason = payload.failure_reason ? ` ${payload.failure_reason}` : '';
        setCertResult(payload.completed ? 'Certification complete.' : `Still pending.${missing}${reason}`);
      } else if (action === 'start') {
        setCertResult('Certification challenge started.');
      } else {
        setCertResult('Certification reset.');
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCertBusy(false);
    }
  };

  const startChannelTest = async () => {
    setChannelTestBusy(true);
    setError(null);
    setCertResult(null);
    try {
      const res = await api.post(`/api/agent-employees/${employeeId}/channel-test/start`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      setCertResult(`Channel test event queued. Nonce: ${payload.nonce}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChannelTestBusy(false);
    }
  };

  const controlDelivery = async (eventId: string, action: 'retry' | 'cancel') => {
    setQueueBusy(eventId);
    setError(null);
    try {
      const res = await api.post(`/api/agent-employees/${employeeId}/channel-events/${eventId}/${action}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setQueueBusy(null);
    }
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

  const tokenForConfig = newToken ?? '<bearer-token>';
  const channelTokenForConfig = newChannelToken ?? '<channel-token>';
  const connectionLabel = data.employee.last_heartbeat_at
    ? `Last ping ${new Date(data.employee.last_heartbeat_at).toLocaleString()}`
    : 'Never connected';
  const channelConnectionLabel = data.channel.connection?.last_seen_at
    ? `${data.channel.connection.status} - last seen ${new Date(data.channel.connection.last_seen_at).toLocaleString()}`
    : data.channel.token
      ? 'Token issued, not connected yet'
      : 'No channel token issued';

  const claudeDesktopConfig = JSON.stringify(
    {
      mcpServers: {
        deft: {
          url: data.mcp_endpoint_url,
          headers: {
            Authorization: `Bearer ${tokenForConfig}`,
          },
        },
      },
    },
    null,
    2,
  );
  const agentChannelQuickConfig = [
    `DEFT_CHANNEL_URL=${data.channel_endpoint_url}`,
    `DEFT_CHANNEL_TOKEN=${channelTokenForConfig}`,
    `DEFT_MCP_URL=${data.mcp_endpoint_url}`,
    `DEFT_MCP_TOKEN=${tokenForConfig}`,
    `DEFT_EMPLOYEE_SLUG=${data.employee.slug}`,
    ...(data.runtime_setup.runtime_kind === 'hermes'
      ? [
          'HERMES_API_URL=http://127.0.0.1:8642',
          'HERMES_API_KEY=<hermes-api-key>',
          `HERMES_API_MODEL=${data.employee.name ?? 'hermes-agent'}`,
        ]
      : []),
  ].join('\n');

  return (
    <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden">
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
      {certResult && (
        <div className="mb-3 rounded bg-accent/60 px-3 py-1.5 text-xs">{certResult}</div>
      )}
      {error && <div className="mb-3 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">{error}</div>}

      <div className={`mb-4 rounded border px-3 py-2 text-xs ${data.channel.recovery.state === 'healthy' ? 'border-emerald-500/25 bg-emerald-500/10' : 'border-amber-500/30 bg-amber-500/10'}`}>
        <div className="font-medium">{data.channel.recovery.title}</div>
        <div className="mt-0.5 text-muted-foreground">{data.channel.recovery.detail}</div>
        {data.channel.recovery.action === 'regenerate_channel_token' && (
          <button type="button" onClick={regenerateChannelToken} className="mt-2 rounded border border-border px-2 py-1 hover:bg-accent">Generate token</button>
        )}
        {data.channel.recovery.action === 'send_channel_test' && (
          <button type="button" onClick={startChannelTest} className="mt-2 rounded border border-border px-2 py-1 hover:bg-accent">Send test event</button>
        )}
      </div>

      <section className="space-y-3">
        <Field
          label="Employee slug"
          value={data.employee.slug}
          onCopy={() => copy('slug', data.employee.slug)}
        />
        <Field
          label="Last runtime signal"
          value={connectionLabel}
        />
        <Field
          label="Runtime"
          value={`${data.employee.runtime_kind ?? 'custom_mcp'} / ${data.employee.wake_mode ?? 'manual'}`}
        />
        <Field
          label="Job title"
          value={data.employee.job_title ?? '(not set)'}
        />
        <Field
          label="Certification"
          value={`${data.employee.certification_status ?? 'token_issued'}${data.employee.last_verified_at ? ` at ${new Date(data.employee.last_verified_at).toLocaleString()}` : ''}`}
        />
        <Field
          label="MCP endpoint URL"
          value={data.mcp_endpoint_url}
          onCopy={() => copy('URL', data.mcp_endpoint_url)}
          mono
        />
        <Field
          label="Bearer token"
          value={newToken ?? (data.mcp_token_masked ?? '(no token yet)')}
          mono
          trailing={(
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={regenerateToken}
                disabled={regenerating}
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-accent"
              >
                {regenerating ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                Regenerate
              </button>
              {newToken && (
                <button
                  type="button"
                  onClick={() => copy('token', newToken)}
                  className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-accent"
                >
                  <Copy className="size-3" /> Copy
                </button>
              )}
            </div>
          )}
        />
        <Field
          label="Channel endpoint URL"
          value={data.channel_endpoint_url}
          onCopy={() => copy('channel URL', data.channel_endpoint_url)}
          mono
        />
        <Field
          label="Channel token"
          value={newChannelToken ?? (data.channel_token_masked ?? '(no channel token yet)')}
          mono
          trailing={(
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={regenerateChannelToken}
                disabled={regeneratingChannel}
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-accent"
              >
                {regeneratingChannel ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                Regenerate
              </button>
              {newChannelToken && (
                <button
                  type="button"
                  onClick={() => copy('channel token', newChannelToken)}
                  className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-accent"
                >
                  <Copy className="size-3" /> Copy
                </button>
              )}
            </div>
          )}
        />
        <Field
          label="Channel transport"
          value={`${channelConnectionLabel} - pending ${data.channel.queue.pending} - failed ${data.channel.queue.failed}`}
        />
        <Field
          label="Channel latency"
          value={`${data.channel.metrics.sample_count} samples - deliver ${formatMs(data.channel.metrics.delivery.p50_ms)}/${formatMs(data.channel.metrics.delivery.p95_ms)} p50/p95 - complete ${formatMs(data.channel.metrics.completion.p50_ms)}/${formatMs(data.channel.metrics.completion.p95_ms)}`}
        />
        <div className="grid grid-cols-12 gap-2 items-center">
          <div className="col-span-3 text-xs text-muted-foreground">Channel test</div>
          <div className="col-span-9">
            <button
              type="button"
              onClick={startChannelTest}
              disabled={channelTestBusy}
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
            >
              {channelTestBusy ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
              Send test event
            </button>
          </div>
        </div>
      </section>

      <section className="mt-6">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Certification
          </div>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => certificationAction('start')}
              disabled={certBusy}
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
            >
              {certBusy ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
              Start
            </button>
            <button
              type="button"
              onClick={() => certificationAction('check')}
              disabled={certBusy}
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
            >
              <Check className="size-3" />
              Check
            </button>
            <button
              type="button"
              onClick={() => certificationAction('reset')}
              disabled={certBusy}
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
            >
              <RotateCcw className="size-3" />
              Reset
            </button>
          </div>
        </div>
        {data.certification ? (
          <>
            <Field label="Challenge status" value={data.certification.status} />
            {data.certification.failure_reason && (
              <Field label="Current blocker" value={data.certification.failure_reason} />
            )}
            <Field label="Nonce" value={data.certification.nonce} onCopy={() => copy('nonce', data.certification?.nonce)} mono />
            {data.certification.stages && data.certification.stages.length > 0 && (
              <StageList stages={data.certification.stages} />
            )}
            <CodeBlock value={data.certification.instructions} onCopy={() => copy('instructions', data.certification?.instructions)} />
          </>
        ) : (
          <div className="rounded border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            No challenge started yet.
          </div>
        )}
      </section>

      <section className="mt-6">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Runtime setup
        </div>
        <div className="rounded border border-border bg-background px-3 py-2">
          <div className="text-xs font-medium">
            {data.runtime_setup.runtime_kind}
            {data.runtime_setup.tool_server_name ? ` / ${data.runtime_setup.tool_server_name}` : ''}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            Tool names: {data.runtime_setup.tool_call_names.join(', ')}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            Agent Channel: {data.runtime_setup.channel_protocol_version}
          </div>
          {data.runtime_setup.integration_version && (
            <div className="mt-1 text-[11px] text-muted-foreground">
              Matched Hermes integration: {data.runtime_setup.integration_version}
            </div>
          )}
          <ol className="mt-3 list-decimal space-y-1 pl-4 text-xs">
            {data.runtime_setup.setup_steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
        {data.runtime_setup.config_snippet && (
          <div className="mt-3">
            <div className="mb-1 text-xs text-muted-foreground">Runtime config snippet</div>
            <CodeBlock value={data.runtime_setup.config_snippet} onCopy={() => copy('runtime config', data.runtime_setup.config_snippet)} />
          </div>
        )}
        {data.runtime_setup.commands.length > 0 && (
          <div className="mt-3 space-y-3">
            {data.runtime_setup.commands.map((cmd) => (
              <div key={cmd.label}>
                <div className="mb-1 text-xs font-medium">{cmd.label}</div>
                <div className="mb-1 text-[11px] text-muted-foreground">{cmd.description}</div>
                <CodeBlock value={cmd.command} onCopy={() => copy(cmd.label, cmd.command)} />
              </div>
            ))}
          </div>
        )}
        {data.runtime_setup.certification_prompt && (
          <div className="mt-3">
            <div className="mb-1 text-xs text-muted-foreground">Certification prompt</div>
            <p className="mb-1 text-[11px] text-muted-foreground">
              Deft sends this prompt through Agent Channel during certification. Paste it manually only when diagnosing the model loop.
            </p>
            <CodeBlock
              value={data.runtime_setup.certification_prompt}
              onCopy={() => copy('certification prompt', data.runtime_setup.certification_prompt)}
            />
          </div>
        )}
        {data.runtime_setup.bridge_script && (
          <div className="mt-3">
            <div className="mb-1 text-xs text-muted-foreground">Hermes stdio bridge script</div>
            <CodeBlock value={data.runtime_setup.bridge_script} onCopy={() => copy('Hermes bridge', data.runtime_setup.bridge_script)} />
          </div>
        )}
        {data.runtime_setup.troubleshooting.length > 0 && (
          <div className="mt-3 rounded border border-border bg-background px-3 py-2">
            <div className="mb-1 text-xs font-medium">Troubleshooting</div>
            <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
              {data.runtime_setup.troubleshooting.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
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

      <section className="mt-6">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Agent Channel quick config
        </div>
        <CodeBlock
          value={agentChannelQuickConfig}
          onCopy={() => copy('channel env', agentChannelQuickConfig)}
        />
        <p className="mt-1 text-[11px] text-muted-foreground">
          MCP is the tool surface. Agent Channel is the live inbox for DMs,
          mentions, task assignments, task comments, and task status changes.
          For Hermes, keep its authenticated API and the Deft channel bridge running.
        </p>
      </section>

      <section className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <LogPanel
            title="Agent activity"
            empty="No employee activity recorded yet."
            rows={data.diagnostics.activity.map((row) => ({
              id: row.id,
              main: `${row.status.replaceAll('_', ' ')} · ${row.label}`,
              sub: `${new Date(row.occurred_at).toLocaleString()}${row.detail ? ` · ${row.detail}` : ''}${row.error ? ` · ${row.error}` : ''}`,
            }))}
          />
        </div>
        <LogPanel
          title="Recent MCP calls"
          empty="No MCP calls recorded yet."
          rows={data.diagnostics.recent_mcp_calls.map((call) => ({
            id: call.id,
            main: `${call.success ? 'OK' : 'ERR'} ${call.tool_name}`,
            sub: `${new Date(call.created_at).toLocaleString()}${call.error ? ` - ${call.error}` : ''}`,
          }))}
        />
        <LogPanel
          title="Cooperative log"
          empty="No cooperative records yet."
          rows={data.diagnostics.recent_cooperative_log.map((row) => ({
            id: row.id,
            main: row.kind,
            sub: `${new Date(row.created_at).toLocaleString()} - ${row.summary}`,
          }))}
        />
        <LogPanel
          title="Channel events"
          empty="No channel events delivered yet."
          rows={data.diagnostics.recent_channel_events.map((row) => ({
            id: row.id,
            main: `${row.status}${row.work_outcome ? ` / ${row.work_outcome}` : ''} ${row.kind}`,
            sub: `${new Date(row.created_at).toLocaleString()} - delivery count ${row.delivery_count}${row.outcome_detail ? ` - ${row.outcome_detail}` : ''}${row.error ? ` - ${row.error}` : ''}`,
            actions: row.status === 'failed' || row.status === 'cancelled' ? (
              <button type="button" onClick={() => controlDelivery(row.id, 'retry')} disabled={queueBusy === row.id} className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-50">
                <RotateCcw className="size-3" /> Retry
              </button>
            ) : ['pending', 'delivered', 'acknowledged', 'running', 'approval_pending'].includes(row.status) ? (
              <button type="button" onClick={() => controlDelivery(row.id, 'cancel')} disabled={queueBusy === row.id} className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-50">
                <X className="size-3" /> Cancel
              </button>
            ) : undefined,
          }))}
        />
      </section>
    </div>
    </div>
  );
}

function StageList({
  stages,
}: {
  stages: Array<{ key: string; label: string; status: 'pass' | 'pending'; detail: string }>;
}) {
  return (
    <div className="my-3 rounded border border-border bg-background">
      {stages.map((stage) => (
        <div key={stage.key} className="grid grid-cols-12 gap-2 border-b border-border px-3 py-2 text-xs last:border-b-0">
          <div className="col-span-3 font-medium">{stage.label}</div>
          <div className={`col-span-2 ${stage.status === 'pass' ? 'text-emerald-600' : 'text-amber-600'}`}>
            {stage.status === 'pass' ? 'Pass' : 'Pending'}
          </div>
          <div className="col-span-7 text-muted-foreground">{stage.detail}</div>
        </div>
      ))}
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
  const valueClass = trailing ? 'col-span-6' : onCopy ? 'col-span-8' : 'col-span-9';
  return (
    <div className="grid grid-cols-12 gap-2 items-center">
      <div className="col-span-3 text-xs text-muted-foreground">{label}</div>
      <div className={`${valueClass} rounded border border-border bg-background px-2 py-1.5 text-xs ${mono ? 'font-mono' : ''} truncate`}>
        {value}
      </div>
      {trailing
        ? <div className="col-span-3">{trailing}</div>
        : onCopy ? (
          <div className="col-span-1">
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

function LogPanel({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: Array<{ id: string; main: string; sub: string; actions?: React.ReactNode }>;
}) {
  return (
    <div>
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="rounded border border-border bg-background">
        {rows.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">{empty}</div>
        ) : rows.map((row) => (
          <div key={row.id} className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 last:border-b-0">
            <div className="min-w-0">
              <div className="text-xs font-medium">{row.main}</div>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{row.sub}</div>
            </div>
            {row.actions}
          </div>
        ))}
      </div>
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

function formatMs(value: number | null) {
  if (value === null) return '--';
  if (value < 1_000) return `${value}ms`;
  return `${(value / 1_000).toFixed(1)}s`;
}
