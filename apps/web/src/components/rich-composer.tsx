'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
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
} from 'lucide-react';
import { EmojiPicker } from './emoji-picker';
import { TaskAutocomplete } from './task-autocomplete';
import { MentionAutocomplete } from './mention-autocomplete';
import { SlashCommandAutocomplete } from './slash-command-autocomplete';

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
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [taskQuery, setTaskQuery] = useState('');
  const [showTaskAutocomplete, setShowTaskAutocomplete] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [showMentions, setShowMentions] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [showSlashCommands, setShowSlashCommands] = useState(false);
  const emojiBtnRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const onEditLastMessageRef = useRef(onEditLastMessage);
  onEditLastMessageRef.current = onEditLastMessage;

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        codeBlock: { HTMLAttributes: { class: 'deft-code-block' } },
        code: { HTMLAttributes: { class: 'deft-inline-code' } },
        heading: false,
      }),
      Placeholder.configure({ placeholder }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { class: 'deft-link' },
      }),
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
          if (textBefore.match(/#(\w*)$/) || textBefore.match(/@(\w*)$/) || view.state.doc.textContent.match(/^\/(\w*)$/)) {
            return false; // Let autocomplete handler take it
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

      // Mention autocomplete (@)
      const atMatch = textBefore.match(/@(\w*)$/);
      if (atMatch) {
        setShowMentions(true);
        setMentionQuery(atMatch[1]);
      } else {
        setShowMentions(false);
        setMentionQuery('');
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
    const { from } = editor.state.selection;
    const textBefore = editor.state.doc.textBetween(Math.max(0, from - 20), from);
    const atMatch = textBefore.match(/@(\w*)$/);
    if (atMatch) {
      const deleteFrom = from - atMatch[0].length;
      editor.chain().focus()
        .deleteRange({ from: deleteFrom, to: from })
        .insertContent(`<@${selected.id}|${selected.name}> `)
        .run();
    }
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
    <div className="px-6 py-3 flex-shrink-0 relative" ref={composerRef}>
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
        {/* Formatting toolbar */}
        <div
          className="flex items-center gap-0.5 px-2 pt-1.5 pb-0.5"
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

        {/* Editor area */}
        <div
          className="px-4 py-2 min-h-[40px] max-h-[200px] overflow-y-auto"
          onPaste={onPaste as unknown as React.ClipboardEventHandler<HTMLDivElement>}
        >
          <EditorContent editor={editor} />
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

        {/* Bottom toolbar: emoji, attach, send */}
        <div className="flex items-center justify-between px-2.5 pb-1.5 pt-0.5">
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
          {hasContent && (
            <div className="flex items-center gap-1">
              <div className="relative">
                <button onClick={() => setScheduleOpen(!scheduleOpen)}
                  className="p-1.5 rounded-md" style={{ color: 'var(--outline)' }} title="Schedule send">
                  <Clock size={14} strokeWidth={1.5} />
                </button>
                {scheduleOpen && (
                  <div className="absolute bottom-full right-0 mb-2 w-48 py-1 rounded-lg z-50"
                    style={{ background: 'var(--surface-container-highest)', boxShadow: 'var(--glass-shadow)' }}>
                    {[
                      { label: 'In 30 minutes', mins: 30 },
                      { label: 'In 1 hour', mins: 60 },
                      { label: 'In 3 hours', mins: 180 },
                      { label: 'Tomorrow 9:00 AM', mins: null as number | null },
                    ].map(opt => (
                      <button key={opt.label} onClick={() => {
                        const time = opt.mins
                          ? new Date(Date.now() + opt.mins * 60000)
                          : (() => { const d = new Date(); d.setDate(d.getDate()+1); d.setHours(9,0,0,0); return d; })();
                        const html = editor.getHTML();
                        const text = editor.getText();
                        onScheduleSend?.(time.toISOString(), html, text);
                        editor.commands.clearContent();
                        setScheduleOpen(false);
                      }}
                        className="w-full text-left px-3 py-1.5 text-[0.75rem]"
                        style={{ color: 'var(--on-surface-variant)' }}>
                        {opt.label}
                      </button>
                    ))}
                    {onViewScheduled && (
                      <>
                        <div className="h-px my-1" style={{ background: 'var(--ghost-border)' }} />
                        <button onClick={() => { onViewScheduled(); setScheduleOpen(false); }}
                          className="w-full text-left px-3 py-1.5 text-[0.75rem]"
                          style={{ color: 'var(--primary)' }}>
                          View scheduled messages
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
              <button
                onClick={handleSend}
                className="p-1.5 text-white"
                style={{ background: 'var(--primary-container)', borderRadius: 'var(--radius-md)' }}
              >
                <Send size={14} strokeWidth={1.5} />
              </button>
            </div>
          )}
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
