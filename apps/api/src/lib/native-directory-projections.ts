import { and, eq } from 'drizzle-orm';
import { orgMembers, teamMembers, teams, users } from '@deft/db/schema';
import { db } from './db.js';
import { canSeeTeam } from './mcp-tools/team-context.js';
import { visibleLiveMemberForOrg } from './member-visibility.js';
import type { NativeResourceDisplay, NativeResourceSubject } from './native-resource-types.js';

/** The directory owner exposes current members only. Its richer profile fields
 * never enter the generic resource projection. */
export async function resolveNativePersonDisplay(
  subject: NativeResourceSubject,
  id: string,
): Promise<NativeResourceDisplay | null> {
  const [viewer] = await db.select({ id: orgMembers.id })
    .from(orgMembers)
    .where(and(
      eq(orgMembers.org_id, subject.org_id),
      eq(orgMembers.user_id, subject.user_id),
      eq(orgMembers.is_active, true),
    ))
    .limit(1);
  if (!viewer) return null;

  const [person] = await db.select({ name: users.name, updated_at: users.updated_at })
    .from(users)
    .innerJoin(orgMembers, eq(orgMembers.user_id, users.id))
    .where(and(
      eq(users.id, id),
      eq(orgMembers.org_id, subject.org_id),
      eq(orgMembers.is_active, true),
      visibleLiveMemberForOrg(orgMembers.org_id),
    ))
    .limit(1);
  return person ? { label: person.name, updated_at: person.updated_at.toISOString() } : null;
}

/** Uses the existing team owner ACL with the viewer's current database role and
 * team membership; the host-supplied role is deliberately not trusted. */
export async function resolveNativeTeamDisplay(
  subject: NativeResourceSubject,
  id: string,
): Promise<NativeResourceDisplay | null> {
  const [team] = await db.select({
    name: teams.name,
    updated_at: teams.updated_at,
    visibility: teams.visibility,
    lead_user_id: teams.lead_user_id,
    current_user_role: teamMembers.role,
    org_role: orgMembers.role,
  })
    .from(teams)
    .innerJoin(orgMembers, and(
      eq(orgMembers.org_id, teams.org_id),
      eq(orgMembers.user_id, subject.user_id),
      eq(orgMembers.is_active, true),
    ))
    .leftJoin(teamMembers, and(
      eq(teamMembers.org_id, teams.org_id),
      eq(teamMembers.team_id, teams.id),
      eq(teamMembers.user_id, subject.user_id),
    ))
    .where(and(eq(teams.org_id, subject.org_id), eq(teams.id, id)))
    .limit(1);
  if (!team || !canSeeTeam(
    { org_id: subject.org_id, user_id: subject.user_id, role: team.org_role },
    team,
  )) return null;
  return { label: team.name, updated_at: team.updated_at.toISOString() };
}
