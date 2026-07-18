export type LocalClock = {
  dateKey: string;
  minutesSinceMidnight: number;
};

export function localClockAt(now: Date, timezone: string): LocalClock | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value;
    const year = value('year');
    const month = value('month');
    const day = value('day');
    const hour = Number(value('hour'));
    const minute = Number(value('minute'));
    if (!year || !month || !day || !Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null;
    }
    return {
      dateKey: `${year}-${month}-${day}`,
      minutesSinceMidnight: hour * 60 + minute,
    };
  } catch {
    return null;
  }
}

export function standupRunKey(orgId: string, localDateKey: string): string {
  return `standup:${orgId}:${localDateKey}`;
}

export function isStandupDue(
  now: Date,
  timezone: string,
  scheduledMinutes = 9 * 60,
): { due: boolean; dateKey?: string } {
  const local = localClockAt(now, timezone);
  if (!local) return { due: false };
  return {
    due: local.minutesSinceMidnight >= scheduledMinutes,
    dateKey: local.dateKey,
  };
}

export function meetingPrepWindow(now: Date, lookaheadMinutes = 30) {
  return {
    from: now,
    to: new Date(now.getTime() + lookaheadMinutes * 60_000),
  };
}

export function meetingPrepRunKey(eventId: string, startsAt: Date): string {
  return `meeting-prep:${eventId}:${startsAt.toISOString()}`;
}
