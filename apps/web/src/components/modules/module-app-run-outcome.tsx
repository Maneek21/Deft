'use client';

import { useState } from 'react';
import { ReceiptText } from 'lucide-react';
import { AppRunInspector } from '@/components/apps/app-run-inspector';
import { useModuleAppRunOutcomes } from '@/hooks/use-app-actions';
import { appRunPresentation } from '@/lib/app-run-presentation';
import type { ModuleAppRunOutcome } from '@/lib/app-actions';
import type { ResourceRef } from '@/lib/modules';

const TONE_STYLE = {
  neutral: { background: 'var(--surface-container-high)', color: 'var(--on-surface-variant)' },
  active: { background: 'var(--secondary-container)', color: 'var(--on-surface)' },
  success: { background: 'rgba(48,164,108,.12)', color: 'var(--status-green)' },
  danger: { background: 'var(--danger-subtle)', color: 'var(--error)' },
  warning: { background: 'var(--warning-subtle)', color: 'var(--warning)' },
} as const;

export function ModuleAppRunOutcomeBadge({ outcome }: {
  outcome: ModuleAppRunOutcome | null | undefined;
}) {
  if (!outcome) return null;
  const presentation = appRunPresentation(outcome);
  return <span
    className="inline-flex max-w-full items-center rounded-full px-2 py-1 text-[11px] font-medium leading-none"
    style={TONE_STYLE[presentation.tone]}
    title={presentation.detail}
  >
    <span className="truncate">{presentation.label}</span>
  </span>;
}

export function ModuleAppRunOutcomeSummary({ resourceRef }: { resourceRef: ResourceRef }) {
  const [inspectId, setInspectId] = useState<string | null>(null);
  const state = useModuleAppRunOutcomes([resourceRef]);
  const outcome = state.outcomesByResourceId.get(resourceRef.resourceId);
  if (state.isLoading || (!outcome && !state.error)) return null;
  if (state.error) return <p role="status" className="mt-3 text-xs" style={{ color: 'var(--on-surface-variant)' }}>Latest action outcome is unavailable.</p>;
  if (!outcome) return null;
  const presentation = appRunPresentation(outcome);
  return <>
    <section aria-label="Latest action outcome" className="mt-3 max-w-xl rounded-xl px-3 py-2.5" style={{ ...TONE_STYLE[presentation.tone], border: '1px solid var(--ghost-border)' }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.05em]">Latest action outcome</p>
          <p className="mt-1 text-sm font-semibold">{presentation.label}</p>
          <p className="mt-0.5 text-xs leading-relaxed">{presentation.detail}</p>
        </div>
        <button type="button" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium underline" onClick={() => setInspectId(outcome.runId)}>
          <ReceiptText size={13} /> View receipts
        </button>
      </div>
    </section>
    <AppRunInspector runId={inspectId} onClose={() => setInspectId(null)} />
  </>;
}
