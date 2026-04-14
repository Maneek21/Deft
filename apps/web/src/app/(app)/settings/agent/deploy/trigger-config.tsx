'use client';

/**
 * Phase 8 — Wizard step 4: Trigger subscription config.
 *
 * Check the triggers this employee should subscribe to. The backend's
 * /start endpoint enforces uniqueness against other employees in the org.
 */
const TRIGGER_KINDS = [
  { kind: 'cron:standup', label: '9am daily standup', description: 'Summarize yesterday, post to #general' },
  { kind: 'cron:nudge', label: 'Stale task nudge', description: 'DM assignees of tasks stalled 48h+' },
  { kind: 'cron:meeting-prep', label: 'Meeting prep brief', description: 'Generate briefings 15 min before meetings' },
  { kind: 'github.pr.merged', label: 'PR merged', description: 'Move linked task to Done, post in channel' },
  { kind: 'github.pr.opened', label: 'PR opened', description: 'Assign reviewers, flag for code review' },
  { kind: 'task.overdue', label: 'Task overdue', description: 'Alert assignee + lead when a task misses due date' },
];

export function TriggerConfig({
  selected,
  defaults,
  onToggle,
}: {
  selected: string[];
  defaults: string[];
  onToggle: (kind: string) => void;
}) {
  return (
    <div>
      <h3
        className="text-[16px] font-semibold mb-3"
        style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
      >
        4. Configure triggers
      </h3>
      <p className="text-[12px] mb-4" style={{ color: 'var(--muted)' }}>
        Pick which events should wake this employee up. Each trigger can only
        be claimed by one employee per org — the backend will block deploy if
        another employee already owns one of your picks.
      </p>
      <div className="space-y-2">
        {TRIGGER_KINDS.map((t) => {
          const isSelected = selected.includes(t.kind);
          const isDefault = defaults.includes(t.kind);
          return (
            <label
              key={t.kind}
              data-testid={`trigger-${t.kind}`}
              className="flex items-start gap-3 p-3 rounded-lg cursor-pointer"
              style={{
                background: isSelected ? 'rgba(59,130,246,0.05)' : 'var(--card-bg)',
                border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
              }}
            >
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => onToggle(t.kind)}
                className="mt-1"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-[13px] font-medium" style={{ color: 'var(--foreground)' }}>
                    {t.label}
                  </p>
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded font-mono"
                    style={{
                      background: 'var(--surface-container)',
                      color: 'var(--foreground-secondary)',
                    }}
                  >
                    {t.kind}
                  </span>
                  {isDefault && (
                    <span
                      className="text-[9px] px-1 py-0.5 rounded"
                      style={{
                        background: 'rgba(168, 85, 247, 0.15)',
                        color: '#a855f7',
                      }}
                    >
                      Template default
                    </span>
                  )}
                </div>
                <p className="text-[11px] mt-1" style={{ color: 'var(--muted)' }}>
                  {t.description}
                </p>
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}
