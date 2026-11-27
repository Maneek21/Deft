'use client';

// The document page's right panel (spec 5.3, mockup 2; plan Task F12): three
// tabs, Comments, Changes and Mentions. Changes is the version list and shows
// only to someone who can edit (spec 5.6). Comments and Mentions come with
// S6. On a desktop the panel is a column beside the document; at phone width
// (below 768 px) it is a bottom sheet.

import { useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import { AppBottomSheet } from '@/components/overlay-primitives';
import { DocumentHistoryPanel } from './document-history-panel';
import type { SessionScope } from './document-keys';

export type PanelTab = 'comments' | 'changes' | 'mentions';

const PHONE = '(max-width: 767px)';

/** True below 768 px. False when rendered on the server. */
export function useIsPhone(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(PHONE);
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

const TAB_LABEL: Record<PanelTab, string> = { comments: 'Comments', changes: 'Changes', mentions: 'Mentions' };

function PanelBody({ tab, onTab, canSeeHistory, documentId, scope, names, onClose }: {
  tab: PanelTab; onTab: (tab: PanelTab) => void; canSeeHistory: boolean; documentId: string; scope: SessionScope;
  names: ReadonlyMap<string, string>; onClose: () => void;
}) {
  const tabs: PanelTab[] = canSeeHistory ? ['comments', 'changes', 'mentions'] : ['comments', 'mentions'];
  const shown = tabs.includes(tab) ? tab : 'comments';
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-w-0 items-end gap-1 px-2" style={{ borderBottom: '1px solid var(--outline-variant)' }}>
        <div role="tablist" aria-label="Document panel tabs" className="flex min-w-0 flex-1 gap-3 overflow-x-auto px-1">
          {tabs.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={shown === t}
              onClick={() => onTab(t)}
              className="min-h-[40px] flex-shrink-0 whitespace-nowrap text-[13px]"
              style={{
                color: shown === t ? 'var(--on-surface)' : 'var(--on-surface-variant)',
                fontWeight: shown === t ? 600 : 400,
                borderBottom: shown === t ? '2px solid var(--primary)' : '2px solid transparent',
              }}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>
        <button type="button" onClick={onClose} aria-label="Close panel" className="mb-1 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md"
          style={{ color: 'var(--on-surface-variant)' }}>
          <X size={15} />
        </button>
      </div>
      <div role="tabpanel" aria-label={TAB_LABEL[shown]} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {shown === 'changes' ? (
          <DocumentHistoryPanel documentId={documentId} scope={scope} names={names} />
        ) : (
          <p className="p-4 text-[13px]" style={{ color: 'var(--on-surface-variant)' }}>
            {shown === 'comments' ? 'Comments are coming soon.' : 'Mentions of this document are coming soon.'}
          </p>
        )}
      </div>
    </div>
  );
}

export function DocumentRightPanel(props: {
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  onClose: () => void;
  /** Edit and up (spec 5.6). */
  canSeeHistory: boolean;
  documentId: string;
  scope: SessionScope;
  names: ReadonlyMap<string, string>;
}) {
  const phone = useIsPhone();
  if (phone) {
    return (
      <AppBottomSheet open onClose={props.onClose} title="Document panel">
        <div className="flex max-h-[56vh] min-h-[40vh] min-w-0 flex-col">
          <PanelBody {...props} />
        </div>
      </AppBottomSheet>
    );
  }
  return (
    <aside aria-label="Document panel" className="flex w-[320px] min-w-0 flex-shrink-0 flex-col" style={{ borderLeft: '1px solid var(--outline-variant)' }}>
      <PanelBody {...props} />
    </aside>
  );
}
