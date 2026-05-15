'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditor, EditorContent } from '@tiptap/react';
import { Node, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';

// ─── Mention node ─────────────────────────────────────────────────────
// Inline atom that renders as a styled pill in the composer and serializes
// to `<@uuid|name>` text markers when the message is sent. Parsing back
// from the same `span[data-mention-uuid]` format lets drafts round-trip.
// The pill colors match the same --accent token that space-chat.tsx uses
// for rendered mentions, so the composer preview matches the final message.
const MentionNode = Node.create({
  name: 'mention',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      uuid: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-mention-uuid'),
        renderHTML: (attrs) => ({ 'data-mention-uuid': attrs.uuid }),
      },
      name: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-mention-name'),
        renderHTML: (attrs) => ({ 'data-mention-name': attrs.name }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-mention-uuid]' }];
  },
  renderHTML({ HTMLAttributes, node }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        class: 'px-1 py-0.5 rounded text-[13px] font-medium',
        style: 'background:rgba(212,168,83,0.15);color:var(--accent)',
      }),
      `@${node.attrs.name ?? ''}`,
    ];
  },
  renderText({ node }) {
    return `<@${node.attrs.uuid}|${node.attrs.name}>`;
  },
});
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  CodeSquare,
  List,
  ListOrdered,
  Quote,
  Link as LinkIcon,
  Smile,
  Paperclip,
  Send,
  X,
  Image as ImageIcon,
  FileText,
  Clock,
  Mic,
  Plus,
} from 'lucide-react';
import { EmojiPicker } from './emoji-picker';
import { TaskAutocomplete } from './task-autocomplete';
import { MentionAutocomplete } from './mention-autocomplete';
import { SlashCommandAutocomplete } from './slash-command-autocomplete';
import { MobileActionSheet } from './mobile-action-sheet';

type TaskResult = {
  id: string;
  number: number;
  title: string;
  status: string;
  priority: string;
  project_prefix: string;
};

type PendingFile = { id: string; url: string; name: string; type: string; size: number };

type Props = {
  placeholder: string;
  onSend: (html: string, text: string) => void;
  onScheduleSend?: (isoTime: string, html: string, text: string) => void;
  pendingFiles: PendingFile[];
  onRemovePendingFile: (id: string) => void;
  onFileSelect: () => void;
  onPaste: (e: React.ClipboardEvent) => void;
  uploading: boolean;
  uploadProgress: number;
  disabled?: boolean;
  onEditLastMessage?: () => void;
  onViewScheduled?: () => void;
  onClipRecord?: () => void;
  onSlashCommand?: (command: string, args: string) => void;
  spaceId?: string;
};

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImageType(type: string) {
  return type.startsWith('image/');
}

export function RichComposer({
  placeholder,
  onSend,
  onScheduleSend,
  pendingFiles,
  onRemovePendingFile,
  onFileSelect,
  onPaste,
  uploading,
  uploadProgress,
  disabled,
  onEditLastMessage,
  onViewScheduled,
  onClipRecord,
  onSlashCommand,
  spaceId,
}: Props) {
  const [focused, setFocused] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [customScheduleTime, setCustomScheduleTime] = useState('');
  const scheduleBtnRef = useRef<HTMLButtonElement>(null);
  const [schedulePos, setSchedulePos] = useState<{ top: number; right: number } | null>(null);
  useEffect(() => {
    if (!scheduleOpen) return;
    const update = () => {
      const r = scheduleBtnRef.current?.getBoundingClientRect();
      if (!r) return;
      // Place popup above the schedule button, right-aligned to it.
      setSchedulePos({ top: r.top - 8, right: window.innerWidth - r.right });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [scheduleOpen]);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [formatSheetOpen, setFormatSheetOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [taskQuery, setTaskQuery] = useState('');
  const [showTaskAutocomplete, setShowTaskAutocomplete] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [showMentions, setShowMentions] = useState(false);
  // Anchor (start of @) + end (current cursor) at the moment the mention
  // autocomplete opened. Captured in onUpdate so handleMentionSelect can
  // delete the correct range even if the editor has lost focus (clicking
  // the dropdown blurs the editor, which resets selection.from to 0).
  const mentionRangeRef = useRef<{ from: number; to: number } | null>(null);
  const [slashQuery, setSlashQuery] = useState('');
  const [showSlashCommands, setShowSlashCommands] = useState(false);
  const emojiBtnRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const onEditLastMessageRef = useRef(onEditLastMessage);
  onEditLastMessageRef.current = onEditLastMessage;

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      // StarterKit bundles its own Link extension since TipTap 2.4; disable it
      // so our explicit Link.configure below is the only one registered.
      StarterKit.configure({
        codeBlock: { HTMLAttributes: { class: 'deft-code-block' } },
        code: { HTMLAttributes: { class: 'deft-inline-code' } },
        heading: false,
        link: false,
      }),
      Placeholder.configure({ placeholder }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { class: 'deft-link' },
      }),
      MentionNode,
    ],
    editorProps: {
      attributes: {
        class: 'deft-editor',
      },
      handleKeyDown(view, event) {
        // Arrow up when editor is empty → edit last message
        if (event.key === 'ArrowUp' && !event.shiftKey) {
          const text = view.state.doc.textContent;
          if (!text.trim() && onEditLastMessageRef.current) {
            event.preventDefault();
            onEditLastMessageRef.current();
            return true;
          }
        }
        // Don't send on Enter when autocomplete is open
        if (event.key === 'Enter' && !event.shiftKey) {
          const { from } = view.state.selection;
          const textBefore = view.state.doc.textBetween(Math.max(0, from - 20), from);
          if (textBefore.match(/#(\w*)$/) || textBefore.match(/@+(\w*)$/) || view.state.doc.textContent.match(/^\/(\w*)$/)) {
            // Prevent the default Enter behavior (which would insert a
            // newline) and let the autocomplete's document-level listener
            // handle the keystroke. Returning true + preventDefault stops
            // ProseMirror from running its own Enter handler.
            event.preventDefault();
            return true;
          }
          event.preventDefault();
          handleSend();
          return true;
        }
        // Don't handle arrow keys when autocomplete is open
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !event.shiftKey) {
          const { from } = view.state.selection;
          const textBefore = view.state.doc.textBetween(Math.max(0, from - 20), from);
          if (textBefore.match(/#(\w*)$/) || textBefore.match(/@(\w*)$/) || view.state.doc.textContent.match(/^\/(\w*)$/)) {
            return false;
          }
        }
        return false;
      },
    },
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    onUpdate: ({ editor }) => {
      const { from } = editor.state.selection;
      const textBefore = editor.state.doc.textBetween(Math.max(0, from - 20), from);

      // Task autocomplete (#)
      const hashMatch = textBefore.match(/#(\w*)$/);
      if (hashMatch) {
        setShowTaskAutocomplete(true);
        setTaskQuery(hashMatch[1]);
      } else {
        setShowTaskAutocomplete(false);
        setTaskQuery('');
      }

      // Mention autocomplete (@) — match one or more leading @ so typos
      // like "@@name" collapse to a single mention. Capture the range
      // of text that should be replaced when a suggestion is accepted,
      // so handleMentionSelect works even after the editor loses focus
      // on click.
      const atMatch = textBefore.match(/@+(\w*)$/);
      if (atMatch) {
        setShowMentions(true);
        setMentionQuery(atMatch[1]);
        mentionRangeRef.current = {
          from: from - atMatch[0].length,
          to: from,
        };
      } else {
        setShowMentions(false);
        setMentionQuery('');
        mentionRangeRef.current = null;
      }

      // Slash command autocomplete (/) — only show when typing the command name, not args
      const fullText = editor.state.doc.textContent;
      const slashMatch = fullText.match(/^\/(\w*)$/);
      if (slashMatch && !fullText.includes(' ')) {
        setShowSlashCommands(true);
        setSlashQuery(slashMatch[1] || '');
      } else {
        setShowSlashCommands(false);
        setSlashQuery('');
      }
    },
  });

  const handleSend = useCallback(() => {
    if (!editor) return;
    const html = editor.getHTML();
    const text = editor.getText();
    if (!text.trim() && pendingFiles.length === 0) return;

    // Intercept slash commands with args: "/command args..."
    const cmdMatch = text.trim().match(/^\/(\w+)\s+(.+)$/s);
    if (cmdMatch && onSlashCommand) {
      const cmdName = cmdMatch[1]!.toLowerCase();
      const args = cmdMatch[2]!.trim();
      const known = ['remind', 'task', 'status', 'note', 'mute', 'unmute', 'dnd', 'search'];
      if (known.includes(cmdName)) {
        editor.commands.clearContent();
        onSlashCommand(cmdName, args);
        return;
      }
    }

    // Also catch no-arg slash commands typed manually: "/mute", "/dnd"
    const bareCmd = text.trim().match(/^\/(\w+)$/);
    if (bareCmd && onSlashCommand) {
      const cmdName = bareCmd[1]!.toLowerCase();
      const noArgCmds = ['mute', 'unmute', 'dnd', 'search'];
      if (noArgCmds.includes(cmdName)) {
        editor.commands.clearContent();
        onSlashCommand(cmdName, '');
        return;
      }
    }

    onSend(html, text);
    editor.commands.clearContent();
  }, [editor, onSend, onSlashCommand, pendingFiles.length]);

  // Cmd+K for link
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k' && editor?.isFocused) {
        e.preventDefault();
        const existing = editor.getAttributes('link').href;
        setLinkUrl(existing || '');
        setLinkDialogOpen(true);
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [editor]);

  const applyLink = () => {
    if (!editor) return;
    if (linkUrl) {
      editor.chain().focus().extendMarkRange('link').setLink({ href: linkUrl }).run();
    } else {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    }
    setLinkDialogOpen(false);
    setLinkUrl('');
  };

  const handleEmoji = (emoji: string) => {
    editor?.chain().focus().insertContent(emoji).run();
  };

  const handleMentionSelect = (selected: { id: string; name: string }) => {
    if (!editor) return;
    // Use the range we captured in onUpdate — don't re-read selection
    // here because clicking the dropdown blurs the editor, which resets
    // editor.state.selection.from to 0 and would wipe out the wrong range.
    const range = mentionRangeRef.current;
    if (range) {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent([
          { type: 'mention', attrs: { uuid: selected.id, name: selected.name } },
          { type: 'text', text: ' ' },
        ])
        .run();
    }
    mentionRangeRef.current = null;
    setShowMentions(false);
  };

  const handleTaskSelect = (task: TaskResult) => {
    if (!editor) return;
    const { from } = editor.state.selection;
    const textBefore = editor.state.doc.textBetween(Math.max(0, from - 20), from);
    const hashMatch = textBefore.match(/#(\w*)$/);
    if (hashMatch) {
      const deleteFrom = from - hashMatch[0].length;
      editor.chain().focus()
        .deleteRange({ from: deleteFrom, to: from })
        .insertContent(`<task|${task.project_prefix}-${task.number}|${task.id}>`)
        .run();
    }
    setShowTaskAutocomplete(false);
  };

  if (!editor) return null;

  const hasContent = editor.getText().trim().length > 0 || pendingFiles.length > 0;

  return (
    <div className="px-6 py-3 flex-shrink-0 relative" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }} ref={composerRef}>
      {showSlashCommands && (
        <SlashCommandAutocomplete
          query={slashQuery}
          onSelect={(cmd) => {
            setShowSlashCommands(false);
            if (cmd.needsArgs) {
              // Replace editor content with "/<command> " so user can type args
              editor?.commands.setContent(`<p>/${cmd.name} </p>`);
              // Move cursor to end
              editor?.commands.focus('end');
            } else {
              // Execute immediately for no-arg commands
              editor?.commands.clearContent();
              onSlashCommand?.(cmd.name, '');
            }
          }}
          onClose={() => setShowSlashCommands(false)}
        />
      )}
      {showMentions && (
        <MentionAutocomplete
          query={mentionQuery}
          onSelect={handleMentionSelect}
          onClose={() => setShowMentions(false)}
        />
      )}
      {showTaskAutocomplete && (
        <TaskAutocomplete
          query={taskQuery}
          onSelect={handleTaskSelect}
          onClose={() => setShowTaskAutocomplete(false)}
          anchorRef={composerRef}
        />
      )}
      <div
        className="overflow-hidden"
        style={{
          background: 'var(--surface-container-low)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: focused ? '0 0 0 2px rgba(144, 128, 250, 0.3)' : 'none',
          transition: '150ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {/* Formatting toolbar — desktop only (hidden on < md) */}
        <div
          className="hidden md:flex items-center gap-0.5 px-2 pt-1.5 pb-0.5"
        >
          <ToolbarBtn
            active={editor.isActive('bold')}
            onClick={() => editor.chain().focus().toggleBold().run()}
            title="Bold (Cmd+B)"
          >
            <Bold size={14} strokeWidth={1.5} />
          </ToolbarBtn>
          <ToolbarBtn
            active={editor.isActive('italic')}
            onClick={() => editor.chain().focus().toggleItalic().run()}
            title="Italic (Cmd+I)"
          >
            <Italic size={14} strokeWidth={1.5} />
          </ToolbarBtn>
          <ToolbarBtn
            active={editor.isActive('strike')}
            onClick={() => editor.chain().focus().toggleStrike().run()}
            title="Strikethrough (Cmd+Shift+X)"
          >
            <Strikethrough size={14} strokeWidth={1.5} />
          </ToolbarBtn>

          <div className="w-px h-4 mx-0.5" style={{ background: 'var(--outline-variant)', opacity: 0.4 }} />

          <ToolbarBtn
            active={editor.isActive('code')}
            onClick={() => editor.chain().focus().toggleCode().run()}
            title="Inline code (Cmd+E)"
          >
            <Code size={14} strokeWidth={1.5} />
          </ToolbarBtn>
          <ToolbarBtn
            active={editor.isActive('codeBlock')}
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            title="Code block"
          >
            <CodeSquare size={14} strokeWidth={1.5} />
          </ToolbarBtn>

          <div className="w-px h-4 mx-0.5" style={{ background: 'var(--outline-variant)', opacity: 0.4 }} />

          <ToolbarBtn
            active={editor.isActive('bulletList')}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            title="Bullet list"
          >
            <List size={14} strokeWidth={1.5} />
          </ToolbarBtn>
          <ToolbarBtn
            active={editor.isActive('orderedList')}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            title="Numbered list"
          >
            <ListOrdered size={14} strokeWidth={1.5} />
          </ToolbarBtn>
          <ToolbarBtn
            active={editor.isActive('blockquote')}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            title="Blockquote"
          >
            <Quote size={14} strokeWidth={1.5} />
          </ToolbarBtn>

          <div className="w-px h-4 mx-0.5" style={{ background: 'var(--outline-variant)', opacity: 0.4 }} />

          <ToolbarBtn
            active={editor.isActive('link')}
            onClick={() => {
              const existing = editor.getAttributes('link').href;
              setLinkUrl(existing || '');
              setLinkDialogOpen(true);
            }}
            title="Link (Cmd+K)"
          >
            <LinkIcon size={14} strokeWidth={1.5} />
          </ToolbarBtn>
        </div>

        {/* Mobile composer action sheet — Insert (attach/emoji/voice) + Format (B/I/...) */}
        <MobileActionSheet
          open={formatSheetOpen}
          onClose={() => setFormatSheetOpen(false)}
          title="Compose"
        >
          {/* Insert section */}
          <div className="px-1 pb-2 text-[0.6875rem] font-semibold uppercase tracking-wider opacity-50">Insert</div>
          <div className="grid grid-cols-4 gap-2 mb-3">
            <button
              type="button"
              onClick={() => { setFormatSheetOpen(false); onFileSelect(); }}
              aria-label="Attach file"
              className="flex flex-col items-center justify-center gap-1 min-h-[44px] p-2 rounded-md"
              style={{ color: 'var(--on-surface-variant)' }}
            >
              <Paperclip size={18} strokeWidth={1.5} />
              <span className="text-[0.6875rem]">Attach</span>
            </button>
            <button
              type="button"
              onClick={() => { setFormatSheetOpen(false); setEmojiOpen(true); }}
              aria-label="Insert emoji"
              className="flex flex-col items-center justify-center gap-1 min-h-[44px] p-2 rounded-md"
              style={{ color: 'var(--on-surface-variant)' }}
            >
              <Smile size={18} strokeWidth={1.5} />
              <span className="text-[0.6875rem]">Emoji</span>
            </button>
            {onClipRecord && (
              <button
                type="button"
                onClick={() => { setFormatSheetOpen(false); onClipRecord(); }}
                aria-label="Record voice memo"
                className="flex flex-col items-center justify-center gap-1 min-h-[44px] p-2 rounded-md"
                style={{ color: 'var(--on-surface-variant)' }}
              >
                <Mic size={18} strokeWidth={1.5} />
                <span className="text-[0.6875rem]">Voice</span>
              </button>
            )}
          </div>

          {/* Format section */}
          <div className="px-1 pb-2 text-[0.6875rem] font-semibold uppercase tracking-wider opacity-50">Format</div>
          <div className="grid grid-cols-4 gap-2">
            <button
              type="button"
              onClick={() => { editor.chain().focus().toggleBold().run(); setFormatSheetOpen(false); }}
              aria-label="Bold"
              className="flex flex-col items-center justify-center gap-1 min-h-[44px] p-2 rounded-md"
              style={{
                color: editor.isActive('bold') ? 'var(--primary-container)' : 'var(--on-surface-variant)',
                background: editor.isActive('bold') ? 'rgba(144,128,250,0.15)' : 'transparent',
              }}
            >
              <Bold size={18} strokeWidth={1.5} />
              <span className="text-[0.6875rem]">Bold</span>
            </button>
            <button
              type="button"
              onClick={() => { editor.chain().focus().toggleItalic().run(); setFormatSheetOpen(false); }}
              aria-label="Italic"
              className="flex flex-col items-center justify-center gap-1 min-h-[44px] p-2 rounded-md"
              style={{
                color: editor.isActive('italic') ? 'var(--primary-container)' : 'var(--on-surface-variant)',
                background: editor.isActive('italic') ? 'rgba(144,128,250,0.15)' : 'transparent',
              }}
            >
              <Italic size={18} strokeWidth={1.5} />
              <span className="text-[0.6875rem]">Italic</span>
            </button>
            <button
              type="button"
              onClick={() => { editor.chain().focus().toggleStrike().run(); setFormatSheetOpen(false); }}
              aria-label="Strikethrough"
              className="flex flex-col items-center justify-center gap-1 min-h-[44px] p-2 rounded-md"
              style={{
                color: editor.isActive('strike') ? 'var(--primary-container)' : 'var(--on-surface-variant)',
                background: editor.isActive('strike') ? 'rgba(144,128,250,0.15)' : 'transparent',
              }}
            >
              <Strikethrough size={18} strokeWidth={1.5} />
              <span className="text-[0.6875rem]">Strike</span>
            </button>
            <button
              type="button"
              onClick={() => { editor.chain().focus().toggleCode().run(); setFormatSheetOpen(false); }}
              aria-label="Inline code"
              className="flex flex-col items-center justify-center gap-1 min-h-[44px] p-2 rounded-md"
              style={{
                color: editor.isActive('code') ? 'var(--primary-container)' : 'var(--on-surface-variant)',
                background: editor.isActive('code') ? 'rgba(144,128,250,0.15)' : 'transparent',
              }}
            >
              <Code size={18} strokeWidth={1.5} />
              <span className="text-[0.6875rem]">Code</span>
            </button>
            <button
              type="button"
              onClick={() => { editor.chain().focus().toggleCodeBlock().run(); setFormatSheetOpen(false); }}
              aria-label="Code block"
              className="flex flex-col items-center justify-center gap-1 min-h-[44px] p-2 rounded-md"
              style={{
                color: editor.isActive('codeBlock') ? 'var(--primary-container)' : 'var(--on-surface-variant)',
                background: editor.isActive('codeBlock') ? 'rgba(144,128,250,0.15)' : 'transparent',
              }}
            >
              <CodeSquare size={18} strokeWidth={1.5} />
              <span className="text-[0.6875rem]">Block</span>
            </button>
            <button
              type="button"
              onClick={() => { editor.chain().focus().toggleBulletList().run(); setFormatSheetOpen(false); }}
              aria-label="Bullet list"
              className="flex flex-col items-center justify-center gap-1 min-h-[44px] p-2 rounded-md"
              style={{
                color: editor.isActive('bulletList') ? 'var(--primary-container)' : 'var(--on-surface-variant)',
                background: editor.isActive('bulletList') ? 'rgba(144,128,250,0.15)' : 'transparent',
              }}
            >
              <List size={18} strokeWidth={1.5} />
              <span className="text-[0.6875rem]">Bullets</span>
            </button>
            <button
              type="button"
              onClick={() => { editor.chain().focus().toggleOrderedList().run(); setFormatSheetOpen(false); }}
              aria-label="Numbered list"
              className="flex flex-col items-center justify-center gap-1 min-h-[44px] p-2 rounded-md"
              style={{
                color: editor.isActive('orderedList') ? 'var(--primary-container)' : 'var(--on-surface-variant)',
                background: editor.isActive('orderedList') ? 'rgba(144,128,250,0.15)' : 'transparent',
              }}
            >
              <ListOrdered size={18} strokeWidth={1.5} />
              <span className="text-[0.6875rem]">Numbered</span>
            </button>
            <button
              type="button"
              onClick={() => { editor.chain().focus().toggleBlockquote().run(); setFormatSheetOpen(false); }}
              aria-label="Blockquote"
              className="flex flex-col items-center justify-center gap-1 min-h-[44px] p-2 rounded-md"
              style={{
                color: editor.isActive('blockquote') ? 'var(--primary-container)' : 'var(--on-surface-variant)',
                background: editor.isActive('blockquote') ? 'rgba(144,128,250,0.15)' : 'transparent',
              }}
            >
              <Quote size={18} strokeWidth={1.5} />
              <span className="text-[0.6875rem]">Quote</span>
            </button>
            <button
              type="button"
              onClick={() => {
                const existing = editor.getAttributes('link').href;
                setLinkUrl(existing || '');
                setFormatSheetOpen(false);
                setLinkDialogOpen(true);
              }}
              aria-label="Link"
              className="flex flex-col items-center justify-center gap-1 min-h-[44px] p-2 rounded-md"
              style={{
                color: editor.isActive('link') ? 'var(--primary-container)' : 'var(--on-surface-variant)',
                background: editor.isActive('link') ? 'rgba(144,128,250,0.15)' : 'transparent',
              }}
            >
              <LinkIcon size={18} strokeWidth={1.5} />
              <span className="text-[0.6875rem]">Link</span>
            </button>
          </div>
        </MobileActionSheet>

        {/* Editor row — mobile uses single-row layout with [+] and [send] flanking the editor.
            Desktop renders only the editor (the +/send below are md:hidden) and uses the
            bottom toolbar for those actions instead. */}
        <div className="flex items-end gap-1 md:block">
          {/* Mobile-only "+" — opens unified compose sheet (Insert + Format) */}
          <button
            type="button"
            onClick={() => setFormatSheetOpen(true)}
            aria-label="Add (format, attach, emoji, voice)"
            className="md:hidden flex items-center justify-center min-w-[44px] min-h-[44px] flex-shrink-0 rounded-md hover:opacity-70 ml-1 mb-1"
            style={{ color: 'var(--on-surface-variant)' }}
          >
            <Plus size={20} strokeWidth={1.5} />
          </button>

          <div
            className="flex-1 min-w-0 px-3 md:px-4 py-2 min-h-[40px] max-h-[200px] overflow-y-auto"
            onPaste={onPaste as unknown as React.ClipboardEventHandler<HTMLDivElement>}
          >
            <EditorContent editor={editor} />
          </div>

          {/* Mobile-only inline send — desktop uses the send button in the bottom toolbar instead */}
          <button
            type="button"
            onClick={handleSend}
            disabled={!hasContent}
            aria-label="Send message"
            className="md:hidden flex items-center justify-center min-w-[44px] min-h-[44px] flex-shrink-0 rounded-md text-white disabled:opacity-40 hover:opacity-90 transition-opacity mr-1 mb-1"
            style={{ background: 'var(--primary-container)', borderRadius: 'var(--radius-md)' }}
          >
            <Send size={18} strokeWidth={2} />
          </button>
        </div>

        {/* Upload progress */}
        {uploading && (
          <div className="px-4 py-1">
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: 'var(--surface)' }}>
                <div className="h-full rounded-full" style={{ background: 'var(--accent)', width: `${uploadProgress}%`, transition: 'width 200ms' }} />
              </div>
              <span className="text-[10px]" style={{ color: 'var(--muted)' }}>{uploadProgress}%</span>
            </div>
          </div>
        )}

        {/* Pending files */}
        {pendingFiles.length > 0 && (
          <div className="px-3 py-1.5 flex gap-2 flex-wrap">
            {pendingFiles.map((file) => (
              <div
                key={file.id}
                className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px]"
                style={{ background: 'var(--surface-container)' }}
              >
                {isImageType(file.type) ? <ImageIcon size={12} style={{ color: 'var(--muted)' }} /> : <FileText size={12} style={{ color: 'var(--muted)' }} />}
                <span className="max-w-[100px] truncate" style={{ color: 'var(--foreground-secondary)' }}>{file.name}</span>
                <button onClick={() => onRemovePendingFile(file.id)} className="p-0.5" style={{ color: 'var(--muted)' }}>
                  <X size={10} strokeWidth={1.5} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Bottom toolbar: emoji, attach, send — desktop only.
            Mobile consolidates these into the "+" sheet + inline send. */}
        <div className="hidden md:flex items-center justify-between px-2.5 pb-1.5 pt-0.5">
          <div className="flex items-center gap-0.5">
            <button
              className="p-1.5 rounded-md"
              style={{ color: 'var(--muted)' }}
              title="Attach file"
              onClick={onFileSelect}
            >
              <Paperclip size={15} strokeWidth={1.5} />
            </button>
            <div className="relative">
              <button
                ref={emojiBtnRef}
                className="p-1.5 rounded-md"
                style={{ color: 'var(--muted)' }}
                title="Emoji"
                onClick={() => setEmojiOpen(!emojiOpen)}
              >
                <Smile size={15} strokeWidth={1.5} />
              </button>
              {emojiOpen && (
                <EmojiPicker
                  anchorRef={emojiBtnRef}
                  onSelect={handleEmoji}
                  onClose={() => setEmojiOpen(false)}
                />
              )}
            </div>
            {onClipRecord && (
              <button
                className="p-1.5 rounded-md"
                style={{ color: 'var(--muted)' }}
                title="Record audio clip"
                onClick={onClipRecord}
              >
                <Mic size={15} strokeWidth={1.5} />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1">
            {hasContent && (
              <div className="relative">
                <button ref={scheduleBtnRef} onClick={() => setScheduleOpen(!scheduleOpen)}
                  className="p-1.5 rounded-md" style={{ color: 'var(--outline)' }} title="Schedule send">
                  <Clock size={14} strokeWidth={1.5} />
                </button>
                {scheduleOpen && schedulePos && createPortal(
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setScheduleOpen(false)} />
                  <div
                    className="fixed w-60 py-2 rounded-lg z-50"
                    style={{
                      top: schedulePos.top,
                      right: schedulePos.right,
                      transform: 'translateY(-100%)',
                      background: 'var(--surface-container-high)',
                      border: '1px solid var(--outline-variant)',
                      boxShadow: 'var(--glass-shadow)',
                    }}
                  >
                    <div
                      className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide"
                      style={{ color: 'var(--outline)', fontFamily: 'var(--font-heading)' }}
                    >
                      Schedule for
                    </div>
                    {[
                      { label: 'In 30 minutes', mins: 30 },
                      { label: 'In 1 hour', mins: 60 },
                      { label: 'In 3 hours', mins: 180 },
                      { label: 'Tomorrow 9:00 AM', mins: null as number | null },
                    ].map((opt) => (
                      <button
                        key={opt.label}
                        onClick={() => {
                          const time = opt.mins
                            ? new Date(Date.now() + opt.mins * 60000)
                            : (() => {
                                const d = new Date();
                                d.setDate(d.getDate() + 1);
                                d.setHours(9, 0, 0, 0);
                                return d;
                              })();
                          const html = editor.getHTML();
                          const text = editor.getText();
                          onScheduleSend?.(time.toISOString(), html, text);
                          editor.commands.clearContent();
                          setScheduleOpen(false);
                        }}
                        className="w-full text-left px-3 py-1.5 text-[12px]"
                        style={{ color: 'var(--on-surface)' }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                      >
                        {opt.label}
                      </button>
                    ))}
                    <div className="h-px my-1" style={{ background: 'var(--outline-variant)' }} />
                    <div className="px-3 py-1.5 space-y-1.5">
                      <label
                        className="block text-[10px] font-semibold uppercase tracking-wide"
                        style={{ color: 'var(--outline)', fontFamily: 'var(--font-heading)' }}
                      >
                        Custom time
                      </label>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="datetime-local"
                          value={customScheduleTime}
                          min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
                          onChange={(e) => setCustomScheduleTime(e.target.value)}
                          className="flex-1 text-[11px] px-2 py-1 rounded-md outline-none"
                          style={{
                            background: 'var(--surface-container-low)',
                            color: 'var(--on-surface)',
                            border: '1px solid var(--outline-variant)',
                          }}
                        />
                        <button
                          disabled={!customScheduleTime}
                          onClick={() => {
                            const time = new Date(customScheduleTime);
                            if (isNaN(time.getTime()) || time.getTime() <= Date.now()) return;
                            const html = editor.getHTML();
                            const text = editor.getText();
                            onScheduleSend?.(time.toISOString(), html, text);
                            editor.commands.clearContent();
                            setCustomScheduleTime('');
                            setScheduleOpen(false);
                          }}
                          className="text-[11px] font-medium px-2 py-1 rounded-md disabled:opacity-40"
                          style={{ background: 'var(--primary-container)', color: 'var(--on-primary-container)' }}
                        >
                          Send
                        </button>
                      </div>
                    </div>
                    {onViewScheduled && (
                      <>
                        <div className="h-px my-1" style={{ background: 'var(--outline-variant)' }} />
                        <button
                          onClick={() => {
                            onViewScheduled();
                            setScheduleOpen(false);
                          }}
                          className="w-full text-left px-3 py-1.5 text-[12px]"
                          style={{ color: 'var(--primary)' }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
                          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                        >
                          View scheduled messages
                        </button>
                      </>
                    )}
                  </div>
                  </>,
                  document.body,
                )}
              </div>
            )}
            <button
              type="button"
              onClick={handleSend}
              disabled={!hasContent}
              aria-label="Send message"
              className="flex items-center justify-center min-w-[44px] min-h-[44px] rounded-md text-white disabled:opacity-40 hover:opacity-90 transition-opacity"
              style={{ background: 'var(--primary-container)', borderRadius: 'var(--radius-md)' }}
            >
              <Send size={16} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>

      {/* Link dialog */}
      {linkDialogOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30" onClick={() => setLinkDialogOpen(false)}>
          <div
            className="w-[360px] p-4 rounded-xl"
            style={{ background: 'var(--surface-container-highest)', boxShadow: 'var(--glass-shadow)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-[13px] font-medium mb-2" style={{ color: 'var(--text-primary)' }}>Insert link</p>
            <input
              autoFocus
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder="https://..."
              className="w-full px-3 py-2 rounded-lg text-[13px] outline-none"
              style={{ background: 'var(--surface-container-low)', color: 'var(--on-surface)' }}
              onKeyDown={(e) => { if (e.key === 'Enter') applyLink(); if (e.key === 'Escape') setLinkDialogOpen(false); }}
            />
            <div className="flex justify-end gap-2 mt-3">
              <button className="px-3 py-1.5 rounded-lg text-[12px]" style={{ color: 'var(--muted)' }} onClick={() => setLinkDialogOpen(false)}>Cancel</button>
              <button className="px-3 py-1.5 rounded-lg text-[12px] text-white" style={{ background: 'var(--accent)' }} onClick={applyLink}>Apply</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolbarBtn({ active, onClick, title, children }: { active: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="p-1 rounded-md"
      style={{
        color: active ? 'var(--primary-container)' : 'var(--outline)',
        background: active ? 'rgba(144, 128, 250, 0.15)' : 'transparent',
        transition: '150ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      {children}
    </button>
  );
}
