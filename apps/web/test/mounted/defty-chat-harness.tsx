'use client';

import { useMemo, useState, type ContextType } from 'react';
import { createRoot } from 'react-dom/client';
import ChatPage from '@/app/(app)/chat/page';
import { ChatContext } from '@/lib/chat-context';
import { SPACES } from './deft-chat-fixtures';

type ChatContextValue = ContextType<typeof ChatContext>;
type ThreadMessage = ChatContextValue['threadMessage'];

/** Real chat page with the layout's chat-state provider and network/socket boundaries. */
function Harness() {
  const [threadMessage, setThreadMessage] = useState<ThreadMessage>(null);
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>('s1');

  const value = useMemo<ChatContextValue>(() => ({
    spaces: SPACES,
    activeSpaceId,
    setActiveSpaceId,
    syncActiveSpaceIdFromUrl: setActiveSpaceId,
    presence: new Map(),
    threadMessage,
    setThreadMessage,
    unreadCounts: new Map(),
    mentionCounts: new Map(),
    markSpaceRead: () => {},
    refreshSpaces: () => {},
    orgMembers: [],
    openDmWith: async () => {},
    startHuddle: async () => {},
    joinHuddleBySpace: async () => {},
    huddleSpaceId: null,
    huddleBusy: false,
    huddleError: null,
    clearHuddleError: () => {},
    activeHuddles: new Map(),
  }), [activeSpaceId, threadMessage]);

  return (
    <ChatContext.Provider value={value}>
      <ChatPage />
    </ChatContext.Provider>
  );
}

if (typeof window !== 'undefined') {
  localStorage.setItem('deft-access-token', 'mounted-test-token');
  createRoot(document.getElementById('root')!).render(<Harness />);
}
