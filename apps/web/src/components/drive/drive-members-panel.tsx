'use client';

import useSWR from 'swr';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/time';

type Role = 'full' | 'edit' | 'comment' | 'view';
type Member = {
  id: string; principal_type: 'user' | 'space'; principal_id: string; role: Role; is_link: boolean; name: string | null;
};
type AdminChange = {
  id: string; change: string | null; principal_type: string | null; role: string | null; previous_role: string | null; created_at: string;
};
type MembersResponse = { members: Member[]; admin_changes: AdminChange[]; admin_path: boolean };

const ROLES: Role[] = ['full', 'edit', 'comment', 'view'];
const ROLE_LABEL: Record<Role, string> = { full: 'Full access', edit: 'Can edit', comment: 'Can comment', view: 'Can view' };

async function fetchMembers(path: string): Promise<MembersResponse> {
  const res = await api.get(path);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json() as Promise<MembersResponse>;
}

/** Hidden names come back null: show a neutral label, never an id (rule C4). */
const memberLabel = (m: Member) => m.name ?? (m.principal_type === 'space' ? 'A chat' : 'Someone');

function describeChange(change: AdminChange): string {
  const who = change.principal_type === 'space' ? 'a chat' : 'someone';
  const role = change.role ? ROLE_LABEL[change.role as Role]?.toLowerCase() ?? change.role : null;
  if (change.change === 'removed') return `An admin removed ${who} from this drive.`;
  if (change.change === 'added') return `An admin added ${who}${role ? ` (${role})` : ''}.`;
  return `An admin changed access for ${who}${role ? ` to ${role}` : ''}.`;
}

/** Members of a drive, for people with full access (or an admin opening the admin path). */
export function DriveMembersPanel({ driveId }: { driveId: string }) {
  const key = `/api/drives/${driveId}/members`;
  const { data, error, mutate } = useSWR<MembersResponse>(key, fetchMembers);
  const changeRole = async (member: Member, role: Role) => {
    await api.patch(`${key}/${member.id}`, { role });
    await mutate();
  };
  const remove = async (member: Member) => {
    await api.delete(`${key}/${member.id}`);
    await mutate();
  };
  if (error) return <p className="text-[0.8125rem]" style={{ color: 'var(--outline)' }}>Could not load the members.</p>;
  if (!data) return null;
  return (
    <section aria-label="Members" className="flex flex-col gap-2">
      <h2 className="text-[0.9375rem] font-semibold" style={{ color: 'var(--on-surface)' }}>Members</h2>
      {data.admin_path && (
        <p className="text-[0.8125rem]" style={{ color: 'var(--on-surface-variant)' }}>
          You are managing this drive as a workspace admin. You can change who has access, but you can&apos;t open it until you are a member.
        </p>
      )}
      {data.admin_changes.length > 0 && (
        <ul className="flex flex-col gap-1 text-[0.8125rem]" style={{ color: 'var(--on-surface-variant)' }}>
          {data.admin_changes.map((change) => (
            <li key={change.id}>{describeChange(change)} <span style={{ color: 'var(--outline)' }}>{formatRelative(change.created_at)}</span></li>
          ))}
        </ul>
      )}
      <ul className="flex flex-col">
        {data.members.map((member) => (
          <li key={member.id} className="flex items-center gap-2 py-1.5 text-[0.875rem]" style={{ color: 'var(--on-surface)' }}>
            <span className="flex-1 truncate">{memberLabel(member)}{member.is_link ? ' (linked chat)' : ''}</span>
            <select
              aria-label={`Role for ${memberLabel(member)}`}
              value={member.role}
              onChange={(e) => { void changeRole(member, e.target.value as Role); }}
              className="rounded-md px-2 py-1 text-[0.8125rem]"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--on-surface)' }}
            >
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
            <button
              type="button"
              onClick={() => { void remove(member); }}
              className="text-[0.8125rem] px-2 py-1 rounded-md"
              style={{ color: 'var(--outline)' }}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
