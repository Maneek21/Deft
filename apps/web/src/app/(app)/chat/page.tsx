'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { SpaceChat } from '@/components/space-chat';
import { ThreadPanel } from '@/components/thread-panel';
import { useChatContext } from '@/lib/chat-context';

export default function ChatPage() {
  const searchParams = useSearchParams();
  const { activeSpaceId, setActiveSpaceId, spaces, threadMessage, setThreadMessage } = useChatContext();

  const urlSpaceId = searchParams.get('space');
  const urlMessageId = searchParams.get('message');

  // If URL has ?space=, switch to that space
  useEffect(() => {
    if (urlSpaceId && urlSpaceId !== activeSpaceId && spaces.some(s => s.id === urlSpaceId)) {
      setActiveSpaceId(urlSpaceId);
    }
  }, [urlSpaceId, activeSpaceId, spaces, setActiveSpaceId]);

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
