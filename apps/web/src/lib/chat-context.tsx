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
  avatar_url: string | null;
  status_emoji?: string | null;
  status_text?: string | null;
  kind?: 'human' | 'agent' | 'system';
};

type ChatContextType = {
  spaces: Space[];
  activeSpaceId: string | null;
  setActiveSpaceId: (id: string) => void;
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
