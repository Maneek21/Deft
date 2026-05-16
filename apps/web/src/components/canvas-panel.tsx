'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/time';
import { useEditor, EditorContent } from '@tiptap/react';
import { X, FileText } from 'lucide-react';
import { createBaseExtensions } from '@/lib/editor/shared-config';
import { registerBuiltInCommands } from '@/lib/editor/built-in-commands';
import { registerAICommands } from '@/lib/editor/ai-commands';
import { AILoadingListener } from '@/components/editor/ai-loading-listener';
import { Callout } from '@/lib/editor/blocks/callout';
import { Toggle, ToggleSummary, ToggleContent } from '@/lib/editor/blocks/toggle';
import { CodeBlock } from '@/lib/editor/blocks/code-block';

registerBuiltInCommands();
registerAICommands();

function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < breakpoint);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [breakpoint]);
  return isMobile;
}

type Props = { spaceId: string; onClose: () => void };

export function CanvasPanel({ spaceId, onClose }: Props) {
  const isMobile = useIsMobile();
  const [title, setTitle] = useState('Canvas');
  const [lastEdited, setLastEdited] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      ...createBaseExtensions({
        surface: 'canvas',
        placeholder: 'Start writing... Type / for commands. This canvas is shared with everyone in this space.',
        disable: ['codeBlock'],
      }),
      Callout,
      Toggle,
      ToggleSummary,
      ToggleContent,
      CodeBlock,
    ],
    editorProps: { attributes: { class: 'deft-editor' } },
    onUpdate: ({ editor }) => {
      // Auto-save with debounce
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        setSaving(true);
        await api.patch(`/api/spaces/${spaceId}/canvas`, { content: editor.getJSON() });
        setSaving(false);
        setLastEdited('Just now');
      }, 1000);
    },
  });

  // Load canvas
  useEffect(() => {
    api.get(`/api/spaces/${spaceId}/canvas`).then(async res => {
      if (res.ok) {
        const data = await res.json();
        setTitle(data.title || 'Canvas');
        if (data.content && editor) {
          editor.commands.setContent(data.content);
        }
        if (data.last_edited_at) {
          setLastEdited(formatDateTime(data.last_edited_at));
        }
      }
    });
  }, [spaceId, editor]);

  return (
    <div className={isMobile ? "fixed inset-0 z-50 flex flex-col" : "w-[400px] h-full flex flex-col flex-shrink-0"} style={{ background: 'var(--surface-container-low)' }}>
      <AILoadingListener />
      <div className="h-12 flex items-center justify-between px-4 flex-shrink-0">
        <div className="flex items-center gap-2">
          <FileText size={14} strokeWidth={1.5} style={{ color: 'var(--outline)' }} />
          <input value={title} onChange={e => setTitle(e.target.value)}
            onBlur={() => api.patch(`/api/spaces/${spaceId}/canvas`, { title })}
            className="text-[0.875rem] font-semibold bg-transparent outline-none"
            style={{ color: 'var(--on-surface)' }} />
        </div>
        <button onClick={onClose} className="p-2 md:p-1 rounded-md min-w-[36px] min-h-[36px] flex items-center justify-center" style={{ color: 'var(--outline)' }}>
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <EditorContent editor={editor} />
      </div>
      <div className="px-4 py-2 flex items-center justify-between flex-shrink-0"
        style={{ borderTop: '1px solid var(--ghost-border)' }}>
        <span className="text-[0.6875rem]" style={{ color: 'var(--outline)', fontFamily: 'var(--font-mono)' }}>
          {saving ? 'Saving...' : lastEdited ? `Last edited ${lastEdited}` : ''}
        </span>
      </div>
    </div>
  );
}
