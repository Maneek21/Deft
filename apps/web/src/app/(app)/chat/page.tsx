'use client';

import { useEffect,useRef,useState } from 'react';
import { useRouter,useSearchParams } from 'next/navigation';
import { SpaceChat } from '@/components/space-chat';
import { ThreadPanel } from '@/components/thread-panel';
import { api, isSameWebSession } from '@/lib/api';
import { messageDeepLinkDestination } from '@/lib/message-deep-link';
import { useChatContext } from '@/lib/chat-context';

export default function ChatPage() {
  const searchParams = useSearchParams();
  const router=useRouter();
  const currentSearch=useRef(searchParams.toString());currentSearch.current=searchParams.toString();
  const { activeSpaceId, syncActiveSpaceIdFromUrl, spaces, threadMessage, setThreadMessage } = useChatContext();

  const urlSpaceId = searchParams.get('space');
  const urlMessageId = searchParams.get('message');
  const urlThreadId = searchParams.get('thread');
  const [messageLinkUnavailable, setMessageLinkUnavailable] = useState(false);

  // Bound both unavailable space discovery and a stalled message lookup.
  useEffect(() => {
    if (!urlMessageId || urlSpaceId) return;
    setMessageLinkUnavailable(false);
    const timeout = setTimeout(() => setMessageLinkUnavailable(true), 15000);
    return () => clearTimeout(timeout);
  }, [urlMessageId, urlSpaceId]);

  useEffect(() => {
    if (!urlMessageId || urlSpaceId || !spaces.length) return;
    const controller = new AbortController(), token = api.getAccessToken(), search = currentSearch.current;
    const current = () => !controller.signal.aborted && currentSearch.current === search && isSameWebSession(token, api.getAccessToken());
    setMessageLinkUnavailable(false);
    void api.fetch(`/api/messages/${encodeURIComponent(urlMessageId)}/thread`, { signal: controller.signal, cache: 'no-store' }).then(async response => {
      if (!response.ok) throw Error('Message unavailable');
      const destination = messageDeepLinkDestination(await response.json(), urlMessageId, spaces.map(space => space.id), search);
      if (!current()) return;
      if (!destination) throw Error('Message unavailable');
      if (!urlThreadId) setThreadMessage(null);
      router.replace(destination);
    }).catch(() => { if (current()) setMessageLinkUnavailable(true); });
    return () => controller.abort();
  }, [urlMessageId, urlSpaceId, urlThreadId, spaces, router, setThreadMessage]);

  // Sync layout's activeSpaceId state from the URL (back/forward, deep links).
  // MUST use the state-only setter — calling the navigating setActiveSpaceId
  // here re-issues a router.replace mid-transition and races against the
  // in-flight nav from the sidebar click, wedging the router and starving
  // React's event loop until the chat sidebar stops responding to clicks.
  useEffect(() => {
    if (urlSpaceId && urlSpaceId !== activeSpaceId && spaces.some(s => s.id === urlSpaceId)) {
      syncActiveSpaceIdFromUrl(urlSpaceId);
    }
  }, [urlSpaceId, activeSpaceId, spaces, syncActiveSpaceIdFromUrl]);

  useEffect(() => {
    if (!urlThreadId || threadMessage?.id === urlThreadId) return;

    let cancelled = false;
    async function loadThreadParent() {
      const res = await api.get(`/api/messages/${urlThreadId}/thread`);
      if (!res.ok) return;
      const data = await res.json();
      const parent = data.parent;
      if (!parent || cancelled) return;
      if (parent.space_id && parent.space_id !== activeSpaceId && spaces.some(s => s.id === parent.space_id)) {
        syncActiveSpaceIdFromUrl(parent.space_id);
      }
      setThreadMessage(parent);
    }
    loadThreadParent();
    return () => {
      cancelled = true;
    };
  }, [urlThreadId, threadMessage?.id, activeSpaceId, spaces, syncActiveSpaceIdFromUrl, setThreadMessage]);

  const effectiveSpaceId = urlSpaceId || threadMessage?.space_id || activeSpaceId;
  const activeSpace = spaces.find((s) => s.id === effectiveSpaceId);

  if (urlMessageId && !urlSpaceId) return <div className="flex h-full items-center justify-center" role="status" style={{ color: 'var(--muted)' }}>
    {messageLinkUnavailable ? 'This message is unavailable.' : 'Opening message…'}
  </div>;

  return (
    <div className="flex h-full">
      <div className="flex-1 min-w-0">
        {effectiveSpaceId && activeSpace ? (
          <SpaceChat
            spaceId={effectiveSpaceId}
            spaceName={activeSpace.name}
            spaceType={activeSpace.type}
            spaceTopic={activeSpace.topic}
            spaceDescription={activeSpace.description}
            highlightMessageId={urlMessageId || undefined}
          />
        ) : (
          <div
            className="flex items-center justify-center h-full"
            style={{ color: 'var(--muted)' }}
          >
            Select a space to start chatting
          </div>
        )}
      </div>
      {threadMessage && effectiveSpaceId && (
        <ThreadPanel
          parentMessage={threadMessage}
          spaceId={effectiveSpaceId}
          onClose={() => setThreadMessage(null)}
        />
      )}
    </div>
  );
}
