'use client';

import { useEffect, useState, useImperativeHandle, forwardRef, useMemo, useRef } from 'react';
import * as Icons from 'lucide-react';
import type { SlashCommand } from '@/lib/editor/commands';

type Props = {
  items: SlashCommand[];
  command: (cmd: SlashCommand) => void;
};

export type SlashMenuRef = {
  onKeyDown: (event: KeyboardEvent) => boolean;
};

export const SlashMenuPopup = forwardRef<SlashMenuRef, Props>(function SlashMenuPopup(
  { items, command },
  ref,
) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => setSelectedIndex(0), [items]);

  useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // Group items by group field for visual sectioning
  const grouped = useMemo(() => {
    const groups: Record<string, SlashCommand[]> = {};
    for (const item of items) {
      (groups[item.group] ||= []).push(item);
    }
    return groups;
  }, [items]);

  const selectItem = (index: number) => {
    const item = items[index];
    if (item) command(item);
  };

  useImperativeHandle(ref, () => ({
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === 'ArrowUp') {
        setSelectedIndex(prev => (prev + items.length - 1) % items.length);
        return true;
      }
      if (event.key === 'ArrowDown') {
        setSelectedIndex(prev => (prev + 1) % items.length);
        return true;
      }
      if (event.key === 'Enter') {
        selectItem(selectedIndex);
        return true;
      }
      return false;
    },
  }));

  if (items.length === 0) {
    return (
      <div
        className="rounded-lg overflow-hidden"
        style={{
          background: 'var(--surface-container-low)',
          border: '1px solid var(--outline-variant)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.15)',
          minWidth: 280,
        }}
      >
        <div className="px-3 py-2 text-[12px]" style={{ color: 'var(--outline)' }}>
          No matching commands
        </div>
      </div>
    );
  }

  let flatIndex = 0;
  return (
    <div
      className="rounded-lg overflow-y-auto max-h-[320px]"
      style={{
        background: 'var(--surface-container-low)',
        border: '1px solid var(--outline-variant)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.15)',
        minWidth: 280,
      }}
    >
      {Object.entries(grouped).map(([group, cmds]) => (
        <div key={group}>
          <div
            className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: 'var(--outline)' }}
          >
            {group === 'ai'
              ? 'AI Actions'
              : group === 'block'
                ? 'Blocks'
                : group === 'commands'
                  ? 'Commands'
                  : 'Insert'}
          </div>
          {cmds.map(cmd => {
            const myIndex = flatIndex++;
            const isSelected = myIndex === selectedIndex;
            const Icon = (cmd.iconName && (Icons as any)[cmd.iconName]) || Icons.Square;
            return (
              <button
                key={cmd.id}
                ref={el => { itemRefs.current[myIndex] = el; }}
                onClick={() => selectItem(myIndex)}
                onMouseEnter={() => setSelectedIndex(myIndex)}
                className="w-full text-left px-3 py-2 flex items-center gap-3 transition-colors"
                style={{
                  background: isSelected ? 'var(--bg-hover)' : 'transparent',
                }}
              >
                <Icon
                  size={16}
                  strokeWidth={1.5}
                  style={{ color: 'var(--outline)', flexShrink: 0 }}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium" style={{ color: 'var(--on-surface)' }}>
                    {cmd.getLabel?.() || cmd.label}
                  </div>
                  <div className="text-[11px]" style={{ color: 'var(--outline)' }}>
                    {cmd.description}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
});
