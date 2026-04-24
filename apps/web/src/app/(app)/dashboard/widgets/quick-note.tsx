'use client';
import { useEffect, useRef, useState } from 'react';
import { StickyNote } from 'lucide-react';
import type { WidgetDefinition, WidgetProps } from '../lib/widget-types';

type QuickNoteConfig = { text: string };

function QuickNoteWidget({ config, onConfigChange }: WidgetProps<QuickNoteConfig>) {
  const [local, setLocal] = useState(config?.text ?? '');
  const mounted = useRef(false);

  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
  }, []);

  useEffect(() => {
    if (!mounted.current) return;
    if ((config?.text ?? '') !== local) {
      const t = setTimeout(() => onConfigChange?.({ text: local }), 400);
      return () => clearTimeout(t);
    }
  }, [local, config, onConfigChange]);

  return (
    <textarea
      value={local}
      onChange={e => setLocal(e.target.value)}
      onMouseDown={e => e.stopPropagation()}
      placeholder="Anything worth remembering…"
      spellCheck
      style={{
        width: '100%', height: '100%',
        background: 'transparent',
        border: 'none', outline: 'none', resize: 'none',
        fontFamily: 'var(--font-sans)',
        fontSize: 13, lineHeight: 1.55,
        color: 'var(--text-primary)',
        padding: 0,
      }}
    />
  );
}

export const quickNoteDefinition: WidgetDefinition<QuickNoteConfig> = {
  apiVersion: 1,
  id: 'cairn.quick-note',
  title: 'Quick note',
  description: 'A scratchpad that stays with your dashboard.',
  icon: StickyNote,
  category: 'work',
  defaultSize: { w: 3, h: 3 },
  minSize: { w: 2, h: 2 },
  defaultConfig: { text: '' },
  Component: QuickNoteWidget,
};
