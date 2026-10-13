'use client';

import { useEffect,useRef } from 'react';
import { useRouter,useSearchParams } from 'next/navigation';
import { SpaceChat } from '@/components/space-chat';
import { ThreadPanel } from '@/components/thread-panel';
import { api } from '@/lib/api';
import { useChatContext } from '@/lib/chat-context';
import {parseEmailChatContext,type EmailChatContext} from '@/lib/email-native-defty-context';

export default function ChatPage() {
  const searchParams = useSearchParams();
  const router=useRouter();
  const emailContext=parseEmailChatContext(searchParams.toString());
  const currentSearch=useRef(searchParams.toString());currentSearch.current=searchParams.toString();
  const clearEmailContext=(sent?:EmailChatContext)=>{const context=parseEmailChatContext(currentSearch.current);if(sent&&(!context||context.spaceId!==sent.spaceId||context.accountId!==sent.accountId||context.messageId!==sent.messageId))return;const params=new URLSearchParams(currentSearch.current);params.delete('email_account');params.delete('email_message');router.replace('/chat'+(params.size?'?'+params.toString():''),{scroll:false});};
  const { activeSpaceId, syncActiveSpaceIdFromUrl, spaces, threadMessage, setThreadMessage } = useChatContext();

  const urlSpaceId = searchParams.get('space');
  const urlMessageId = searchParams.get('message');
  const urlThreadId = searchParams.get('thread');

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
            emailContext={activeSpace.type==='dm'&&emailContext?.spaceId===effectiveSpaceId?emailContext:undefined}
            onClearEmailContext={clearEmailContext}
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
