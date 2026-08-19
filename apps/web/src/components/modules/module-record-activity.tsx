'use client';

import { Activity, Loader2, RefreshCw } from 'lucide-react';
import { useModuleRecordActivity } from '@/hooks/use-modules';
import { humanizeIdentifier, type ModuleField } from '@/lib/modules';

export function ModuleRecordActivity({ resourceId, fields }: { resourceId: string; fields: ModuleField[] }) {
  const state = useModuleRecordActivity(resourceId);
  const fieldsByKey = new Map(fields.map((field) => [field.key, field.label]));

  return (
    <section
      className="overflow-hidden rounded-xl"
      style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}
      aria-labelledby="module-activity-heading"
    >
      <header className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: '1px solid var(--ghost-border)' }}>
        <Activity size={14} style={{ color: 'var(--primary)' }} />
        <h2 id="module-activity-heading" className="text-[0.75rem] font-semibold" style={{ color: 'var(--on-surface)' }}>
          Activity
        </h2>
      </header>
      {state.isLoading ? (
        <div className="flex items-center gap-2 px-4 py-5 text-[0.75rem]" style={{ color: 'var(--outline)' }}>
          <Loader2 size={14} className="animate-spin" /> Loading activity…
        </div>
      ) : state.error ? (
        <div className="px-4 py-4 text-[0.75rem]" style={{ color: 'var(--outline)' }}>
          <p>Activity is temporarily unavailable.</p>
          <button type="button" onClick={() => void state.mutate()} className="mt-2 inline-flex min-h-9 items-center gap-1.5 font-medium" style={{ color: 'var(--primary)' }}>
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      ) : state.activity.length === 0 ? (
        <p className="px-4 py-5 text-[0.75rem]" style={{ color: 'var(--outline)' }}>No recorded changes yet.</p>
      ) : (
        <ol className="divide-y divide-[var(--ghost-border)]">
          {state.activity.map((event) => {
            const changed = Array.isArray(event.metadata.changed_fields)
              ? event.metadata.changed_fields.map(String).map((key) => fieldsByKey.get(key) ?? humanizeIdentifier(key))
              : [];
            return (
              <li key={event.id} className="relative px-4 py-3 pl-8">
                <span className="absolute left-4 top-[1.15rem] h-2 w-2 rounded-full" style={{ background: activityColor(event.action) }} />
                <p className="text-[0.75rem] font-medium" style={{ color: 'var(--on-surface)' }}>{activityLabel(event.action)}</p>
                {changed.length > 0 && (
                  <p className="mt-1 line-clamp-2 text-[0.6875rem]" style={{ color: 'var(--outline)' }}>
                    {changed.join(', ')}
                  </p>
                )}
                <p className="mt-1 text-[0.625rem]" style={{ color: 'var(--outline)' }}>
                  {event.createdAt ? new Date(event.createdAt).toLocaleString() : 'Time unavailable'}
                  {event.actorType ? ` · ${humanizeIdentifier(event.actorType)}` : ''}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function activityLabel(action: string): string {
  if (action.endsWith('.create')) return 'Record created';
  if (action.endsWith('.update')) return 'Record updated';
  if (action.endsWith('.archive')) return 'Record archived';
  if (action.includes('relation')) return 'Relationships updated';
  return humanizeIdentifier(action.replace(/^module_record[.:]/, ''));
}

function activityColor(action: string): string {
  if (action.endsWith('.create')) return 'var(--status-green)';
  if (action.endsWith('.archive')) return 'var(--error)';
  return 'var(--primary)';
}
