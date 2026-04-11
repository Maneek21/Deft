'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import LinkExt from '@tiptap/extension-link';
import {
  Plus, ArrowLeft, Loader2, Check, Trash2, Pin, PinOff,
  Bold, Italic, Strikethrough, List, ListOrdered, Quote, Code,
  Heading1, Heading2, Minus, FileText, Search, Settings2,
} from 'lucide-react';
import { EmojiPicker } from '@/components/emoji-picker';

type Note = {
  id: string;
  title: string;
  content: string | null;
  icon: string | null;
  is_pinned: boolean;
  created_at: string;
  updated_at: string;
};

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
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
function TBtn({ active, onClick, children, title }: { active?: boolean; onClick: () => void; children: React.ReactNode; title: string }) {
  return (
    <button onClick={onClick} title={title} className="p-1.5 rounded transition-colors"
      style={{ color: active ? 'var(--accent)' : 'var(--muted)', background: active ? 'var(--accent-subtle)' : 'transparent' }}>
      {children}
    </button>
  );
}

// ── Note Card ──────────────────────────────────────────────
function NoteCard({ note, onClick }: { note: Note; onClick: () => void }) {
  const preview = note.content ? stripHtml(note.content).slice(0, 120) : '';
  return (
    <div onClick={onClick}
      className="group p-4 rounded-xl cursor-pointer transition-all hover:shadow-sm"
      style={{ background: 'var(--surface-container)', border: '1px solid var(--border)' }}>
      <div className="flex items-start gap-2 mb-2">
        <span className="text-[18px] flex-shrink-0">{note.icon || '\uD83D\uDCC4'}</span>
        <div className="flex-1 min-w-0">
          <h3 className="text-[14px] font-semibold truncate"
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
  const [note, setNote] = useState<Note | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [title, setTitle] = useState('');
  const [icon, setIcon] = useState<string | null>(null);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const iconBtnRef = useRef<HTMLButtonElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const initialContentSet = useRef(false);
  const titleDebounce = useRef<ReturnType<typeof setTimeout>>(undefined);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2] },
        codeBlock: { HTMLAttributes: { class: 'deft-code-block' } },
        code: { HTMLAttributes: { class: 'deft-inline-code' } },
      }),
      Placeholder.configure({ placeholder: 'Start writing...' }),
      LinkExt.configure({ openOnClick: true, HTMLAttributes: { class: 'deft-link' } }),
    ],
    editorProps: { attributes: { class: 'deft-editor deft-notes-editor' } },
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

  useEffect(() => {
    setLoading(true);
    initialContentSet.current = false;
    api.get(`/api/daily-notes/${noteId}`).then(async res => {
      if (res.ok) {
        const data = await res.json();
        setNote(data);
        setTitle(data.title);
        setIcon(data.icon);
        if (editor) {
          editor.commands.setContent(data.content || '');
          setTimeout(() => { initialContentSet.current = true; }, 50);
        }
      }
      setLoading(false);
    });
  }, [noteId, editor]);

  const handleTitleChange = (value: string) => {
    setTitle(value);
    if (titleDebounce.current) clearTimeout(titleDebounce.current);
    titleDebounce.current = setTimeout(() => {
      api.patch(`/api/daily-notes/${noteId}`, { title: value });
    }, 500);
  };

  const handleIconChange = async (emoji: string) => {
    setIcon(emoji);
    setIconPickerOpen(false);
    await api.patch(`/api/daily-notes/${noteId}`, { icon: emoji });
  };

  const handleRemoveIcon = async () => {
    setIcon(null);
    setIconPickerOpen(false);
    await api.patch(`/api/daily-notes/${noteId}`, { icon: null });
  };

  const handlePin = async () => {
    if (!note) return;
    const pinned = !note.is_pinned;
    setNote({ ...note, is_pinned: pinned });
    await api.patch(`/api/daily-notes/${noteId}`, { is_pinned: pinned });
  };

  const handleDelete = async () => {
    await api.delete(`/api/daily-notes/${noteId}`);
    onDeleted();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="animate-spin" style={{ color: 'var(--muted)' }} />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[700px] mx-auto px-6 py-6">
        {/* Top bar */}
        <div className="flex items-center justify-between mb-4">
          <button onClick={onBack} className="flex items-center gap-1.5 text-[13px] font-medium px-2 py-1 rounded-lg"
            style={{ color: 'var(--muted)' }}>
            <ArrowLeft size={15} /> All Notes
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
            <button onClick={handlePin} className="p-1.5 rounded-lg"
              style={{ color: note?.is_pinned ? 'var(--accent)' : 'var(--muted)' }} title={note?.is_pinned ? 'Unpin' : 'Pin'}>
              {note?.is_pinned ? <PinOff size={15} /> : <Pin size={15} />}
            </button>
            <button onClick={handleDelete} className="p-1.5 rounded-lg"
              style={{ color: 'var(--muted)' }} title="Delete note">
              <Trash2 size={15} />
            </button>
          </div>
        </div>

        {/* Icon + Title */}
        <div className="flex items-start gap-2 mb-4">
          <div className="relative">
            <button ref={iconBtnRef} onClick={() => setIconPickerOpen(!iconPickerOpen)}
              className="text-[28px] p-1 rounded-lg hover:bg-white/5 transition-colors leading-none"
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
          <input value={title} onChange={e => handleTitleChange(e.target.value)}
            placeholder="Untitled"
            className="flex-1 text-[24px] font-bold bg-transparent outline-none mt-0.5"
            style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)', letterSpacing: '-0.02em' }} />
        </div>

        {/* Editor with toolbar */}
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)', background: 'var(--surface-container)' }}>
          {editor && (
            <div className="flex items-center gap-0.5 px-2 py-1.5 flex-wrap"
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
              <div className="w-px h-4 mx-1" style={{ background: 'var(--border)' }} />
              <TBtn active={editor.isActive('bulletList')}
                onClick={() => editor.chain().focus().toggleBulletList().run()} title="Bullet list">
                <List size={15} />
              </TBtn>
              <TBtn active={editor.isActive('orderedList')}
                onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Numbered list">
                <ListOrdered size={15} />
              </TBtn>
              <TBtn active={editor.isActive('blockquote')}
                onClick={() => editor.chain().focus().toggleBlockquote().run()} title="Quote">
                <Quote size={15} />
              </TBtn>
              <TBtn active={false}
                onClick={() => editor.chain().focus().setHorizontalRule().run()} title="Divider">
                <Minus size={15} />
              </TBtn>
            </div>
          )}
          <div className="px-4 py-3">
            <EditorContent editor={editor} />
          </div>
        </div>
      </div>
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

  const activeId = searchParams.get('id');

  const loadNotes = useCallback(async () => {
    if (!user) return;
    const res = await api.get('/api/daily-notes');
    if (res.ok) {
      const data = await res.json();
      setAllNotes(data);
    }
    setLoading(false);
  }, [user]);

  useEffect(() => { loadNotes(); }, [loadNotes]);

  const handleCreate = async () => {
    const res = await api.post('/api/daily-notes', { title: '', icon: getDefaultIcon() });
    if (res.ok) {
      const note = await res.json();
      router.push(`/notes?id=${note.id}`);
    }
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

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[900px] mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-[22px] font-semibold"
              style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)', letterSpacing: '-0.02em' }}>
              Notes
            </h1>
            <p className="text-[13px] mt-0.5" style={{ color: 'var(--muted)' }}>
              {allNotes.length} note{allNotes.length !== 1 ? 's' : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Default icon setting */}
            <div className="relative">
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
            <button onClick={handleCreate}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium text-white"
              style={{ background: 'var(--accent)' }}>
              <Plus size={14} /> New Note
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="mb-6">
          <div className="flex items-center gap-2 px-3 h-9 rounded-lg"
            style={{ background: 'var(--surface-container)', border: '1px solid var(--border)' }}>
            <Search size={14} style={{ color: 'var(--muted)' }} />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search notes..."
              className="flex-1 bg-transparent text-[13px] outline-none"
              style={{ color: 'var(--foreground)' }} />
          </div>
        </div>

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
            <button onClick={handleCreate}
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
