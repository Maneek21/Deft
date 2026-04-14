'use client';
/**
 * Phase 10 — SessionTurnCard.
 *
 * Renders a single row of the employee session inspector. The collapsed
 * state is a one-line header (result pill + trigger_kind + latency + age).
 * The expanded state shows accordions for:
 *   - Input messages   (OpenAI-compatible messages array)
 *   - Tool calls       (tool_use blocks with input + output)
 *   - Reply text       (raw_reply_text rendered as <pre>)
 *   - Metrics          (model, tokens, cost, latency, status, error)
 *   - Linked receipt   (iff the parent passes receiptAvailable/onViewReceipt)
 *
 * This component is deliberately presentational — the parent drawer owns
 * data fetching, pagination, and filters. That keeps the card re-usable in
 * future surfaces (e.g. a per-employee detail page).
 */
import { useState } from 'react';

export type SessionTurn = {
  id: string;
  trigger_kind: string;
  triggering_message_id?: string | null;
  space_id: string | null;
  input_messages_json: unknown;
  tool_calls_json: unknown;
  raw_reply_text: string | null;
  latency_ms: number;
  model_name: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  result: 'success' | 'timeout' | 'error' | 'rejected_approval' | string;
  error: string | null;
  created_at: string;
};

type Tab = 'messages' | 'tools' | 'reply' | 'metrics';

type Props = {
  turn: SessionTurn;
  expanded: boolean;
  onToggle: () => void;
  /** Cost in USD; null if model not priced. */
  costUsd?: number | null;
  /** Hide the "View receipt" button unless this is true. */
  receiptAvailable?: boolean;
  onViewReceipt?: () => void;
};

const RESULT_STYLES: Record<
  string,
  { bg: string; fg: string; label: string }
> = {
  success: { bg: 'rgba(16,185,129,0.15)', fg: '#10b981', label: 'success' },
  timeout: { bg: 'rgba(234,179,8,0.15)', fg: '#eab308', label: 'timeout' },
  error: { bg: 'rgba(239,68,68,0.15)', fg: '#ef4444', label: 'error' },
  rejected_approval: {
    bg: 'rgba(148,163,184,0.18)',
    fg: '#94a3b8',
    label: 'rejected',
  },
};

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatCost(cost: number | null | undefined): string {
  if (cost == null) return '—';
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(3)}`;
}

type MessageShape = { role?: string; content?: unknown };

function renderMessages(input: unknown): MessageShape[] {
  if (Array.isArray(input)) return input as MessageShape[];
  // Some storage paths stringify the jsonb field; be tolerant.
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (Array.isArray(parsed)) return parsed as MessageShape[];
    } catch {
      /* ignore */
    }
  }
  return [];
}

function messageContentToString(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

type ToolCallShape = {
  type?: string;
  name?: string;
  tool_name?: string;
  input?: unknown;
  output?: unknown;
  result?: unknown;
  error?: unknown;
};

function renderToolCalls(input: unknown): ToolCallShape[] {
  if (Array.isArray(input)) return input as ToolCallShape[];
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (Array.isArray(parsed)) return parsed as ToolCallShape[];
    } catch {
      /* ignore */
    }
  }
  return [];
}

export function SessionTurnCard({
  turn,
  expanded,
  onToggle,
  costUsd,
  receiptAvailable,
  onViewReceipt,
}: Props) {
  const [tab, setTab] = useState<Tab>('messages');

  const resultStyle =
    RESULT_STYLES[turn.result] ?? {
      bg: 'rgba(148,163,184,0.18)',
      fg: 'var(--muted)',
      label: turn.result,
    };

  const messages = renderMessages(turn.input_messages_json);
  const toolCalls = renderToolCalls(turn.tool_calls_json);

  return (
    <div
      className="rounded px-2.5 py-2 text-[11px]"
      style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
      data-testid={`session-turn-${turn.id}`}
    >
      {/* Collapsed header row */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 text-left"
        data-testid={`turn-row-${turn.id}`}
        aria-expanded={expanded}
      >
        <span
          className="px-1.5 py-0.5 rounded text-[9px] font-medium"
          style={{ background: resultStyle.bg, color: resultStyle.fg }}
          data-testid={`turn-result-${turn.id}`}
        >
          {resultStyle.label}
        </span>
        <span
          className="font-mono text-[10px]"
          style={{ color: 'var(--foreground)' }}
        >
          {turn.trigger_kind}
        </span>
        <span className="flex-1" />
        <span style={{ color: 'var(--muted)' }}>{turn.latency_ms}ms</span>
        {(turn.tokens_in != null || turn.tokens_out != null) && (
          <span style={{ color: 'var(--muted)' }}>
            {turn.tokens_in ?? 0} / {turn.tokens_out ?? 0}
          </span>
        )}
        <span style={{ color: 'var(--muted)' }}>
          {formatRelative(turn.created_at)}
        </span>
        <span
          style={{ color: 'var(--muted)', fontSize: 11, transition: 'transform 0.2s' }}
          className={expanded ? 'rotate-90' : ''}
        >
          ▸
        </span>
      </button>

      {/* Expanded body */}
      {expanded && (
        <div
          className="mt-2 pt-2 border-t"
          style={{ borderColor: 'var(--border)' }}
          data-testid={`turn-expanded-${turn.id}`}
        >
          {/* Tabs */}
          <div className="flex gap-1 mb-2">
            {(['messages', 'tools', 'reply', 'metrics'] as Tab[]).map((t) => {
              const active = tab === t;
              return (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className="px-2 py-0.5 rounded text-[10px] font-medium"
                  style={{
                    background: active ? 'var(--accent)' : 'var(--surface-container)',
                    color: active ? 'white' : 'var(--foreground-secondary)',
                    border: '1px solid var(--border)',
                  }}
                  data-testid={`turn-tab-${t}-${turn.id}`}
                >
                  {t === 'messages'
                    ? `Input (${messages.length})`
                    : t === 'tools'
                      ? `Tools (${toolCalls.length})`
                      : t === 'reply'
                        ? 'Reply'
                        : 'Metrics'}
                </button>
              );
            })}
          </div>

          {tab === 'messages' && (
            <div className="space-y-1.5">
              {messages.length === 0 ? (
                <p style={{ color: 'var(--muted)' }}>No input messages recorded.</p>
              ) : (
                messages.map((m, i) => {
                  const role = m?.role ?? 'unknown';
                  const content = messageContentToString(m?.content);
                  const isSystem = role === 'system';
                  return (
                    <div
                      key={i}
                      className="rounded p-2"
                      style={{
                        background: 'var(--surface-container)',
                        border: '1px solid var(--border)',
                      }}
                    >
                      <span
                        className="text-[9px] font-medium uppercase tracking-wide"
                        style={{ color: 'var(--muted)' }}
                      >
                        {role}
                      </span>
                      <pre
                        className="text-[10px] whitespace-pre-wrap mt-1"
                        style={{
                          color: 'var(--foreground-secondary, var(--foreground))',
                          fontFamily: isSystem
                            ? 'var(--font-mono, monospace)'
                            : 'inherit',
                          maxHeight: 240,
                          overflowY: 'auto',
                        }}
                      >
                        {content || '(empty)'}
                      </pre>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {tab === 'tools' && (
            <div className="space-y-1.5">
              {toolCalls.length === 0 ? (
                <p style={{ color: 'var(--muted)' }}>No tool calls recorded.</p>
              ) : (
                toolCalls.map((tc, i) => (
                  <ToolCallBlock key={i} call={tc} />
                ))
              )}
            </div>
          )}

          {tab === 'reply' && (
            <>
              {turn.raw_reply_text ? (
                <pre
                  className="text-[10px] whitespace-pre-wrap p-2 rounded"
                  style={{
                    background: 'var(--surface-container)',
                    color: 'var(--foreground-secondary)',
                    maxHeight: 320,
                    overflowY: 'auto',
                  }}
                >
                  {turn.raw_reply_text}
                </pre>
              ) : (
                <p style={{ color: 'var(--muted)' }}>(no reply text)</p>
              )}
            </>
          )}

          {tab === 'metrics' && (
            <table className="w-full text-[10px]">
              <tbody>
                <MetricRow label="model" value={turn.model_name ?? '—'} />
                <MetricRow label="tokens in" value={String(turn.tokens_in ?? '—')} />
                <MetricRow label="tokens out" value={String(turn.tokens_out ?? '—')} />
                <MetricRow label="cost" value={formatCost(costUsd)} />
                <MetricRow label="latency" value={`${turn.latency_ms}ms`} />
                <MetricRow
                  label="result"
                  value={turn.result}
                  valueColor={resultStyle.fg}
                />
                {turn.error && (
                  <MetricRow label="error" value={turn.error} valueColor="#ef4444" />
                )}
              </tbody>
            </table>
          )}

          {/* Linked receipt */}
          {receiptAvailable && onViewReceipt && (
            <button
              onClick={onViewReceipt}
              className="mt-3 text-[10px] px-2 py-1 rounded"
              style={{
                background: 'var(--surface-container)',
                color: 'var(--foreground-secondary)',
                border: '1px solid var(--border)',
              }}
              data-testid={`turn-view-receipt-${turn.id}`}
            >
              View receipt
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function MetricRow({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <tr>
      <td
        className="py-0.5 pr-3 uppercase tracking-wide"
        style={{ color: 'var(--muted)', width: 80 }}
      >
        {label}
      </td>
      <td
        className="py-0.5 font-mono"
        style={{ color: valueColor ?? 'var(--foreground)' }}
      >
        {value}
      </td>
    </tr>
  );
}

function ToolCallBlock({ call }: { call: ToolCallShape }) {
  const [showInput, setShowInput] = useState(false);
  const [showOutput, setShowOutput] = useState(false);
  const name = call.name ?? call.tool_name ?? 'tool';
  const hasError = Boolean(call.error);
  const fg = hasError ? '#ef4444' : '#10b981';
  return (
    <div
      className="rounded p-2"
      style={{
        background: 'var(--surface-container)',
        border: `1px solid ${hasError ? 'rgba(239,68,68,0.35)' : 'var(--border)'}`,
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className="text-[9px] font-medium"
          style={{ color: fg, fontFamily: 'var(--font-mono, monospace)' }}
        >
          {name}
        </span>
        <span className="flex-1" />
        <button
          onClick={() => setShowInput((v) => !v)}
          className="text-[9px]"
          style={{ color: 'var(--muted)' }}
        >
          {showInput ? 'hide input' : 'input'}
        </button>
        <button
          onClick={() => setShowOutput((v) => !v)}
          className="text-[9px]"
          style={{ color: 'var(--muted)' }}
        >
          {showOutput ? 'hide output' : 'output'}
        </button>
      </div>
      {showInput && (
        <pre
          className="text-[9px] mt-1 p-1.5 rounded whitespace-pre-wrap"
          style={{
            background: 'var(--surface)',
            color: 'var(--foreground-secondary)',
            maxHeight: 160,
            overflowY: 'auto',
          }}
        >
          {JSON.stringify(call.input ?? {}, null, 2)}
        </pre>
      )}
      {showOutput && (
        <pre
          className="text-[9px] mt-1 p-1.5 rounded whitespace-pre-wrap"
          style={{
            background: 'var(--surface)',
            color: 'var(--foreground-secondary)',
            maxHeight: 160,
            overflowY: 'auto',
          }}
        >
          {JSON.stringify(call.output ?? call.result ?? call.error ?? {}, null, 2)}
        </pre>
      )}
    </div>
  );
}
