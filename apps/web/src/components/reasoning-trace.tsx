/**
 * Block 1.10 — reasoning trace expander.
 *
 * Renders an "expandable tree" of tool → input → result → next tool for
 * an OpenClaw agent response. Events arrive over Socket.io via
 * useReasoningTrace; this component renders them collapsed by default.
 */
'use client';
import { useState } from 'react';
import { ChevronRight, ChevronDown, Wrench, MessageSquare } from 'lucide-react';
import type { TraceEvent } from '@/hooks/use-reasoning-trace';

type Props = {
  events: TraceEvent[];
  defaultOpen?: boolean;
};

export function ReasoningTrace({ events, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  if (events.length === 0) return null;

  return (
    <div className="mt-2 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-muted-foreground hover:bg-accent"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <span>{open ? 'Hide' : 'Show'} trace ({events.length} event{events.length === 1 ? '' : 's'})</span>
      </button>
      {open && (
        <ol className="mt-2 space-y-2 border-l border-border pl-3">
          {events.map((evt, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="mt-0.5 text-muted-foreground">
                {evt.kind === 'session.tool'
                  ? <Wrench className="size-3" />
                  : <MessageSquare className="size-3" />}
              </span>
              <div className="flex-1 min-w-0">
                <div className={`font-medium ${evt.kind === 'session.tool' ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {renderLabel(evt)}
                </div>
                <pre className="mt-0.5 whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
                  {formatPayload(evt.payload)}
                </pre>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function renderLabel(evt: TraceEvent): string {
  if (evt.kind === 'session.tool') {
    const name = typeof evt.payload.tool_name === 'string' ? evt.payload.tool_name
      : typeof evt.payload.name === 'string' ? evt.payload.name
      : 'tool';
    return `Tool: ${name}`;
  }
  const role = typeof evt.payload.role === 'string' ? evt.payload.role : 'message';
  return `Message: ${role}`;
}

function formatPayload(payload: Record<string, unknown>): string {
  const keysToDrop = new Set(['sessionId']);
  const filtered = Object.fromEntries(
    Object.entries(payload).filter(([k]) => !keysToDrop.has(k)),
  );
  try {
    const str = JSON.stringify(filtered, null, 2);
    return str.length > 800 ? `${str.slice(0, 800)}…` : str;
  } catch {
    return String(filtered);
  }
}
