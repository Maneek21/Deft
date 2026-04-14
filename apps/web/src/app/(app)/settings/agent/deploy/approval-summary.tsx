'use client';

/**
 * Phase 8 — Wizard step 7: Approval mapping summary.
 *
 * Read-only view of the inherited approval matrix. Task 58 standardized
 * this across all employees, so the wizard no longer offers per-tool
 * overrides here. Users can change trust levels post-deploy.
 */
const APPROVAL_MATRIX: Array<{
  tool: string;
  tier: 'auto' | 'quick' | 'full';
  description: string;
}> = [
  { tool: 'deft_platform_context', tier: 'auto', description: 'Read-only org state' },
  { tool: 'deft_memory_recall', tier: 'auto', description: 'Wiki search (read-only)' },
  { tool: 'deft_task_query', tier: 'auto', description: 'Task search (read-only)' },
  { tool: 'deft_member_list', tier: 'auto', description: 'Team roster' },
  { tool: 'deft_space_memory_get', tier: 'auto', description: 'Per-space KV read' },
  { tool: 'deft_events_query', tier: 'auto', description: 'External events feed (read-only)' },
  { tool: 'deft_memory_write', tier: 'quick', description: 'Create wiki page' },
  { tool: 'deft_memory_update', tier: 'quick', description: 'Edit wiki page' },
  { tool: 'deft_space_memory_set', tier: 'quick', description: 'Per-space KV write' },
  { tool: 'deft_task_create', tier: 'quick', description: 'Create task' },
  { tool: 'deft_task_update', tier: 'quick', description: 'Edit task' },
  { tool: 'deft_message_post', tier: 'full', description: 'Post to a channel' },
  { tool: 'deft_delegation_self_report', tier: 'full', description: 'Delegate to another employee' },
];

const TIER_COLORS: Record<string, { bg: string; fg: string; label: string }> = {
  auto: { bg: 'rgba(16,185,129,0.12)', fg: '#10b981', label: 'Auto-execute' },
  quick: { bg: 'rgba(234,179,8,0.12)', fg: '#eab308', label: 'Quick approve' },
  full: { bg: 'rgba(239,68,68,0.12)', fg: '#ef4444', label: 'Full review' },
};

export function ApprovalSummary({ trustLevel }: { trustLevel: string }) {
  return (
    <div>
      <h3
        className="text-[16px] font-semibold mb-3"
        style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
      >
        7. Approval mapping
      </h3>
      <p className="text-[12px] mb-4" style={{ color: 'var(--muted)' }}>
        Inherited from task 58's standardized approval matrix. Tier decisions
        are capped at {trustLevel} in this wizard — upgrading to autonomous
        requires a separate confirmation from the agent settings page.
      </p>
      <div className="space-y-1">
        {APPROVAL_MATRIX.map((r) => {
          const tc = TIER_COLORS[r.tier]!;
          return (
            <div
              key={r.tool}
              className="flex items-center gap-3 px-3 py-2 rounded"
              style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
            >
              <span
                className="text-[11px] font-mono flex-1"
                style={{ color: 'var(--foreground)' }}
              >
                {r.tool}
              </span>
              <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                {r.description}
              </span>
              <span
                className="text-[10px] px-2 py-0.5 rounded font-medium"
                style={{ background: tc.bg, color: tc.fg }}
              >
                {tc.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
