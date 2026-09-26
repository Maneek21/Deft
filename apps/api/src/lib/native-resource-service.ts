import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { orgMembers, users, webSessions } from '@deft/db/schema';
import { ResourceHostOrganizationIdSchema, ResourceOpaqueIdSchema, RESOURCE_LIMITS } from '@deft/shared/resources';
import { ResourceRefV2Schema, ResourceResolveResultV2Schema, RESOURCE_V2_CONTRACT_VERSIONS,
  type ResourceRefV2, type ResourceResolveResultV2 } from '@deft/shared/resources-v2';
import { db } from './db.js';
import { ResourceAuthorizationError } from './resource-authorization.js';
import type { NativeResourceDisplay, NativeResourceSubject } from './native-resource-types.js';
import { resolveNativeMessageDisplay, resolveNativeWikiDisplay, resolveNativeNoteDisplay } from './native-content-projections.js';
import { resolveNativeCalendarDisplay, resolveNativeFileDisplay } from './native-calendar-file-projections.js';
import { resolveNativePersonDisplay, resolveNativeTeamDisplay } from './native-directory-projections.js';
import { resolveAppRuntimeDisplay } from './app-runtime-resource-display.js';

const callerSchema = z.strictObject({ org_id: ResourceHostOrganizationIdSchema,
  user_id: ResourceOpaqueIdSchema, sid: z.string().uuid() });
export type NativeResourceWebCaller = z.infer<typeof callerSchema>;

function denied() {
  return new ResourceAuthorizationError('Resource access denied', 'RESOURCE_ACCESS_DENIED', 403);
}

async function liveSubject(caller: NativeResourceWebCaller): Promise<NativeResourceSubject> {
  const [row] = await db.select({ role: orgMembers.role, expires_at: webSessions.expires_at,
    revoked_at: webSessions.revoked_at }).from(webSessions)
    .innerJoin(orgMembers, and(eq(orgMembers.org_id, webSessions.org_id),
      eq(orgMembers.user_id, webSessions.user_id), eq(orgMembers.is_active, true)))
    .innerJoin(users, and(eq(users.id, webSessions.user_id), eq(users.kind, 'human'),
      eq(users.is_agent, false)))
    .where(and(eq(webSessions.id, caller.sid), eq(webSessions.org_id, caller.org_id),
      eq(webSessions.user_id, caller.user_id))).limit(1);
  if (!row || row.revoked_at || row.expires_at <= new Date()) throw denied();
  return { org_id: caller.org_id, user_id: caller.user_id, role: row.role };
}

function safeLabel(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  let label = '';
  for (const character of normalized) {
    if (label.length + character.length > RESOURCE_LIMITS.label_chars) break;
    label += character;
  }
  return label.trim() || 'Resource';
}

async function nativeDisplay(subject: NativeResourceSubject, ref: ResourceRefV2): Promise<NativeResourceDisplay | null> {
  if (ref.provider.kind !== 'core') return null;
  // Code-owned slots only: package strings never select an executable adapter.
  switch (ref.provider.provider_instance_id) {
    case 'messages': return resolveNativeMessageDisplay(subject, ref.resource_id);
    case 'wiki_pages': return resolveNativeWikiDisplay(subject, ref.resource_id);
    case 'notes': return resolveNativeNoteDisplay(subject, ref.resource_id);
    case 'files': return resolveNativeFileDisplay(subject, ref.resource_id);
    case 'calendar_events': return resolveNativeCalendarDisplay(subject, ref.resource_id);
    case 'people': return resolveNativePersonDisplay(subject, ref.resource_id);
    case 'teams': return resolveNativeTeamDisplay(subject, ref.resource_id);
  }
}

/** Web reads do not confer an Experience grant or a Runtime viewer credential. */
export class NativeResourceService {
  async resolve(callerValue: NativeResourceWebCaller, refValue: unknown,
    authorization?: string): Promise<ResourceResolveResultV2> {
    const caller = callerSchema.safeParse(callerValue);
    if (!caller.success) throw denied();
    const parsed = ResourceRefV2Schema.safeParse(refValue);
    if (!parsed.success) {
      throw new ResourceAuthorizationError('Resource reference is invalid', 'RESOURCE_REF_INVALID', 400);
    }
    const ref = parsed.data;
    try {
      const subject = await liveSubject(caller.data);
      const display: NativeResourceDisplay | null = ref.provider.kind === 'app_runtime'
        ? await resolveAppRuntimeDisplay(caller.data, ref, authorization)
        : await nativeDisplay(subject, ref);
      const current = await liveSubject(caller.data);
      // A role change during a private-team read cannot retain the old role's result.
      if (current.role !== subject.role) throw denied();
      const base = { schema_version: RESOURCE_V2_CONTRACT_VERSIONS.resolve, ref };
      if (!display) return ResourceResolveResultV2Schema.parse({ ...base, state: 'unavailable' });
      return ResourceResolveResultV2Schema.parse({ ...base, state: 'available', resource: {
        schema_version: RESOURCE_V2_CONTRACT_VERSIONS.safe_projection, ref,
        label: safeLabel(display.label),
        ...(display.revision === undefined ? {} : { revision: display.revision }),
        ...(display.updated_at === undefined ? {} : { updated_at: display.updated_at }),
      } });
    } catch (error) {
      if (error instanceof ResourceAuthorizationError) throw error;
      throw new ResourceAuthorizationError('Resource provider failed safely', 'RESOURCE_PROVIDER_FAILURE', 500);
    }
  }
}

export const nativeResourceService = new NativeResourceService();
