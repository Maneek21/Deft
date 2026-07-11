'use client';

import { createContext, useContext } from 'react';

type Space = {
  id: string;
  name: string;
  type: string;
  description: string | null;
  topic: string | null;
  is_default: boolean;
  is_muted?: boolean;
  last_read_message_id?: string | null;
  last_read_at?: string | null;
};

type ThreadMessage = {
  id: string;
  content: string;
  space_id?: string;
  user_id: string;
  user_name: string;
  user_avatar: string | null;
  is_deleted: boolean;
  edited_at: string | null;
  created_at: string;
  reactions?: { emoji: string; count: number; users: string[] }[];
  file_ids?: string[];
};

type OrgMember = {
  id: string;
  name: string;
  email: string;
  kind?: 'human' | 'agent' | 'system';
  avatar_url: string | null;
  status_emoji?: string | null;
  status_text?: string | null;
};

type ChatContextType = {
  spaces: Space[];
  activeSpaceId: string | null;
  /** Navigates to the space — updates state AND pushes/replaces the URL. */
  setActiveSpaceId: (id: string) => void;
  /** State-only sync from URL. Does NOT navigate. Used by chat/page when the
   *  URL changes (back/forward, deep link) to keep activeSpaceId in step
   *  without re-entering setActiveSpaceId's router.replace and racing it. */
  syncActiveSpaceIdFromUrl: (id: string) => void;
  /** userId → 'online' | 'idle' | 'offline' */
  presence: Map<string, 'online' | 'idle' | 'offline'>;
  threadMessage: ThreadMessage | null;
  setThreadMessage: (msg: ThreadMessage | null) => void;
  unreadCounts: Map<string, number>;
  mentionCounts: Map<string, number>;
  markSpaceRead: (spaceId: string) => void;
  refreshSpaces: () => void;
  orgMembers: OrgMember[];
  openDmWith: (memberId: string) => Promise<void>;
  startHuddle?: (spaceId: string) => void;
  joinHuddleBySpace?: (spaceId: string) => void;
  huddleSpaceId?: string | null;
  activeHuddles: Map<string, { huddle_id: string; participants: { user_id: string; user_name: string; muted: boolean }[] }>;
};

export const ChatContext = createContext<ChatContextType>({
  spaces: [],
  activeSpaceId: null,
  setActiveSpaceId: () => {},
  syncActiveSpaceIdFromUrl: () => {},
  presence: new Map(),
  threadMessage: null,
  setThreadMessage: () => {},
  unreadCounts: new Map(),
  mentionCounts: new Map(),
  markSpaceRead: () => {},
  refreshSpaces: () => {},
  orgMembers: [],
  openDmWith: async () => {},
  startHuddle: async () => {},
  joinHuddleBySpace: async () => {},
  activeHuddles: new Map(),
});

export function useChatContext() {
  return useContext(ChatContext);
}
