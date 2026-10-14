'use client';
import { forwardRef, useImperativeHandle, useState } from 'react';
import type { NativeProjection } from '@/lib/native-mentions';

export type NativeMentionPopupRef = { onKeyDown: (event: KeyboardEvent) => boolean };
export type NativeMentionPopupProps = {
  items: NativeProjection[]; command: (item: NativeProjection) => void; loading?: boolean; error?: string;
};
export const NativeMentionPopup = forwardRef<NativeMentionPopupRef, NativeMentionPopupProps>(
  function NativeMentionPopup({ items, command, loading, error }, ref) {
    const [index, setIndex] = useState(0);
    const selected = Math.min(index, Math.max(0, items.length - 1));
    useImperativeHandle(ref, () => ({ onKeyDown(event) {
      if (event.isComposing) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setIndex((selected + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(1, items.length));
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        if (!loading && items[selected]) command(items[selected]!);
        return true;
      }
      return false;
    } }));
    return <div role="listbox" aria-label="Mention people, agents, tasks or wikis"
      className="w-[320px] max-w-[calc(100vw-24px)] max-h-[340px] overflow-y-auto rounded-xl border p-2 shadow-xl"
      style={{ background: 'var(--surface-container-low)', borderColor: 'var(--border-default)' }}>
      {loading && <div className="p-3 text-sm">Searching…</div>}
      {error && <div role="alert" className="p-3 text-sm">{error}</div>}
      {!loading && !error && !items.length && <div className="p-3 text-sm">No matching references</div>}
      {!loading && !error && items.map((item, i) => <div key={item.ref.resource_type + item.ref.resource_id}>
        {item.group !== items[i - 1]?.group && <div className="px-2 pt-2 pb-1 text-xs opacity-60">{item.group}</div>}
        <button type="button" role="option" aria-selected={selected === i}
          className="w-full rounded-lg px-2 py-2 text-left text-sm"
          style={{ background: selected === i ? 'var(--surface-container-high)' : undefined }}
          onMouseDown={e => e.preventDefault()} onClick={() => command(item)}>
          <span className="block truncate">{item.label}</span>
          {item.description && <span className="block truncate text-xs opacity-60">{item.description}</span>}
        </button>
      </div>)}
    </div>;
  });
