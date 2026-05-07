'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { SpaceChat } from '@/components/space-chat';
import { ThreadPanel } from '@/components/thread-panel';
import { useChatContext } from '@/lib/chat-context';

export default function ChatPage() {
  const searchParams = useSearchParams();
  const { activeSpaceId, syncActiveSpaceIdFromUrl, spaces, threadMessage, setThreadMessage } = useChatContext();

  const urlSpaceId = searchParams.get('space');
  const urlMessageId = searchParams.get('message');

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

  const effectiveSpaceId = urlSpaceId || activeSpaceId;
  const activeSpace = spaces.find((s) => s.id === effectiveSpaceId);

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
