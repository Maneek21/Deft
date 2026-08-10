import type { ActiveHuddleInfo, HuddleSummary } from './huddle-types';

export const HUDDLE_RESPONSE_TIMEOUT_MS = 15_000;

export function huddleResponseTimeoutMessage(event: 'huddle:create' | 'huddle:join'): string {
  return event === 'huddle:create'
    ? 'The huddle took too long to start. Your microphone was released; please try again.'
    : 'The huddle took too long to join. Your microphone was released; please try again.';
}

export type HuddleUpdate = {
  huddle_id: string;
  space_id?: string;
  participants: ActiveHuddleInfo['participants'];
};

export function huddlesFromSnapshot(huddles: HuddleSummary[]): Map<string, ActiveHuddleInfo> {
  return new Map(huddles.map((huddle) => [
    huddle.space_id,
    { huddle_id: huddle.huddle_id, participants: huddle.participants },
  ]));
}

export function applyHuddleUpdate(
  current: Map<string, ActiveHuddleInfo>,
  update: HuddleUpdate,
): Map<string, ActiveHuddleInfo> {
  const next = new Map(current);
  let spaceId = update.space_id;

  if (!spaceId) {
    for (const [candidateSpaceId, info] of next) {
      if (info.huddle_id === update.huddle_id) {
        spaceId = candidateSpaceId;
        break;
      }
    }
  }

  if (!spaceId) return next;
  if (update.participants.length === 0) {
    next.delete(spaceId);
  } else {
    next.set(spaceId, {
      huddle_id: update.huddle_id,
      participants: update.participants,
    });
  }
  return next;
}

export function removeEndedHuddle(
  current: Map<string, ActiveHuddleInfo>,
  ended: { huddle_id: string; space_id?: string },
): Map<string, ActiveHuddleInfo> {
  const next = new Map(current);
  if (ended.space_id) {
    const currentAtSpace = next.get(ended.space_id);
    if (!currentAtSpace || currentAtSpace.huddle_id === ended.huddle_id) {
      next.delete(ended.space_id);
    }
    return next;
  }

  for (const [spaceId, info] of next) {
    if (info.huddle_id === ended.huddle_id) {
      next.delete(spaceId);
      break;
    }
  }
  return next;
}

export function shouldCleanupEndedHuddle(activeHuddleId: string | null, endedHuddleId: string): boolean {
  return activeHuddleId === endedHuddleId;
}
