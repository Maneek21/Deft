'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatToolLabel } from '@/lib/tool-display';

export type AgentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input?: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export type AgentCitation = {
  type: 'task' | 'message' | 'wiki' | 'event' | 'mcp' | string;
  id: string;
  title: string;
  url?: string;
};

export type AgentMessageBlocksProps = {
  blocks?: AgentBlock[] | null;
  citations?: AgentCitation[] | null;
  model?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
};

function ToolUseChip({ block }: { block: Extract<AgentBlock, { type: 'tool_use' }> }) {
  const [open, setOpen] = useState(false);
  const label = formatToolLabel(block.name);

  return (
    <div className="inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="px-2 py-1 rounded-full text-[11px] font-medium inline-flex items-center gap-1"
        style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}
      >
        {open ? <ChevronDown size={12} strokeWidth={1.5} /> : <ChevronRight size={12} strokeWidth={1.5} />}
        💬 {label}
      </button>
      {open && block.input && (
        <pre
          className="mt-1.5 ml-2 text-[10px] font-mono whitespace-pre-wrap p-2 rounded overflow-auto"
          style={{ color: 'var(--text-secondary)', background: 'var(--surface-container)', maxWidth: '100%' }}
        >
          {JSON.stringify(block.input, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function AgentMessageBlocks({
  blocks,
  citations,
  model,
  tokens_in,
  tokens_out,
}: AgentMessageBlocksProps) {
  const toolUses = (blocks ?? []).filter(
    (b): b is Extract<AgentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
  );

  // Filter citations like agent-chat.tsx does
  const filteredCitations = (citations ?? [])
    .filter((c) => c.type !== 'mcp') // tool_calls render handles these
    .filter((c) => !c.title.includes(',')) // Remove DM-style "Maneek, Rahul" citations
    .filter((c, ci, arr) => arr.findIndex((x) => x.id === c.id) === ci); // dedupe

  const showTokensFooter = !!model || tokens_in != null || tokens_out != null;
  const hasCitations = filteredCitations.length > 0;

  if (toolUses.length === 0 && !hasCitations && !showTokensFooter) return null;

  return (
    <div className="agent-message-blocks">
      {/* Tool-use chips with collapsible input */}
      {toolUses.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2.5">
          {toolUses.map((b) => (
            <ToolUseChip key={b.id} block={b} />
          ))}
        </div>
      )}

      {/* Citations footer */}
      {hasCitations && (
        <div className="flex flex-wrap gap-1.5 mt-2.5">
          {filteredCitations.slice(0, 5).map((c, ci) => (
            <button
              key={ci}
              className="px-2 py-0.5 rounded-full text-[11px] font-medium cursor-pointer hover:opacity-80 transition-opacity"
              style={{ background: 'var(--bg-active)', color: 'var(--text-secondary)' }}
            >
              {c.type === 'task' ? '📋 ' : '💬 '}
              {c.title.length > 40 ? c.title.slice(0, 40) + '...' : c.title}
            </button>
          ))}
          {filteredCitations.length > 5 && (
            <button
              className="px-2 py-0.5 rounded-md text-[10px]"
              style={{ color: 'var(--outline)' }}
            >
              +{filteredCitations.length - 5} more
            </button>
          )}
        </div>
      )}

      {/* Model + tokens detail expander */}
      {showTokensFooter && (
        <div className="mt-1 text-[10px]" style={{ color: 'var(--outline)', fontFamily: 'var(--font-mono)' }}>
          {model && model.replace('claude-', '').replace(/-\d+$/, '')}
          {model && (tokens_in != null || tokens_out != null) && ' · '}
          {(tokens_in != null || tokens_out != null) && `${(tokens_in ?? 0) + (tokens_out ?? 0)} tokens`}
        </div>
      )}
    </div>
  );
}
