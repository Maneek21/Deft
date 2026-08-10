export type HuddleParticipant = {
  user_id: string;
  user_name: string;
  muted: boolean;
};

export type ActiveHuddleInfo = {
  huddle_id: string;
  participants: HuddleParticipant[];
};

export type HuddleSummary = ActiveHuddleInfo & {
  space_id: string;
  created_by?: string;
};

export type HuddleSocketError = {
  event: 'huddle:create' | 'huddle:list' | 'huddle:join' | 'huddle:leave' | 'huddle:signal' | 'huddle:mute';
  code: 'INVALID_PAYLOAD' | 'FORBIDDEN' | 'ROOM_NOT_FOUND' | 'NOT_PARTICIPANT' | 'TARGET_NOT_FOUND' | 'ALREADY_IN_HUDDLE' | 'INTERNAL_ERROR';
  message: string;
};

export type HuddleClientError = {
  id: number;
  source: 'microphone' | 'connection' | 'server' | 'state';
  message: string;
  code?: string;
};
