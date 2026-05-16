'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { sanitizeHtml } from '@/lib/sanitize';
import { api } from '@/lib/api';
import { useEditor, EditorContent } from '@tiptap/react';
import { createBaseExtensions } from '@/lib/editor/shared-config';
import { registerBuiltInCommands } from '@/lib/editor/built-in-commands';
import { Callout } from '@/lib/editor/blocks/callout';
import { Toggle, ToggleSummary, ToggleContent } from '@/lib/editor/blocks/toggle';
import { CodeBlock } from '@/lib/editor/blocks/code-block';
import LinkExt from '@tiptap/extension-link';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { Image as TiptapImage } from '@tiptap/extension-image';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { Highlight } from '@tiptap/extension-highlight';
import { Underline } from '@tiptap/extension-underline';
import TurndownService from 'turndown';
import {
  Plus, ArrowLeft, Loader2, Check, Trash2, Pin, PinOff,
  Bold, Italic, Strikethrough, List, ListOrdered, Quote, Code,
  Heading1, Heading2, Minus, FileText, Search, Settings2,
  Table as TableIcon, ImageIcon, CheckSquare, Highlighter,
  Underline as UnderlineIcon, Download, BookOpen,
  FolderPlus, Folder, ChevronRight, LayoutTemplate,
  History, Share2, Maximize2, Minimize2, Users, Globe, Lock,
  MoreHorizontal,
} from 'lucide-react';
import { EmojiPicker } from '@/components/emoji-picker';
import { PageHeader } from '@/components/page-header';
import { useSetPageContext } from '@/components/app-header-context';
import { OverflowMenu } from '@/components/overflow-menu';

// Register built-in slash menu commands (idempotent).
registerBuiltInCommands();

type NoteFolder = {
  id: string;
  name: string;
  icon: string | null;
  parent_folder_id: string | null;
};

type NoteTemplate = {
  id: string;
  title: string;
  content: string | null;
  icon: string | null;
};

type Note = {
  id: string;
  title: string;
  content: string | null;
  icon: string | null;
  is_pinned: boolean;
  folder_id: string | null;
  visibility: 'private' | 'org' | 'space';
  user_id: string;
  created_at: string;
  updated_at: string;
};

function stripHtml(html: string): string {
  // First, add space before closing block-level tags to prevent concatenation
  let text = html.replace(/<\/(h[1-6]|p|div|li|blockquote)>/gi, ' </$1>');
  // Remove all HTML tags
  text = text.replace(/<[^>]*>/g, '');
  // Replace HTML entities
  text = text.replace(/&nbsp;/g, ' ');
  // Normalize whitespace
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

/**
 * Walk a TipTap JSON doc and collect raw text nodes only, ignoring
 * block-type names. Previously the preview was stringifying nodes
 * directly, which leaked labels like "Heading 1" into the preview.
 */
function getNotePreview(content: unknown, maxLen = 120): string {
  if (!content) return '';

  // If it's a string, try to parse as JSON first, fall back to treating as HTML
  let parsed = content;
  if (typeof content === 'string') {
    if (content.startsWith('{') || content.startsWith('[')) {
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        // If JSON parse fails, treat as HTML
        return stripHtml(content).slice(0, maxLen);
      }
    } else {
      // It's HTML or plain text
      return stripHtml(content).slice(0, maxLen);
    }
  }

  // Walk JSON nodes and collect text
  const parts: string[] = [];
  function walk(node: unknown, depth = 0): void {
    if (!node || typeof node !== 'object') return;
    if (depth > 100) return; // Prevent infinite loops
    const n = node as { text?: unknown; content?: unknown; type?: unknown };
    if (typeof n.text === 'string') {
      parts.push(n.text);
    }
    if (Array.isArray(n.content)) {
      n.content.forEach(item => walk(item, depth + 1));
    }
  }
  walk(parsed);

  let text = parts.join(' ').replace(/\s+/g, ' ').trim();

  // Remove block-type labels that may have leaked through JSON stringification
  // or through other means. These appear when labels are directly concatenated
  // with content (e.g., "Heading 1jjdjd" instead of properly separated).
  const testRegex = /^(Heading\s+[123]|Toggle\s+heading)(?=\S)/i;
  if (testRegex.test(text)) {
    text = text.replace(testRegex, '').trim();
  }

  if (text.length > maxLen) {
    return text.slice(0, maxLen) + '…';
  }
  return text;
}

function timeAgo(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Toolbar button ─────────────────────────────────────────
// onMouseDown + preventDefault keeps editor focus before the TipTap command runs.
// Using onClick caused a focus race where the editor lost focus before toggleX fired.
function TBtn({ active, onClick, children, title }: { active?: boolean; onClick: () => void; children: React.ReactNode; title: string }) {
  return (
    <button
      type="button"
      aria-label={title}
      title={title}
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 md:p-1.5 rounded transition-colors"
      style={{ color: active ? 'var(--accent)' : 'var(--muted)', background: active ? 'var(--accent-subtle)' : 'transparent' }}>
      {children}
    </button>
  );
}

// ── Note Card ──────────────────────────────────────────────
function NoteCard({ note, onClick }: { note: Note; onClick: () => void }) {
  const preview = getNotePreview(note.content);
  return (
    <div onClick={onClick}
      className="group p-4 rounded-lg cursor-pointer transition-all hover:shadow-sm"
      style={{ background: 'var(--surface-container)', border: '1px solid var(--border)' }}>
      <div className="flex items-start gap-2 mb-2">
        {note.icon && <span className="text-[18px] flex-shrink-0">{note.icon}</span>}
        <div className="flex-1 min-w-0">
          <h3 className="text-[14px] font-semibold line-clamp-2 md:truncate"
            style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}>
            {note.title || 'Untitled'}
          </h3>
          <p className="text-[12px] mt-1 line-clamp-2" style={{ color: 'var(--muted)', lineHeight: '1.5' }}>
            {preview || 'Empty note'}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-3">
        <span className="text-[11px]" style={{ color: 'var(--muted)' }}>{timeAgo(note.updated_at)}</span>
        {note.is_pinned && <Pin size={11} style={{ color: 'var(--accent)' }} />}
      </div>
    </div>
  );
}

// ── Note Editor ────────────────────────────────────────────
function NoteEditor({ noteId, onBack, onDeleted }: { noteId: string; onBack: () => void; onDeleted: () => void }) {
  const { user } = useAuth();
  const [note, setNote] = useState<Note | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [title, setTitle] = useState('');
  const [icon, setIcon] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<'private' | 'org'>('private');
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [showPromoteModal, setShowPromoteModal] = useState(false);
  const [promoteType, setPromoteType] = useState('concept');
  const [promoting, setPromoting] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyVersions, setHistoryVersions] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<any>(null);
  const [showShareModal, setShowShareModal] = useState(false);
  const [shares, setShares] = useState<any[]>([]);
  const [members, setMembers] = useState<any[]>([]);
  // Task 5.1 — inline list of tasks this note references (PREFIX-N chips)
  const [references, setReferences] = useState<Array<{
    id: string;
    target_id: string;
    task_title: string | null;
    task_identifier: string | null;
    task_status: string | null;
    task_priority: string | null;
  }>>([]);
  const [pendingDelete, setPendingDelete] = useState(false);
  const iconBtnRef = useRef<HTMLButtonElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const initialContentSet = useRef(false);
  const titleDebounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const isNoteOwner = !note || note.user_id === user?.id;

  const editor = useEditor({
    immediatelyRender: false,
    editable: isNoteOwner,
    extensions: [
      ...createBaseExtensions({
        surface: 'note',
        placeholder: 'Type / for commands…',
        disable: ['link', 'underline', 'codeBlock'],
        headingLevels: [1, 2],
      }),
      LinkExt.configure({ openOnClick: true, HTMLAttributes: { class: 'deft-link' } }),
      Table.configure({ resizable: true }),
      TableRow,
      TableCell,
      TableHeader,
      TiptapImage.configure({ inline: false, allowBase64: false }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Highlight.configure({ multicolor: false }),
      Underline,
      Callout,
      Toggle,
      ToggleSummary,
      ToggleContent,
      CodeBlock,
    ],
    editorProps: {
      attributes: { class: 'deft-editor deft-notes-editor' },
      handlePaste: (view, event) => {
        const items = event.clipboardData?.items;
        if (!items) return false;
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            event.preventDefault();
            const file = item.getAsFile();
            if (!file) return false;
            api.upload('/api/upload', file).then(async (res) => {
              if (res.ok) {
                const data = await res.json();
                const imgNode = view.state.schema.nodes.image;
                if (imgNode) {
                  view.dispatch(view.state.tr.replaceSelectionWith(
                    imgNode.create({ src: `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/files/${data.id}` })
                  ));
                }
              }
            });
            return true;
          }
        }
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (!initialContentSet.current) return;
      setSaveStatus('saving');
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        await api.patch(`/api/daily-notes/${noteId}`, { content: ed.getHTML() });
        setSaveStatus('saved');
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
      }, 600);
    },
  });

  const handleImageUpload = useCallback(async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file || !editor) return;
      try {
        const res = await api.upload('/api/upload', file);
        if (res.ok) {
          const data = await res.json();
          editor.chain().focus().setImage({ src: `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/files/${data.id}` }).run();
        }
      } catch {}
    };
    input.click();
  }, [editor]);

  const exportMarkdown = useCallback(() => {
    if (!editor || !note) return;
    const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    const md = `# ${title || 'Untitled'}\n\n${turndown.turndown(editor.getHTML())}`;
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(title || 'untitled').toLowerCase().replace(/\s+/g, '-')}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [editor, note, title]);

  const clearSavedTimers = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
  }, []);

  const markSaved = useCallback(() => {
    clearSavedTimers();
    setSaveStatus('saved');
    savedTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
  }, [clearSavedTimers]);

  const persistNoteUpdate = useCallback(async (payload: Record<string, unknown>) => {
    setSaveStatus('saving');
    try {
      const res = await api.patch(`/api/daily-notes/${noteId}`, payload);
      if (res.ok) markSaved();
      else setSaveStatus('idle');
    } catch {
      setSaveStatus('idle');
    }
  }, [markSaved, noteId]);

  const handlePromoteToWiki = async () => {
    if (!editor || !note || !title.trim()) return;
    setPromoting(true);
    try {
      const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
      const content = turndown.turndown(editor.getHTML());
      const res = await api.post('/api/wiki', {
        title: title.trim(),
        content,
        type: promoteType,
        scope: 'org',
        summary: content.split('\n')[0]?.slice(0, 100) || null,
        confidence: 1.0,
      });
      if (res.ok) {
        setShowPromoteModal(false);
        alert('Note promoted to wiki!');
      }
    } catch {
    } finally {
      setPromoting(false);
    }
  };

  const fetchHistory = async () => {
    if (!noteId) return;
    setHistoryLoading(true);
    try {
      const res = await api.get(`/api/daily-notes/${noteId}/history`);
      if (res.ok) {
        const data = await res.json();
        setHistoryVersions(data.versions || []);
      }
    } catch {} finally { setHistoryLoading(false); }
  };

  const fetchShares = async () => {
    if (!noteId) return;
    const res = await api.get(`/api/daily-notes/${noteId}/shares`);
    if (res.ok) {
      const data = await res.json();
      setShares(data.shares || []);
    }
  };

  const fetchMembers = async () => {
    const res = await api.get('/api/members');
    if (res.ok) {
      const data = await res.json();
      setMembers(Array.isArray(data) ? data : data.members || []);
    }
  };

  const handleShare = async (userId: string) => {
    if (!noteId) return;
    await api.post(`/api/daily-notes/${noteId}/shares`, { user_id: userId });
    fetchShares();
  };

  const handleUnshare = async (userId: string) => {
    if (!noteId) return;
    await api.delete(`/api/daily-notes/${noteId}/shares/${userId}`);
    fetchShares();
  };

  useEffect(() => {
    setLoading(true);
    initialContentSet.current = false;
    api.get(`/api/daily-notes/${noteId}`).then(async res => {
      if (res.ok) {
        const data = await res.json();
        setNote(data);
        setTitle(data.title);
        setIcon(data.icon);
        setVisibility(data.visibility === 'org' ? 'org' : 'private');
        if (editor) {
          editor.commands.setContent(data.content || '');
          // Set editable based on ownership
          editor.setEditable(data.user_id === user?.id);
          setTimeout(() => { initialContentSet.current = true; }, 50);
        }
      }
      setLoading(false);
    });
  }, [noteId, editor]);

  // Task 5.1 — load note -> tasks references sidebar
  const fetchReferences = useCallback(async () => {
    if (!noteId) return;
    try {
      const res = await api.get(`/api/notes/${noteId}/references`);
      if (res.ok) {
        const data = await res.json();
        setReferences(data.references || []);
      }
    } catch {}
  }, [noteId]);

  useEffect(() => {
    fetchReferences();
    // refetch after a short delay whenever save completes, giving the
    // cross-reference worker time to process new PREFIX-N matches.
    if (saveStatus === 'saved') {
      const t = setTimeout(fetchReferences, 1500);
      return () => clearTimeout(t);
    }
  }, [fetchReferences, saveStatus]);

  const handleTitleChange = (value: string) => {
    setTitle(value);
    setSaveStatus('saving');
    if (titleDebounce.current) clearTimeout(titleDebounce.current);
    titleDebounce.current = setTimeout(async () => {
      try {
        const res = await api.patch(`/api/daily-notes/${noteId}`, { title: value });
        if (res.ok) markSaved();
        else setSaveStatus('idle');
      } catch {
        setSaveStatus('idle');
      }
    }, 500);
  };

  const handleIconChange = async (emoji: string) => {
    setIcon(emoji);
    setIconPickerOpen(false);
    await persistNoteUpdate({ icon: emoji });
  };

  const handleRemoveIcon = async () => {
    setIcon(null);
    setIconPickerOpen(false);
    await persistNoteUpdate({ icon: null });
  };

  const handlePin = async () => {
    if (!note) return;
    const pinned = !note.is_pinned;
    setNote({ ...note, is_pinned: pinned });
    await persistNoteUpdate({ is_pinned: pinned });
  };

  const handleVisibilityChange = async (newVisibility: 'private' | 'org') => {
    setVisibility(newVisibility);
    await persistNoteUpdate({ visibility: newVisibility });
  };

  const handleDelete = () => {
    // Optimistic delete: show undo toast for 5 s, then fire the real DELETE.
    setPendingDelete(true);
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    deleteTimerRef.current = setTimeout(async () => {
      await api.delete(`/api/daily-notes/${noteId}`);
      onDeleted();
    }, 5000);
  };

  const handleUndoDelete = () => {
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    setPendingDelete(false);
  };

  // Clean up delete timer on unmount
  useEffect(() => {
    return () => { if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current); };
  }, []);

  const isOwner = !note || note.user_id === user?.id;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="animate-spin" style={{ color: 'var(--muted)' }} />
      </div>
    );
  }

  return (
    <div className={`h-full overflow-y-auto ${focusMode ? 'fixed inset-0 z-[90]' : ''}`}
      style={focusMode ? { background: 'var(--background)', padding: '2rem 0' } : undefined}>

      {/* Undo-delete toast */}
      {pendingDelete && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[95] flex items-center gap-3 px-4 py-2.5 rounded-xl shadow-lg"
          style={{ background: 'var(--surface-container-highest)', border: '1px solid var(--border)', color: 'var(--foreground)' }}>
          <span className="text-[13px]">Note deleted.</span>
          <button
            type="button"
            onClick={handleUndoDelete}
            className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] md:min-h-auto md:min-w-auto md:px-2.5 md:py-1 text-[13px] font-semibold rounded-lg"
            style={{ background: 'var(--accent)', color: 'white' }}>
            Undo
          </button>
        </div>
      )}

      <div
        className={`max-w-[700px] mx-auto px-6 py-6 ${pendingDelete ? 'opacity-40 pointer-events-none select-none' : ''}`}
        aria-hidden={pendingDelete}
      >
        {/* Top bar */}
        <div className="flex items-center justify-between mb-4">
          <button onClick={focusMode ? () => setFocusMode(false) : onBack}
            aria-label="Back to all notes"
            className="flex items-center gap-1.5 text-[13px] font-medium min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 px-2 py-1 rounded-lg"
            style={{ color: 'var(--muted)' }}>
            <ArrowLeft size={15} /> <span className="hidden md:inline">All Notes</span>
          </button>
          <div className="flex items-center gap-2">
            {saveStatus === 'saving' && (
              <span className="text-[11px] flex items-center gap-1" style={{ color: 'var(--muted)' }}>
                <Loader2 size={11} className="animate-spin" /> Saving
              </span>
            )}
            {saveStatus === 'saved' && (
              <span className="text-[11px] flex items-center gap-1" style={{ color: 'var(--status-green)' }}>
                <Check size={11} /> Saved
              </span>
            )}
            {/* Visibility selector — owner only */}
            {isOwner ? (
              <select
                value={visibility}
                onChange={e => handleVisibilityChange(e.target.value as 'private' | 'org')}
                className="text-[11px] px-2 py-1 rounded-lg border outline-none"
                style={{
                  color: visibility === 'org' ? 'var(--accent)' : 'var(--muted)',
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  cursor: 'pointer',
                }}
                title="Note visibility">
                <option value="private">Private</option>
                <option value="org">Org</option>
              </select>
            ) : (
              <span className="text-[11px] flex items-center gap-1 px-2 py-1 rounded-lg"
                style={{ color: 'var(--muted)', border: '1px solid var(--border)' }}
                title="Shared with your org (read-only — you are not the owner)">
                <Globe size={11} /> Shared (read-only)
              </span>
            )}
            <button onClick={() => setFocusMode(!focusMode)} className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 md:p-1.5 rounded-lg"
              aria-label={focusMode ? 'Exit focus mode' : 'Focus mode'}
              style={{ color: focusMode ? 'var(--accent)' : 'var(--muted)' }} title={focusMode ? 'Exit focus mode' : 'Focus mode'}>
              {focusMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>

            {/* Mobile: collapse Share / History / Promote / Pin / Delete into a ••• menu */}
            <OverflowMenu
              className="md:hidden"
              items={[
                ...(isOwner ? [{
                  label: 'Share',
                  icon: <Share2 size={14} />,
                  onClick: () => { setShowShareModal(true); fetchShares(); fetchMembers(); },
                }] : []),
                {
                  label: showHistory ? 'Hide history' : 'Version history',
                  icon: <History size={14} />,
                  onClick: () => { setShowHistory(!showHistory); if (!showHistory) fetchHistory(); },
                },
                {
                  label: 'Promote to Wiki',
                  icon: <BookOpen size={14} />,
                  onClick: () => setShowPromoteModal(true),
                },
                ...(isOwner ? [{
                  label: note?.is_pinned ? 'Unpin' : 'Pin',
                  icon: note?.is_pinned ? <PinOff size={14} /> : <Pin size={14} />,
                  onClick: handlePin,
                }] : []),
                ...(isOwner ? [{
                  label: 'Delete',
                  icon: <Trash2 size={14} />,
                  onClick: handleDelete,
                  danger: true,
                }] : []),
              ]}
            />

            {/* Desktop: keep buttons inline */}
            {isOwner && (
              <button onClick={() => { setShowShareModal(true); fetchShares(); fetchMembers(); }} className="hidden md:inline-flex items-center justify-center md:p-1.5 rounded-lg"
                aria-label="Share note"
                style={{ color: 'var(--muted)' }} title="Share note">
                <Share2 size={15} />
              </button>
            )}
            <button onClick={() => { setShowHistory(!showHistory); if (!showHistory) fetchHistory(); }} className="hidden md:inline-flex items-center justify-center md:p-1.5 rounded-lg"
              aria-label="Version history"
              style={{ color: showHistory ? 'var(--accent)' : 'var(--muted)' }} title="Version history">
              <History size={15} />
            </button>
            <button onClick={() => setShowPromoteModal(true)} className="hidden md:inline-flex items-center justify-center md:p-1.5 rounded-lg"
              aria-label="Promote to Wiki"
              style={{ color: 'var(--muted)' }} title="Promote to Wiki">
              <BookOpen size={15} />
            </button>
            {isOwner && (
              <>
                <button onClick={handlePin} className="hidden md:inline-flex items-center justify-center md:p-1.5 rounded-lg"
                  aria-label={note?.is_pinned ? 'Unpin' : 'Pin'}
                  style={{ color: note?.is_pinned ? 'var(--accent)' : 'var(--muted)' }} title={note?.is_pinned ? 'Unpin' : 'Pin'}>
                  {note?.is_pinned ? <PinOff size={15} /> : <Pin size={15} />}
                </button>
                <button onClick={handleDelete} className="hidden md:inline-flex items-center justify-center md:p-1.5 rounded-lg"
                  aria-label="Delete note"
                  style={{ color: 'var(--muted)' }} title="Delete note">
                  <Trash2 size={15} />
                </button>
              </>
            )}
          </div>

          {/* Promote to Wiki Modal */}
          {showPromoteModal && (
            <div className="fixed inset-0 z-[80] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}
              onClick={() => setShowPromoteModal(false)}>
              <div className="w-80 p-4 rounded-xl" style={{ background: 'var(--surface-container)', border: '1px solid var(--border)' }}
                onClick={e => e.stopPropagation()}>
                <h3 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--foreground)' }}>Promote to Wiki</h3>
                <p className="text-[11px] mb-3" style={{ color: 'var(--muted)' }}>
                  Create a wiki page from this note. The note will remain in your notes.
                </p>
                <label className="text-[11px] font-medium mb-1 block" style={{ color: 'var(--muted)' }}>Page Type</label>
                <div className="flex flex-wrap gap-1 mb-4">
                  {['concept', 'entity', 'decision', 'resource', 'procedure', 'preference', 'fact'].map(t => (
                    <button key={t} onClick={() => setPromoteType(t)}
                      className="px-2 py-1 rounded-md text-[10px] font-medium capitalize"
                      style={{
                        background: promoteType === t ? 'var(--accent)' : 'var(--surface-container-low)',
                        color: promoteType === t ? 'white' : 'var(--muted)',
                        border: `1px solid ${promoteType === t ? 'var(--accent)' : 'var(--border)'}`,
                      }}>
                      {t}
                    </button>
                  ))}
                </div>
                <div className="flex justify-end gap-2">
                  <button onClick={() => setShowPromoteModal(false)}
                    className="px-3 py-1.5 rounded-lg text-[12px]"
                    style={{ color: 'var(--muted)' }}>Cancel</button>
                  <button onClick={handlePromoteToWiki} disabled={promoting || !title.trim()}
                    className="px-3 py-1.5 rounded-lg text-[12px] font-medium text-white disabled:opacity-40"
                    style={{ background: 'var(--accent)' }}>
                    {promoting ? 'Promoting...' : 'Promote'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Share Modal */}
          {showShareModal && (
            <div className="fixed inset-0 z-[80] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}
              onClick={() => setShowShareModal(false)}>
              <div className="w-80 p-4 rounded-xl" style={{ background: 'var(--surface-container)', border: '1px solid var(--border)' }}
                onClick={e => e.stopPropagation()}>
                <h3 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--foreground)' }}>Share Note</h3>
                {shares.length > 0 && (
                  <div className="mb-3">
                    <div className="text-[10px] font-medium mb-1" style={{ color: 'var(--muted)' }}>Shared with</div>
                    {shares.map((s: any) => (
                      <div key={s.id} className="flex items-center justify-between py-1.5">
                        <span className="text-[12px]" style={{ color: 'var(--foreground)' }}>{s.user_name} ({s.permission})</span>
                        <button onClick={() => handleUnshare(s.user_id)} className="text-[10px] px-2 py-0.5 rounded"
                          style={{ color: 'var(--status-red)' }}>Remove</button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="text-[10px] font-medium mb-1" style={{ color: 'var(--muted)' }}>Add people</div>
                <div className="max-h-40 overflow-y-auto space-y-1">
                  {members
                    .filter((m: any) => m.user_id !== user?.id && !shares.some((s: any) => s.user_id === m.user_id))
                    .map((m: any) => (
                      <button key={m.user_id} onClick={() => handleShare(m.user_id)}
                        className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md text-[12px] hover:opacity-80"
                        style={{ color: 'var(--foreground)', background: 'var(--surface-container-low)' }}>
                        <Users size={12} /> {m.name || m.email}
                      </button>
                    ))}
                </div>
                <button onClick={() => setShowShareModal(false)}
                  className="mt-3 w-full py-1.5 rounded-lg text-[12px] font-medium"
                  style={{ background: 'var(--surface-container-low)', color: 'var(--muted)' }}>Done</button>
              </div>
            </div>
          )}
        </div>

        {/* Icon + Title */}
        <div className="flex items-start gap-2 mb-4">
          <div className="relative">
            <button ref={iconBtnRef} onClick={() => setIconPickerOpen(!iconPickerOpen)}
              className="text-[28px] p-1 rounded-lg hover:bg-white/5 transition-colors leading-none"
              aria-label="Change icon"
              title="Change icon">
              {icon || '\uD83D\uDCC4'}
            </button>
            {iconPickerOpen && (
              <>
                <EmojiPicker
                  anchorRef={iconBtnRef}
                  onSelect={handleIconChange}
                  onClose={() => setIconPickerOpen(false)}
                />
                {icon && (
                  <button onClick={handleRemoveIcon}
                    className="absolute -bottom-6 left-0 text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap z-[60]"
                    style={{ color: 'var(--muted)', background: 'var(--surface-container-highest)' }}>
                    Remove icon
                  </button>
                )}
              </>
            )}
          </div>
          <input value={title} onChange={e => isOwner && handleTitleChange(e.target.value)}
            readOnly={!isOwner}
            placeholder="Untitled"
            className="flex-1 text-[24px] font-bold bg-transparent outline-none mt-0.5"
            style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)', letterSpacing: '-0.02em', cursor: isOwner ? 'text' : 'default' }} />
        </div>

        {/* Editor with toolbar */}
        <div className="rounded-lg overflow-hidden" style={{ background: 'var(--surface-container)' }}>
          {editor && (
            <div className="flex items-center gap-0.5 px-2 py-1.5 overflow-x-auto flex-nowrap"
              style={{ borderBottom: '1px solid var(--border)' }}>
              <TBtn active={editor.isActive('heading', { level: 1 })}
                onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} title="Heading 1">
                <Heading1 size={15} />
              </TBtn>
              <TBtn active={editor.isActive('heading', { level: 2 })}
                onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title="Heading 2">
                <Heading2 size={15} />
              </TBtn>
              <div className="w-px h-4 mx-1" style={{ background: 'var(--border)' }} />
              <TBtn active={editor.isActive('bold')}
                onClick={() => editor.chain().focus().toggleBold().run()} title="Bold">
                <Bold size={15} />
              </TBtn>
              <TBtn active={editor.isActive('italic')}
                onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic">
                <Italic size={15} />
              </TBtn>
              <TBtn active={editor.isActive('strike')}
                onClick={() => editor.chain().focus().toggleStrike().run()} title="Strikethrough">
                <Strikethrough size={15} />
              </TBtn>
              <TBtn active={editor.isActive('code')}
                onClick={() => editor.chain().focus().toggleCode().run()} title="Code">
                <Code size={15} />
              </TBtn>
              <TBtn active={editor.isActive('underline')}
                onClick={() => editor.chain().focus().toggleUnderline().run()} title="Underline">
                <UnderlineIcon size={15} />
              </TBtn>
              <TBtn active={editor.isActive('highlight')}
                onClick={() => editor.chain().focus().toggleHighlight().run()} title="Highlight">
                <Highlighter size={15} />
              </TBtn>
              <div className="w-px h-4 mx-1" style={{ background: 'var(--border)' }} />
              <TBtn active={editor.isActive('bulletList')}
                onClick={() => editor.chain().focus().toggleBulletList().run()} title="Bullet list">
                <List size={15} />
              </TBtn>
              <TBtn active={editor.isActive('orderedList')}
                onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Numbered list">
                <ListOrdered size={15} />
              </TBtn>
              <TBtn active={editor.isActive('taskList')}
                onClick={() => editor.chain().focus().toggleTaskList().run()} title="Checkbox list">
                <CheckSquare size={15} />
              </TBtn>
              <TBtn active={editor.isActive('blockquote')}
                onClick={() => editor.chain().focus().toggleBlockquote().run()} title="Quote">
                <Quote size={15} />
              </TBtn>
              <TBtn active={false}
                onClick={() => editor.chain().focus().setHorizontalRule().run()} title="Divider">
                <Minus size={15} />
              </TBtn>
              <div className="w-px h-4 mx-1" style={{ background: 'var(--border)' }} />
              <TBtn active={false}
                onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} title="Insert table">
                <TableIcon size={15} />
              </TBtn>
              <TBtn active={false}
                onClick={handleImageUpload} title="Insert image">
                <ImageIcon size={15} />
              </TBtn>
              <TBtn active={false}
                onClick={exportMarkdown} title="Export as Markdown">
                <Download size={15} />
              </TBtn>
            </div>
          )}
          <div className="px-4 py-3 min-h-[calc(100vh-350px)]">
            <EditorContent editor={editor} />
          </div>
          {/* Word count footer */}
          {editor && (
            <div className="flex items-center justify-between px-3 py-1.5"
              style={{ borderTop: '1px solid var(--border)', color: 'var(--muted)' }}>
              <span className="text-[10px]">
                {(() => {
                  const text = editor.getText();
                  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
                  const chars = text.length;
                  const readMin = Math.max(1, Math.ceil(words / 200));
                  return `${words} words · ${chars} chars · ${readMin} min read`;
                })()}
              </span>
              <span className="text-[10px]">
                {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved' : ''}
              </span>
            </div>
          )}
        </div>

        {/* Task 5.1 — References tasks sidebar */}
        {references.length > 0 && (
          <div className="mt-4 rounded-lg p-4" style={{ background: 'var(--surface-container)', border: '1px solid var(--border)' }}>
            <h3 className="text-[13px] font-semibold mb-2" style={{ color: 'var(--foreground)' }}>
              References tasks
            </h3>
            <div className="flex flex-wrap gap-2">
              {references.map((ref) => (
                <a
                  key={ref.id}
                  href={`/tasks?task=${ref.task_identifier || ''}`}
                  className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-[12px] font-medium"
                  style={{
                    background: 'var(--accent-subtle)',
                    color: 'var(--accent)',
                    textDecoration: 'none',
                    border: '1px solid var(--border)',
                  }}
                  title={ref.task_title || ''}
                >
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{ref.task_identifier}</span>
                  {ref.task_title ? (
                    <span style={{ color: 'var(--foreground)', fontWeight: 400 }}>
                      {ref.task_title.length > 40 ? `${ref.task_title.slice(0, 40)}…` : ref.task_title}
                    </span>
                  ) : null}
                  {ref.task_status ? (
                    <span className="text-[10px] px-1 rounded" style={{ background: 'var(--surface-container-low)', color: 'var(--muted)' }}>
                      {ref.task_status}
                    </span>
                  ) : null}
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Version History Panel */}
        {showHistory && (
          <div className="mt-4 rounded-lg p-4" style={{ background: 'var(--surface-container)', border: '1px solid var(--border)' }}>
            <h3 className="text-[13px] font-semibold mb-2 flex items-center gap-1.5" style={{ color: 'var(--foreground)' }}>
              <History size={14} /> Version History
            </h3>
            {historyLoading ? (
              <Loader2 size={14} className="animate-spin" style={{ color: 'var(--muted)' }} />
            ) : historyVersions.length === 0 ? (
              <p className="text-[11px]" style={{ color: 'var(--muted)' }}>No previous versions yet. Versions are saved when content changes.</p>
            ) : (
              <div className="space-y-1">
                {historyVersions.map((v: any) => (
                  <button key={v.id} onClick={() => setSelectedVersion(selectedVersion?.id === v.id ? null : v)}
                    className="w-full text-left p-2 rounded-lg text-[11px]"
                    style={{
                      background: selectedVersion?.id === v.id ? 'var(--accent-muted, var(--surface-container-low))' : 'var(--surface-container-low)',
                      border: `1px solid ${selectedVersion?.id === v.id ? 'var(--accent)' : 'var(--border)'}`,
                      color: 'var(--foreground)',
                    }}>
                    <span className="font-medium">v{v.version}</span>
                    <span style={{ color: 'var(--muted)' }}> &middot; {v.title}</span>
                  </button>
                ))}
                {selectedVersion && (
                  <div className="mt-2 p-3 rounded-lg" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border)' }}>
                    <div className="text-[10px] font-medium mb-1" style={{ color: 'var(--muted)' }}>v{selectedVersion.version} content:</div>
                    <div className="text-[12px] whitespace-pre-wrap" style={{ color: 'var(--foreground)', opacity: 0.8 }}
                      dangerouslySetInnerHTML={{ __html: sanitizeHtml(selectedVersion.content || '<em>Empty</em>') }} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {pendingDelete && (
        <div className="fixed inset-0 z-[94] flex items-center justify-center px-6 pointer-events-none">
          <div
            className="w-full max-w-[460px] rounded-2xl p-6 shadow-xl pointer-events-auto"
            style={{ background: 'var(--surface-container-highest)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
          >
            <div className="flex items-center gap-3 mb-3">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center"
                style={{ background: 'rgba(239,68,68,0.12)', color: 'var(--status-red)' }}
              >
                <Trash2 size={18} />
              </div>
              <div>
                <h3 className="text-[15px] font-semibold">Note deleted</h3>
                <p className="text-[12px]" style={{ color: 'var(--muted)' }}>
                  This note will disappear in a few seconds unless you undo it.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleUndoDelete}
                className="inline-flex items-center justify-center min-h-[44px] px-4 rounded-lg text-[13px] font-semibold"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                Undo delete
              </button>
              <button
                type="button"
                onClick={focusMode ? () => setFocusMode(false) : onBack}
                className="inline-flex items-center justify-center min-h-[44px] px-4 rounded-lg text-[13px] font-medium"
                style={{ background: 'var(--surface-container-low)', color: 'var(--foreground)' }}
              >
                Back to notes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Default Icon Setting ───────────────────────────────────
const DEFAULT_ICON_KEY = 'deft-note-default-icon';

function getDefaultIcon(): string {
  if (typeof window === 'undefined') return '\uD83D\uDCC4';
  return localStorage.getItem(DEFAULT_ICON_KEY) || '\uD83D\uDCC4';
}

function setDefaultIcon(icon: string) {
  localStorage.setItem(DEFAULT_ICON_KEY, icon);
}

// ── Main Page: Collection View ─────────────────────────────
export default function NotesPage() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [allNotes, setAllNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [defaultIconPickerOpen, setDefaultIconPickerOpen] = useState(false);
  const [currentDefault, setCurrentDefault] = useState(getDefaultIcon);
  const defaultIconBtnRef = useRef<HTMLButtonElement>(null);
  const [folders, setFolders] = useState<NoteFolder[]>([]);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<NoteTemplate[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [showOverflow, setShowOverflow] = useState(false);

  const activeId = searchParams.get('id');

  const loadNotes = useCallback(async () => {
    if (!user) return;
    const params = new URLSearchParams();
    if (activeFolderId) params.set('folder_id', activeFolderId);
    const res = await api.get(`/api/daily-notes?${params.toString()}`);
    if (res.ok) {
      const data = await res.json();
      setAllNotes(data);
    }
    setLoading(false);
  }, [user, activeFolderId]);

  const loadFolders = useCallback(async () => {
    const res = await api.get('/api/daily-notes/folders');
    if (res.ok) {
      const data = await res.json();
      setFolders(data.folders || []);
    }
  }, []);

  const loadTemplates = useCallback(async () => {
    const res = await api.get('/api/daily-notes/templates');
    if (res.ok) {
      const data = await res.json();
      setTemplates(data.templates || []);
    }
  }, []);

  useEffect(() => { loadNotes(); }, [loadNotes]);
  useEffect(() => { loadFolders(); loadTemplates(); }, [loadFolders, loadTemplates]);

  // Inject mobile-only search input into AppHeader (hidden on desktop via md:hidden)
  useSetPageContext(
    activeId ? null : (
      <div className="md:hidden flex items-center gap-2 flex-1 h-8 px-2 rounded-md"
        style={{ background: 'var(--surface-container)', border: '1px solid var(--border)' }}>
        <Search size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
        <input
          type="search"
          placeholder="Search notes…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 bg-transparent text-[0.8125rem] outline-none min-w-0"
          style={{ color: 'var(--on-surface)' }}
        />
      </div>
    ),
    [search, activeId]
  );

  const handleCreate = async (templateId?: string) => {
    let body: any = { title: '', icon: getDefaultIcon(), folder_id: activeFolderId };
    if (templateId) {
      const tmpl = templates.find(t => t.id === templateId);
      if (tmpl) {
        body = { title: tmpl.title, content: tmpl.content || '', icon: tmpl.icon, folder_id: activeFolderId };
      }
    }
    const res = await api.post('/api/daily-notes', body);
    if (res.ok) {
      const note = await res.json();
      setShowTemplates(false);
      router.push(`/notes?id=${note.id}`);
    }
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    await api.post('/api/daily-notes/folders', { name: newFolderName.trim() });
    setNewFolderName('');
    setShowNewFolder(false);
    loadFolders();
  };

  const handleOpenNote = (id: string) => {
    router.push(`/notes?id=${id}`);
  };

  const handleBack = () => {
    router.push('/notes');
    loadNotes(); // refresh list
  };

  const handleDeleted = () => {
    router.push('/notes');
    loadNotes();
  };

  // If a note is open, show the editor
  if (activeId) {
    return <NoteEditor noteId={activeId} onBack={handleBack} onDeleted={handleDeleted} />;
  }

  const filtered = search
    ? allNotes.filter(n => (n.title + ' ' + stripHtml(n.content || '')).toLowerCase().includes(search.toLowerCase()))
    : allNotes;

  const pinned = filtered.filter(n => n.is_pinned);
  const unpinned = filtered.filter(n => !n.is_pinned);

  // ── New Note button (shared between PageHeader primary and overflow menu) ──
  const newNoteButton = (
    <div className="relative">
      <button onClick={() => setShowTemplates(!showTemplates)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium text-white"
        style={{ background: 'var(--accent)' }}>
        <Plus size={14} /> New Note
      </button>
      {showTemplates && (
        <div className="absolute right-0 top-full mt-1 w-56 py-1 rounded-lg z-50"
          style={{ background: 'var(--surface-container-highest)', boxShadow: 'var(--glass-shadow)', border: '1px solid var(--border)' }}>
          <button onClick={() => handleCreate()}
            className="flex items-center gap-2 px-3 py-2 text-[12px] w-full text-left hover:opacity-80"
            style={{ color: 'var(--foreground)' }}>
            <FileText size={14} /> Blank Note
          </button>
          {templates.length > 0 && (
            <>
              <div className="my-1" style={{ borderTop: '1px solid var(--border)' }} />
              <div className="px-3 py-1 text-[10px] font-medium" style={{ color: 'var(--muted)' }}>Templates</div>
              {templates.map(t => (
                <button key={t.id} onClick={() => handleCreate(t.id)}
                  className="flex items-center gap-2 px-3 py-2 text-[12px] w-full text-left hover:opacity-80"
                  style={{ color: 'var(--foreground)' }}>
                  <span>{t.icon || '📄'}</span> {t.title}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="h-full overflow-y-auto">
      {/* ── PageHeader: title hidden on mobile (AppHeader carries search); primary = New Note ── */}
      <PageHeader
        title="Notes"
        description={`${allNotes.length} note${allNotes.length !== 1 ? 's' : ''}`}
        compact
        primary={newNoteButton}
        secondary={
          // Desktop: full search + folder bar + default-icon picker in secondary slot
          // Mobile: hidden — search is in AppHeader; folder/icon live in ••• overflow menu
          <div className="hidden md:flex flex-col gap-2">
            {/* Search */}
            <div className="flex items-center gap-2 px-3 h-9 rounded-lg"
              style={{ background: 'var(--surface-container)', border: '1px solid var(--border)' }}>
              <Search size={14} style={{ color: 'var(--muted)' }} />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search notes..."
                className="flex-1 bg-transparent text-[13px] outline-none"
                style={{ color: 'var(--foreground)' }} />
            </div>
            {/* Folder bar */}
            <div className="flex items-center gap-1 overflow-x-auto">
              <button onClick={() => setActiveFolderId(null)}
                className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium flex-shrink-0 transition-colors"
                style={{
                  background: !activeFolderId ? 'var(--accent)' : 'var(--surface-container)',
                  color: !activeFolderId ? 'white' : 'var(--muted)',
                }}>
                All Notes
              </button>
              {folders.map(f => (
                <button key={f.id} onClick={() => setActiveFolderId(f.id)}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium flex-shrink-0 transition-colors"
                  style={{
                    background: activeFolderId === f.id ? 'var(--accent)' : 'var(--surface-container)',
                    color: activeFolderId === f.id ? 'white' : 'var(--muted)',
                  }}>
                  <Folder size={11} /> {f.name}
                </button>
              ))}
              {showNewFolder ? (
                <div className="flex items-center gap-1">
                  <input value={newFolderName} onChange={e => setNewFolderName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') setShowNewFolder(false); }}
                    placeholder="Folder name..."
                    autoFocus
                    className="px-2 py-1 rounded-md text-[11px] outline-none w-24"
                    style={{ background: 'var(--surface-container)', border: '1px solid var(--accent)', color: 'var(--foreground)' }} />
                </div>
              ) : (
                <button onClick={() => setShowNewFolder(true)}
                  aria-label="New folder"
                  title="New folder"
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] flex-shrink-0"
                  style={{ color: 'var(--muted)' }}>
                  <FolderPlus size={11} />
                </button>
              )}
              {/* Default icon setting */}
              <div className="relative ml-auto">
                <button ref={defaultIconBtnRef}
                  onClick={() => setDefaultIconPickerOpen(!defaultIconPickerOpen)}
                  className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[12px]"
                  style={{ color: 'var(--muted)', border: '1px solid var(--border)' }}
                  title="Default icon for new notes">
                  <span className="text-[14px]">{currentDefault}</span>
                  <Settings2 size={12} />
                </button>
                {defaultIconPickerOpen && (
                  <EmojiPicker
                    anchorRef={defaultIconBtnRef}
                    onSelect={(emoji) => {
                      setDefaultIcon(emoji);
                      setCurrentDefault(emoji);
                      setDefaultIconPickerOpen(false);
                    }}
                    onClose={() => setDefaultIconPickerOpen(false)}
                  />
                )}
              </div>
            </div>
          </div>
        }
      />

      {/* ── Mobile-only: overflow ••• menu for folder filter + default-icon picker ── */}
      <div className="md:hidden px-4 pb-3">
        <div className="flex items-center gap-2">
          {/* Compact folder chips — show first 2 + overflow */}
          <div className="flex items-center gap-1 flex-1 overflow-x-auto">
            <button onClick={() => setActiveFolderId(null)}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium flex-shrink-0"
              style={{
                background: !activeFolderId ? 'var(--accent)' : 'var(--surface-container)',
                color: !activeFolderId ? 'white' : 'var(--muted)',
              }}>
              All Notes
            </button>
            {folders.map(f => (
              <button key={f.id} onClick={() => setActiveFolderId(f.id)}
                className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium flex-shrink-0"
                style={{
                  background: activeFolderId === f.id ? 'var(--accent)' : 'var(--surface-container)',
                  color: activeFolderId === f.id ? 'white' : 'var(--muted)',
                }}>
                <Folder size={11} /> {f.name}
              </button>
            ))}
          </div>
          {/* ••• overflow menu */}
          <div className="relative flex-shrink-0">
            <button
              onClick={() => setShowOverflow(!showOverflow)}
              aria-label="More options"
              title="More options"
              className="flex items-center justify-center w-8 h-8 rounded-lg"
              style={{ color: 'var(--muted)', border: '1px solid var(--border)' }}>
              <MoreHorizontal size={16} />
            </button>
            {showOverflow && (
              <>
                {/* Backdrop to close */}
                <div className="fixed inset-0 z-40" onClick={() => setShowOverflow(false)} />
                <div className="absolute right-0 top-full mt-1 w-52 py-1 rounded-lg z-50"
                  style={{ background: 'var(--surface-container-highest)', boxShadow: 'var(--glass-shadow)', border: '1px solid var(--border)' }}>
                  <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>Folders</div>
                  {showNewFolder ? (
                    <div className="px-3 py-1.5">
                      <input value={newFolderName} onChange={e => setNewFolderName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') { handleCreateFolder(); setShowOverflow(false); } if (e.key === 'Escape') setShowNewFolder(false); }}
                        placeholder="Folder name..."
                        autoFocus
                        className="w-full px-2 py-1 rounded-md text-[11px] outline-none"
                        style={{ background: 'var(--surface-container)', border: '1px solid var(--accent)', color: 'var(--foreground)' }} />
                    </div>
                  ) : (
                    <button onClick={() => setShowNewFolder(true)}
                      className="flex items-center gap-2 px-3 py-2 text-[12px] w-full text-left"
                      style={{ color: 'var(--foreground)' }}>
                      <FolderPlus size={13} /> New folder
                    </button>
                  )}
                  <div className="my-1" style={{ borderTop: '1px solid var(--border)' }} />
                  <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>Default note icon</div>
                  <div className="px-3 py-1.5 relative">
                    <button ref={defaultIconBtnRef}
                      onClick={() => setDefaultIconPickerOpen(!defaultIconPickerOpen)}
                      className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[12px]"
                      style={{ color: 'var(--muted)', border: '1px solid var(--border)' }}
                      title="Default icon for new notes">
                      <span className="text-[14px]">{currentDefault}</span>
                      <Settings2 size={12} />
                    </button>
                    {defaultIconPickerOpen && (
                      <EmojiPicker
                        anchorRef={defaultIconBtnRef}
                        onSelect={(emoji) => {
                          setDefaultIcon(emoji);
                          setCurrentDefault(emoji);
                          setDefaultIconPickerOpen(false);
                          setShowOverflow(false);
                        }}
                        onClose={() => setDefaultIconPickerOpen(false)}
                      />
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-[900px] mx-auto px-4 md:px-6 pb-8">

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 size={24} className="animate-spin" style={{ color: 'var(--muted)' }} />
          </div>
        ) : allNotes.length === 0 ? (
          <div className="text-center py-20">
            <FileText size={40} style={{ color: 'var(--muted)', opacity: 0.3 }} className="mx-auto mb-3" />
            <p className="text-[15px] font-medium mb-1" style={{ color: 'var(--foreground)' }}>No notes yet</p>
            <p className="text-[13px] mb-4" style={{ color: 'var(--muted)' }}>
              Create your first note to start capturing ideas.
            </p>
            <button onClick={() => handleCreate()}
              className="px-4 py-2 rounded-lg text-[13px] font-medium text-white"
              style={{ background: 'var(--accent)' }}>
              <Plus size={14} className="inline mr-1" /> Create Note
            </button>
          </div>
        ) : (
          <>
            {/* Pinned */}
            {pinned.length > 0 && (
              <div className="mb-6">
                <p className="text-[11px] font-semibold uppercase tracking-wider mb-3 flex items-center gap-1.5"
                  style={{ color: 'var(--muted)' }}>
                  <Pin size={11} /> Pinned
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {pinned.map(n => <NoteCard key={n.id} note={n} onClick={() => handleOpenNote(n.id)} />)}
                </div>
              </div>
            )}

            {/* All / Recent */}
            <div>
              {pinned.length > 0 && (
                <p className="text-[11px] font-semibold uppercase tracking-wider mb-3"
                  style={{ color: 'var(--muted)' }}>
                  {search ? 'Results' : 'Recent'}
                </p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {unpinned.map(n => <NoteCard key={n.id} note={n} onClick={() => handleOpenNote(n.id)} />)}
              </div>
              {filtered.length === 0 && search && (
                <p className="text-center py-10 text-[13px]" style={{ color: 'var(--muted)' }}>
                  No notes matching &ldquo;{search}&rdquo;
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
