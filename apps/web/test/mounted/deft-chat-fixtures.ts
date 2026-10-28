/** Fixtures for the mounted chat regression tests. Shared by the API and socket boundaries. */

export type MountedMessage = {
  id: string;
  space_id: string;
  content: string;
  user_id: string;
  user_name: string;
  user_avatar: string | null;
  is_deleted: boolean;
  is_pinned?: boolean;
  edited_at: string | null;
  created_at: string;
  reactions: Array<{ emoji: string; count: number; users: string[] }>;
  reply_count: number;
  latest_reply_at: string | null;
  file_ids: string[];
};

export const THREAD_ROOT_ID = 't1';
export const DESTINATION_MESSAGE_ID = 'm2';
export const SPACE_ID = 's1';

export const THREAD_ROOT: MountedMessage = {
  id: THREAD_ROOT_ID,
  space_id: SPACE_ID,
  content: 'Launch is Friday. Earlier note: [the deploy plan](/chat?space=s1&message=m2)',
  user_id: 'u-priya',
  user_name: 'Priya Shah',
  user_avatar: null,
  is_deleted: false,
  edited_at: null,
  created_at: '2026-10-22T10:00:00.000Z',
  reactions: [],
  reply_count: 1,
  latest_reply_at: '2026-10-22T10:05:00.000Z',
  file_ids: [],
};

export const DESTINATION_MESSAGE: MountedMessage = {
  id: DESTINATION_MESSAGE_ID,
  space_id: SPACE_ID,
  content: 'Destination message from Priya',
  user_id: 'u-priya',
  user_name: 'Priya Shah',
  user_avatar: null,
  is_deleted: false,
  edited_at: null,
  created_at: '2026-10-22T10:10:00.000Z',
  reactions: [],
  reply_count: 0,
  latest_reply_at: null,
  file_ids: [],
};

export const THREAD_REPLY: MountedMessage = {
  id: 'r1',
  space_id: SPACE_ID,
  content: 'See [the source message](/chat?space=s1&message=m2) for the detail.',
  user_id: 'u-rahul',
  user_name: 'Rahul Mehta',
  user_avatar: null,
  is_deleted: false,
  edited_at: null,
  created_at: '2026-10-22T10:05:00.000Z',
  reactions: [],
  reply_count: 0,
  latest_reply_at: null,
  file_ids: [],
};

export const CHANNEL_MESSAGES: MountedMessage[] = [THREAD_ROOT, DESTINATION_MESSAGE];

export const SPACES = [{
  id: SPACE_ID,
  name: 'launch',
  type: 'channel',
  description: null,
  topic: null,
  is_default: true,
}];
