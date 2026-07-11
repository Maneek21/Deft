'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { sanitizeHtml } from '@/lib/sanitize';
import { getSocket } from '@/lib/socket';
import { useAuth } from '@/lib/auth-context';
import { X, Smile, ArrowLeft } from 'lucide-react';
import { formatMessageTime } from '@/lib/time';
import { EmojiPicker } from './emoji-picker';
import { RichComposer } from './rich-composer';
import { useFileUpload } from './file-upload';
import { AgentActionCard, type AgentAction } from './agent-action-card';
import useSWR, { mutate as swrMutate } from 'swr';
import { normalizeInlineApprovalCopy } from '@/lib/agent-approval-copy';

type Reaction = {
  emoji: string;
  count: number;
  users: string[];
};

type Message = {
  id: string;
  content: string;
  space_id?: string;
  user_id: string;
  user_name: string;
  user_avatar: string | null;
  is_deleted: boolean;
  edited_at: string | null;
  created_at: string;
  reactions?: Reaction[];
  file_ids?: string[];
};

async function apiErrorMessage(res: Response, fallback: string) {
  const body = await res.json().catch(() => null);
  if (body && typeof body.error === 'string' && body.error.trim()) return body.error;
  if (body && typeof body.message === 'string' && body.message.trim()) return body.message;
  return fallback;
}

// formatTime imported as formatMessageTime from @/lib/time

function avatarColor(name: string) {
  const colors = ['#7C6B4F', '#5B7A6B', '#6B5D7A', '#7A5B5B', '#5B6B7A', '#7A6B5B'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

const SHORTCODE_TO_EMOJI: Record<string, string> = {
  thumbsup: '👍', thumbsdown: '👎', heart: '❤️', tada: '🎉', fire: '🔥',
  eyes: '👀', joy: '😂', open_mouth: '😮', pray: '🙏', white_check_mark: '✅',
  x: '❌', '100': '💯', rocket: '🚀', muscle: '💪', clap: '👏',
  thinking: '🤔', heart_eyes: '😍', cry: '😢', angry: '😡', handshake: '🤝',
  bulb: '💡', star: '⭐', trophy: '🏆', dart: '🎯',
  '+1': '👍', '-1': '👎', smile: '😄', laughing: '😂', wink: '😉',
  ok_hand: '👌', wave: '👋', raised_hands: '🙌',
};

function displayEmoji(emoji: string): string {
  if (/[^\x00-\x7F]/.test(emoji)) return emoji;
  const key = emoji.replace(/^:|:$/g, '').toLowerCase();
  return SHORTCODE_TO_EMOJI[key] || emoji;
}

function inlineFormat(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return escaped
    .replace(/`([^`]+)`/g, '<code style="background:var(--surface-container-highest);color:var(--tertiary);padding:1px 5px;border-radius:4px;font-family:var(--font-mono);font-size:0.75rem">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
}

function renderSimpleMarkdown(text: string): string {
  if (!text) return '';

  const codeBlocks: string[] = [];
  let processed = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    codeBlocks.push(`<pre style="background:var(--surface-container-low);border-radius:6px;padding:12px 16px;font-family:var(--font-mono);font-size:0.75rem;line-height:1.5;margin:8px 0;overflow-x:auto"><code>${code.trim()}</code></pre>`);
    return `%%CODEBLOCK_${codeBlocks.length - 1}%%`;
  });

  const paragraphs = processed.split(/\n\n+/);
  const htmlParts: string[] = [];

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    const cbMatch = trimmed.match(/^%%CODEBLOCK_(\d+)%%$/);
    if (cbMatch) { htmlParts.push(codeBlocks[parseInt(cbMatch[1]!)]!); continue; }

    const lines = trimmed.split('\n');
    const allListItems = lines.every(l => /^[-*] /.test(l.trim()) || /^\d+\. /.test(l.trim()));
    if (allListItems && lines.length > 0) {
      const isOrdered = /^\d+\. /.test(lines[0]!.trim());
      const tag = isOrdered ? 'ol' : 'ul';
      const items = lines.map(l => `<li>${inlineFormat(l.trim().replace(/^[-*] |^\d+\. /, ''))}</li>`).join('');
      htmlParts.push(`<${tag} style="list-style:${isOrdered ? 'decimal' : 'disc'};padding-left:20px;margin:4px 0">${items}</${tag}>`);
      continue;
    }

    const h2Match = trimmed.match(/^## (.+)$/);
    if (h2Match) { htmlParts.push(`<h2 style="font-size:15px;font-weight:600;margin:12px 0 6px">${inlineFormat(h2Match[1]!)}</h2>`); continue; }
    const h3Match = trimmed.match(/^### (.+)$/);
    if (h3Match) { htmlParts.push(`<h3 style="font-size:14px;font-weight:600;margin:10px 0 4px">${inlineFormat(h3Match[1]!)}</h3>`); continue; }

    if (trimmed.startsWith('> ')) {
      const quoteContent = lines.map(l => l.replace(/^> ?/, '')).join('<br/>');
      htmlParts.push(`<blockquote style="border-left:3px solid var(--primary-container);padding-left:12px;margin:6px 0;color:var(--on-surface-variant)">${inlineFormat(quoteContent)}</blockquote>`);
      continue;
    }

    const paraHtml = lines.map(l => inlineFormat(l)).join('<br/>');
    htmlParts.push(`<p style="margin:0 0 8px 0">${paraHtml}</p>`);
  }

  return htmlParts.join('');
}

function renderContent(content: string) {
  if (!content) return null;

  // Detect HTML content (from TipTap)
  const isHtml = content.startsWith('<') && /<\/?[a-z][\s>]/i.test(content);

  if (isHtml) {
    // Process mentions within HTML
    const processed = content
      .replace(/&lt;@([^|]+)\|([^&]+)&gt;/g,
        '<span class="px-1 py-0.5 rounded text-[13px] font-medium" style="background:rgba(144,128,250,0.15);color:var(--primary)">@$2</span>')
      .replace(/<@([^|]+)\|([^>]+)>/g,
        '<span class="px-1 py-0.5 rounded text-[13px] font-medium" style="background:rgba(144,128,250,0.15);color:var(--primary)">@$2</span>');
    return <span className="message-content" dangerouslySetInnerHTML={{ __html: sanitizeHtml(processed) }} />;
  }

  // Plain text / markdown (agent replies, seed data)
  let html = renderSimpleMarkdown(content);
  html = html
    .replace(/<@([^|]+)\|([^>]+)>/g,
      '<span style="background:var(--accent-muted);color:var(--primary);padding:1px 5px;border-radius:4px;font-weight:500">@$2</span>')
    .replace(/([A-Z]{2,6})-(\d+)/g,
      '<span style="background:var(--surface-container-highest);color:var(--primary);padding:1px 6px;border-radius:4px;font-family:var(--font-mono);font-size:0.75rem">$1-$2</span>');
  return <span className="message-content" dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />;
}

type Props = {
  parentMessage: Message;
  spaceId: string;
  onClose: () => void;
};

export function ThreadPanel({ parentMessage, spaceId, onClose }: Props) {
  const messageId = parentMessage.id;
  const { user } = useAuth();
  const router = useRouter();
  const [replies, setReplies] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [emojiPickerMsgId, setEmojiPickerMsgId] = useState<string | null>(null);
  const repliesEndRef = useRef<HTMLDivElement>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<{ id: string; url: string; name: string; type: string; size: number }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { uploadFile, uploading, progress: uploadProgress } = useFileUpload();

  const pendingBySpaceKey = spaceId
    ? `/api/agent/actions/pending-by-space?space_id=${spaceId}`
    : null;

  const { data: pendingByMessage } = useSWR(
    pendingBySpaceKey,
    async (url: string) => {
      const res = await api.get(url);
      if (!res.ok) return {} as Record<string, AgentAction[]>;
      const list: Array<AgentAction & { message_id: string }> = await res.json();
      const map: Record<string, AgentAction[]> = {};
      for (const action of list) {
        if (!action.message_id) continue;
        (map[action.message_id] ??= []).push(action);
      }
      return map;
    },
    { refreshInterval: 5000, fallbackData: {} },
  );

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const closeThread = useCallback(() => {
    router.replace(spaceId ? `/chat?space=${spaceId}` : '/chat');
    onClose();
  }, [onClose, router, spaceId]);

  // Sync ?thread= URL param on open. Closing owns URL cleanup explicitly via
  // closeThread; doing this in effect cleanup races with React dev remounts and
  // can strip a valid deep link before the thread has hydrated.
  useEffect(() => {
    const nextUrl = `/chat?space=${spaceId}&thread=${messageId}`;
    if (typeof window !== 'undefined' && `${window.location.pathname}${window.location.search}` === nextUrl) return;
    router.replace(nextUrl);
  }, [messageId, router, spaceId]);

  const scrollToBottom = useCallback(() => {
    repliesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Load thread replies only (parent message is passed as a prop)
  useEffect(() => {
    setLoading(true);
    setReplies([]);

    async function load() {
      try {
        const threadRes = await api.get(`/api/messages/${messageId}/thread`);

        if (threadRes.ok) {
          const data = await threadRes.json();
          setReplies(data.replies || data.messages || []);
        }
        // Mark thread as read
        api.post(`/api/messages/${messageId}/thread-read`).catch(() => {});
      } catch {
        // ignore
      } finally {
        setLoading(false);
        setTimeout(scrollToBottom, 100);
      }
    }
    load();
  }, [messageId, scrollToBottom]);

  // Socket listeners
  useEffect(() => {
    const token = localStorage.getItem('deft-access-token');
    if (!token) return;
    const socket = getSocket(token);

    const onNewMessage = (msg: Message & { parent_id?: string }) => {
      if (msg.parent_id === messageId) {
        setReplies((prev) => [...prev, msg]);
        if (pendingBySpaceKey) swrMutate(pendingBySpaceKey);
        setTimeout(scrollToBottom, 50);
      }
    };

    const onReactionAdded = (data: { message_id: string; emoji: string; user_id: string }) => {
      const updateReactions = (msgs: Message[]) =>
        msgs.map((m) => {
          if (m.id !== data.message_id) return m;
          const reactions = [...(m.reactions || [])];
          const existing = reactions.find((r) => r.emoji === data.emoji);
          if (existing) {
            if (!existing.users.includes(data.user_id)) {
              existing.count++;
              existing.users.push(data.user_id);
            }
          } else {
            reactions.push({ emoji: data.emoji, count: 1, users: [data.user_id] });
          }
          return { ...m, reactions };
        });

      setReplies(updateReactions);
    };

    const onReactionRemoved = (data: { message_id: string; emoji: string; user_id: string }) => {
      const updateReactions = (msgs: Message[]) =>
        msgs.map((m) => {
          if (m.id !== data.message_id) return m;
          let reactions = [...(m.reactions || [])];
          const existing = reactions.find((r) => r.emoji === data.emoji);
          if (existing) {
            existing.count--;
            existing.users = existing.users.filter((u) => u !== data.user_id);
            if (existing.count <= 0) {
              reactions = reactions.filter((r) => r.emoji !== data.emoji);
            }
          }
          return { ...m, reactions };
        });

      setReplies(updateReactions);
    };

    socket.on('message:new', onNewMessage);
    socket.on('reaction:added', onReactionAdded);
    socket.on('reaction:removed', onReactionRemoved);

    return () => {
      socket.off('message:new', onNewMessage);
      socket.off('reaction:added', onReactionAdded);
      socket.off('reaction:removed', onReactionRemoved);
    };
  }, [messageId, pendingBySpaceKey, scrollToBottom]);

  // Escape to close
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeThread();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [closeThread]);

  const handleRichSend = async (html: string, _text: string) => {
    let content = html;
    if (pendingFiles.length > 0) {
      const fileLines = pendingFiles.map(
        (f) => `[[file:${f.id}:${f.name}:${f.type}:${f.size}:${f.url}]]`
      );
      content = fileLines.join('\n') + '\n' + content;
    }
    setPendingFiles([]);
    await api.post(`/api/messages/${spaceId}`, { content, parent_id: messageId });
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          const result = await uploadFile(file);
          if (result) setPendingFiles((prev) => [...prev, result]);
        }
      }
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      const result = await uploadFile(file);
      if (result) setPendingFiles((prev) => [...prev, result]);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleReaction = async (msgId: string, emoji: string) => {
    await api.post(`/api/messages/${msgId}/reactions`, { emoji });
    setEmojiPickerMsgId(null);
  };

  const toggleReaction = async (msgId: string, emoji: string) => {
    const msg = msgId === messageId ? parentMessage : replies.find((r) => r.id === msgId);
    if (!msg) return;
    const reaction = msg.reactions?.find((r) => r.emoji === emoji);
    if (reaction && user && reaction.users.includes(user.id)) {
      await api.delete(`/api/messages/${msgId}/reactions/${encodeURIComponent(emoji)}`);
    } else {
      await api.post(`/api/messages/${msgId}/reactions`, { emoji });
    }
  };

  const renderPendingActions = (msgId: string) => {
    const actions = pendingByMessage?.[msgId] ?? [];
    if (actions.length === 0) return null;
    return (
      <div className="mt-3 space-y-2">
        {actions.map((action) => (
          <AgentActionCard
            key={action.id}
            action={action}
            variant="compact"
            onApprove={async () => {
              const res = await api.post(`/api/agent/actions/${action.id}/approve`, {});
              if (!res.ok) throw new Error(await apiErrorMessage(res, `Approve failed (${res.status})`));
              const body = await res.json().catch(() => ({ status: 'approved' }));
              if (pendingBySpaceKey) swrMutate(pendingBySpaceKey);
              return body;
            }}
            onReject={async () => {
              const res = await api.post(`/api/agent/actions/${action.id}/reject`, {});
              if (!res.ok) throw new Error(await apiErrorMessage(res, `Reject failed (${res.status})`));
              const body = await res.json().catch(() => ({ status: 'rejected' }));
              if (pendingBySpaceKey) swrMutate(pendingBySpaceKey);
              return body;
            }}
          />
        ))}
      </div>
    );
  };

  const renderMessage = (msg: Message, isParent = false) => {
    const color = avatarColor(msg.user_name || '');
    const inlineActions = pendingByMessage?.[msg.id] ?? [];
    const hasApprovalContext = inlineActions.length > 0 || Object.keys(pendingByMessage ?? {}).length > 0;
    const displayContent = normalizeInlineApprovalCopy(msg.content, hasApprovalContext);
    return (
      <div className={`flex gap-3 ${isParent ? 'py-3' : 'py-2'}`}>
        <div className="flex-shrink-0">
          {msg.user_avatar ? (
            <img src={msg.user_avatar} className="w-9 h-9 rounded-full" alt={msg.user_name} />
          ) : (
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-medium text-white"
              style={{ background: color }}
            >
              {msg.user_name?.charAt(0).toUpperCase()}
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span
              className="text-[13px] font-medium"
              style={{ color: 'var(--on-surface)' }}
            >
              {msg.user_name}
            </span>
            <span className="text-[11px]" style={{ color: 'var(--outline)', fontFamily: 'var(--font-mono)' }}>
              {formatMessageTime(msg.created_at)}
            </span>
          </div>
          {msg.is_deleted ? (
            <p className="text-[13px] italic mt-0.5" style={{ color: 'var(--muted)' }}>
              This message was deleted
            </p>
          ) : (
            <>
              <div
                className="text-[13px] break-words mt-0.5"
                style={{ color: 'var(--text-primary)', lineHeight: '20px' }}
              >
                {renderContent(displayContent)}
                {msg.edited_at && (
                  <span className="text-[10px] ml-1.5" style={{ color: 'var(--muted)' }}>
                    (edited)
                  </span>
                )}
              </div>

              {renderPendingActions(msg.id)}

              {/* Reactions */}
              {msg.reactions && msg.reactions.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {msg.reactions.map((reaction) => {
                    const userReacted = user ? reaction.users.includes(user.id) : false;
                    return (
                      <button
                        key={reaction.emoji}
                        onClick={() => toggleReaction(msg.id, reaction.emoji)}
                        className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px]"
                        style={{
                          background: userReacted ? 'var(--primary-container)' : 'var(--surface-container-highest)',
                          color: userReacted ? '#fff' : 'var(--on-surface)',
                          transition: '150ms cubic-bezier(0.16, 1, 0.3, 1)',
                        }}
                      >
                        <span>{displayEmoji(reaction.emoji)}</span>
                        <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                          {reaction.count}
                        </span>
                      </button>
                    );
                  })}
                  <div className="relative">
                    <button
                      onClick={() => setEmojiPickerMsgId(emojiPickerMsgId === msg.id ? null : msg.id)}
                      className="flex items-center justify-center w-9 h-9 md:w-6 md:h-6 rounded-md"
                      style={{ background: 'var(--surface-container-highest)', color: 'var(--outline)' }}
                    >
                      <Smile size={12} strokeWidth={1.5} />
                    </button>
                    {emojiPickerMsgId === msg.id && (
                      <EmojiPicker
                        onSelect={(emoji) => handleReaction(msg.id, emoji)}
                        onClose={() => setEmojiPickerMsgId(null)}
                      />
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div
      className={isMobile
        ? "fixed inset-0 z-50 flex flex-col"
        : "w-[400px] h-full flex flex-col flex-shrink-0"
      }
      style={{ background: 'var(--surface)', borderLeft: isMobile ? undefined : '1px solid var(--border)' }}
    >
      {/* Header */}
      <div
        className="px-4 h-[48px] flex items-center justify-between flex-shrink-0"
        style={isMobile ? { borderBottom: '1px solid var(--border, var(--ghost-border))' } : undefined}
      >
        <div className="flex items-center gap-2">
          {isMobile && (
            <button
              onClick={closeThread}
              className="flex items-center justify-center min-h-[44px] min-w-[44px] rounded-md mr-1"
              style={{ color: 'var(--muted)' }}
            >
              <ArrowLeft size={18} strokeWidth={1.5} />
            </button>
          )}
          <h3
            className="text-[14px] font-semibold"
            style={{ color: 'var(--text-primary)' }}
          >
            Thread
          </h3>
        </div>
        {!isMobile && (
          <button
            onClick={closeThread}
            className="flex items-center justify-center min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 md:p-1 rounded-md"
            style={{ color: 'var(--muted)' }}
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="flex gap-1.5">
              <div className="skeleton w-1.5 h-1.5 rounded-full" />
              <div className="skeleton w-1.5 h-1.5 rounded-full" style={{ animationDelay: '0.2s' }} />
              <div className="skeleton w-1.5 h-1.5 rounded-full" style={{ animationDelay: '0.4s' }} />
            </div>
          </div>
        ) : (
          <>
            {/* Parent message */}
            {parentMessage && (
              <div style={{ paddingBottom: '12px', marginBottom: '4px', background: 'var(--surface-container-low)', borderRadius: 'var(--radius-lg)', padding: '12px' }}>
                {renderMessage(parentMessage, true)}
              </div>
            )}

            {/* Reply count */}
            {replies.length > 0 && (
              <div className="flex items-center justify-center py-3">
                <span
                  className="text-[11px] font-semibold uppercase"
                  style={{ color: 'var(--outline)', letterSpacing: '0.05em', fontFamily: 'var(--font-mono)' }}
                >
                  {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
                </span>
              </div>
            )}

            {/* Replies */}
            {replies.map((reply) => (
              <div key={reply.id}>{renderMessage(reply)}</div>
            ))}
            <div ref={repliesEndRef} />
          </>
        )}
      </div>

      {/* Composer */}
      <div className="flex-shrink-0">
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          multiple
          onChange={handleFileSelect}
        />
        <RichComposer
          key={messageId}
          placeholder="Reply..."
          onSend={handleRichSend}
          pendingFiles={pendingFiles}
          onRemovePendingFile={(id) => setPendingFiles((prev) => prev.filter((f) => f.id !== id))}
          onFileSelect={() => fileInputRef.current?.click()}
          onPaste={handlePaste}
          uploading={uploading}
          uploadProgress={uploadProgress}
          spaceId={spaceId}
        />
      </div>
    </div>
  );
}
