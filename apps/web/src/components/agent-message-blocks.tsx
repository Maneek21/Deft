'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatToolLabel } from '@/lib/tool-display';
import { normalizeAgentCitations, type AgentCitation } from '@/lib/agent-citations';

export type { AgentCitation } from '@/lib/agent-citations';

export type AgentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input?: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

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
  const [showAllCitations, setShowAllCitations] = useState(false);
  const toolUses = (blocks ?? []).filter(
    (b): b is Extract<AgentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
  );

  const citationSources = normalizeAgentCitations(citations);

  const showTokensFooter = !!model || tokens_in != null || tokens_out != null;
  const hasCitations = citationSources.length > 0;

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
        <div className="mt-2.5" aria-label="Sources">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--on-surface-variant)' }}>Sources</div>
          <div className="flex flex-wrap gap-1.5">
            {(showAllCitations ? citationSources : citationSources.slice(0, 5)).map((c) => {
              const href = c.href;
              const label = c.title.length > 40 ? c.title.slice(0, 40) + '...' : c.title;
              const className = "px-2 py-0.5 rounded-full text-[11px] font-medium hover:opacity-80 transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2";
              const style = { background: 'var(--bg-active)', color: 'var(--text-secondary)' };
              const key = `${c.id}:${href ?? ''}`;
              return href
                ? <a key={key} href={href} title={c.title} className={className} style={style}>{label}</a>
                : <span key={key} title={c.title} className={className} style={style}>{label}</span>;
            })}
            {citationSources.length > 5 && (
              <button type="button" onClick={() => setShowAllCitations(value => !value)} aria-expanded={showAllCitations}
                className="px-2 py-0.5 rounded-md text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                {showAllCitations ? 'Show fewer sources' : `+${citationSources.length - 5} more`}
              </button>
            )}
          </div>
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
