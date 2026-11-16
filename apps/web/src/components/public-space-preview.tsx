'use client';

import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Hash } from 'lucide-react';
import { api } from '@/lib/api';
import { useChatContext } from '@/lib/chat-context';
import { canPreviewSpace, joinPublicSpacePath, previewMessagesPath, publicSpaceDetailsPath } from '@/lib/public-spaces';
import { formatDayLabel, formatMessageTime, isSameDay } from '@/lib/time';
import { PersonAvatar } from './person-avatar';
import { ThreadMessageContent } from './thread-panel';
import { ProtectedDownload } from './protected-file';
import { ClipCard } from './clip-card';

type PreviewSpace = { id: string; name: string; type: string; topic?: string | null; description?: string | null; is_archived?: boolean };

type PreviewMessage = {
  id: string;
  content: string;
  user_name: string;
  user_avatar: string | null;
  created_at: string;
  is_deleted: boolean;
  reply_count?: number;
  metadata?: ComponentProps<typeof ThreadMessageContent>['metadata'];
  files?: Array<{ id: string; name: string }>;
};

type Props = {
  spaceId: string;
  highlightMessageId?: string;
  initialThreadId?: string;
  /** False while the list of joined spaces is still loading, so a joined space is not previewed by mistake. */
  ready: boolean;
};

const EMPTY = 'Select a space to start chatting';

function PreviewMessageBody({ message }: { message: PreviewMessage }) {
  if (message.is_deleted) return <p className="text-[13px] italic">This message was deleted</p>;
  const clip = message.content.match(/^\[\[clip:([^:]+):([^\]]+)\]\]/);
  return (
    <div className="text-[13px] whitespace-pre-wrap break-words">
      {clip
        ? <ClipCard clipId={clip[1]!} clipStatus={clip[2]!} clipUserName={message.user_name} />
        : <ThreadMessageContent content={message.content} metadata={message.metadata} />}
      {(message.files ?? []).map((file) => (
        <ProtectedDownload key={file.id} file={file} className="block text-[12px] underline">{file.name}</ProtectedDownload>
      ))}
    </div>
  );
}

function displayedMessage(message: PreviewMessage) {
  const metadata = message.metadata as Record<string, unknown> | undefined;
  return metadata?.hidden !== true && metadata?.kind !== 'tool_result';
}

/** Fetches only replies: opening a preview thread never marks it read or subscribes to writes. */
function PreviewThread({ parentId, onClose }: { parentId: string; onClose: () => void }) {
  const [replies, setReplies] = useState<PreviewMessage[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(false);
    void (async () => {
      try {
        const res = await api.get(`/api/messages/${encodeURIComponent(parentId)}/thread`);
        if (!res.ok) throw new Error('Thread unavailable');
        const data = await res.json();
        if (active) setReplies(data.replies ?? []);
      } catch {
        if (active) setError(true);
      }
    })();
    return () => { active = false; };
  }, [parentId, attempt]);
  return (
    <section aria-label="Thread" className="ml-3 my-2 border-l pl-3">
      <button type="button" onClick={onClose} className="text-[12px] underline">Close thread</button>
      {error ? <p role="alert">Could not load replies. <button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry</button></p>
        : replies === null ? <p role="status">Loading replies…</p>
          : replies.filter(displayedMessage).map((reply) => (
            <div key={reply.id} className="py-2">
              <p className="text-[12px] font-semibold">{reply.user_name} <span className="font-normal">{formatMessageTime(reply.created_at)}</span></p>
              <PreviewMessageBody message={reply} />
            </div>
          ))}
    </section>
  );
}

/**
 * Read-only view of a public space the viewer has not joined. It loads the
 * space and its messages through the same routes the chat uses and shows
 * them without any way to write: no composer, reactions, reply composer or
 * message menu. The Join button takes the composer's place; once the join
 * succeeds the space is in the joined list and the chat page shows the
 * normal view. A space the viewer may not read (private, archived, or the
 * viewer is a guest) shows the usual empty state.
 */
export function PublicSpacePreview({ spaceId, ready, highlightMessageId, initialThreadId }: Props) {
  const { refreshSpaces } = useChatContext();
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [space, setSpace] = useState<PreviewSpace | null>(null);
  const [messages, setMessages] = useState<PreviewMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(initialThreadId ?? null);
  const mounted = useRef(true);
  const bottom = useRef<HTMLDivElement>(null);
  const target = useRef<HTMLDivElement>(null);

  useEffect(() => { setThreadId(initialThreadId ?? null); }, [initialThreadId]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!ready) return;
    let active = true;
    setState('loading');
    void (async () => {
      try {
        const targetId = initialThreadId ?? highlightMessageId;
        const path = targetId ? `${previewMessagesPath(spaceId)}?around=${encodeURIComponent(targetId)}` : previewMessagesPath(spaceId);
        const [details, list] = await Promise.all([api.get(publicSpaceDetailsPath(spaceId)), api.get(path)]);
        if (!active) return;
        if (!details.ok || !list.ok) { setState('unavailable'); return; }
        const loaded: PreviewSpace = await details.json();
        const page = await list.json();
        if (!active) return;
        if (!canPreviewSpace(loaded)) { setState('unavailable'); return; }
        setSpace(loaded);
        setMessages(page.messages ?? []);
        setOlderCursor(page.next_cursor ?? null);
        setState('ready');
        requestAnimationFrame(() => (target.current ?? bottom.current)?.scrollIntoView());
      } catch {
        if (active) setState('unavailable');
      }
    })();
    return () => { active = false; };
  }, [spaceId, ready, highlightMessageId, initialThreadId]);

  const loadOlder = async () => {
    if (!olderCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const res = await api.get(previewMessagesPath(spaceId, olderCursor));
      if (!res.ok || !mounted.current) return;
      const page = await res.json();
      if (!mounted.current) return;
      setMessages((current) => [...(page.messages ?? []), ...current]);
      setOlderCursor(page.next_cursor ?? null);
    } finally {
      if (mounted.current) setLoadingOlder(false);
    }
  };

  const join = async () => {
    setJoining(true);
    setError(null);
    try {
      const res = await api.post(joinPublicSpacePath(spaceId));
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (mounted.current) setError(data.error || 'Could not join this space.');
        return;
      }
      // The chat page shows the normal view as soon as the space is in the joined list.
      refreshSpaces();
    } catch {
      if (mounted.current) setError('Could not join this space. Check your connection and try again.');
    } finally {
      if (mounted.current) setJoining(false);
    }
  };

  if (state !== 'ready' || !space) {
    return (
      <div className="flex items-center justify-center h-full" role="status" style={{ color: 'var(--muted)' }}>
        {state === 'loading' ? 'Loading…' : EMPTY}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" data-testid="public-space-preview">
      <header className="flex items-center gap-2 px-4 py-3 flex-shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <Hash size={16} strokeWidth={1.5} style={{ color: 'var(--muted)' }} />
        <div className="min-w-0">
          <h1 className="text-[14px] font-semibold truncate" style={{ color: 'var(--foreground)' }}>{space.name}</h1>
          <p className="text-[12px] truncate" style={{ color: 'var(--muted)' }}>
            Public space · you have not joined{space.topic || space.description ? ` · ${space.topic || space.description}` : ''}
          </p>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        {olderCursor && (
          <div className="flex justify-center pb-3">
            <button type="button" onClick={loadOlder} disabled={loadingOlder}
              className="px-3 py-1.5 rounded-lg text-[12px] font-medium disabled:opacity-50"
              style={{ background: 'var(--surface)', color: 'var(--foreground-secondary)' }}>
              {loadingOlder ? 'Loading…' : 'Show older messages'}
            </button>
          </div>
        )}
        {messages.length === 0 && (
          <p className="py-6 text-center text-[13px]" style={{ color: 'var(--muted)' }}>No messages yet.</p>
        )}
        {messages.filter(displayedMessage).map((message, index, displayed) => {
          const previous = displayed[index - 1];
          const newDay = !previous || !isSameDay(previous.created_at, message.created_at);
          return (
            <div key={message.id} ref={message.id === (initialThreadId ?? highlightMessageId) ? target : undefined}>
              {newDay && (
                <p className="py-2 text-center text-[11px] font-medium" style={{ color: 'var(--muted)' }}>{formatDayLabel(message.created_at)}</p>
              )}
              <div className="flex gap-3 py-1.5">
                <PersonAvatar name={message.user_name} avatarUrl={message.user_avatar} size={32} />
                <div className="flex-1 min-w-0">
                  <p className="text-[13px]">
                    <span className="font-semibold" style={{ color: 'var(--foreground)' }}>{message.user_name}</span>
                    <span className="ml-2 text-[11px]" style={{ color: 'var(--muted)' }}>{formatMessageTime(message.created_at)}</span>
                  </p>
                  <PreviewMessageBody message={message} />
                  {(message.reply_count ?? 0) > 0 && (
                    <button type="button" onClick={() => setThreadId(message.id)} className="text-[12px] underline" style={{ color: 'var(--muted)' }}>
                      {message.reply_count} {message.reply_count === 1 ? 'reply' : 'replies'}
                    </button>
                  )}
                  {threadId === message.id && <PreviewThread key={message.id} parentId={message.id} onClose={() => setThreadId(null)} />}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottom} />
      </div>

      <footer className="flex items-center gap-3 px-4 py-3 flex-shrink-0" style={{ borderTop: '1px solid var(--border)' }}>
        <div className="flex-1 min-w-0">
          <p className="text-[13px]" style={{ color: 'var(--foreground)' }}>You are reading this space without having joined it.</p>
          <p className="text-[12px]" style={{ color: error ? 'var(--danger)' : 'var(--muted)' }} role={error ? 'alert' : undefined}>
            {error ?? 'Join to post, reply and react.'}
          </p>
        </div>
        <button type="button" onClick={join} disabled={joining} aria-label={`Join ${space.name}`}
          className="px-4 py-2 rounded-lg text-[13px] font-medium text-white disabled:opacity-50"
          style={{ background: 'var(--accent)' }}>
          {joining ? 'Joining…' : 'Join'}
        </button>
      </footer>
    </div>
  );
}
