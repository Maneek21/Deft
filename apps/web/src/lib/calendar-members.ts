export type CalendarMemberIdentity = {
  name?: string | null;
  email?: string | null;
};

export function calendarMemberDisplayName(member: CalendarMemberIdentity): string {
  const name = member.name?.trim();
  if (name) return name;

  const email = member.email?.trim();
  if (email) return email.split('@')[0] || email;

  return 'Unnamed member';
}

export function calendarMemberMatches(member: CalendarMemberIdentity, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  return calendarMemberDisplayName(member).toLowerCase().includes(query)
    || (member.email ?? '').toLowerCase().includes(query);
}
