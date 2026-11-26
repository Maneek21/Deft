'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { api } from '@/lib/api';
import { changeMemberRole, driveMembersKey, fetchJson, removeMember, useRefreshDrive, type MemberRole } from '@/lib/drive-actions';
import { formatRelative } from '@/lib/time';

type Role = MemberRole;
type Member = {
  id: string; principal_type: 'user' | 'space'; principal_id: string; role: Role; is_link: boolean; name: string | null;
};
type AdminChange = {
  id: string; change: string | null; principal_type: string | null; role: string | null; previous_role: string | null; created_at: string;
};
type MembersResponse = { members: Member[]; admin_changes: AdminChange[]; admin_path: boolean };

const ROLES: Role[] = ['full', 'edit', 'comment', 'view'];
const ROLE_LABEL: Record<Role, string> = { full: 'Full access', edit: 'Can edit', comment: 'Can comment', view: 'Can view' };

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
  const { data, error, mutate } = useSWR<MembersResponse>(driveMembersKey(driveId), fetchJson);
  const refreshDrive = useRefreshDrive(driveId);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const run = async (write: () => ReturnType<typeof removeMember>) => {
    if (pending) return;
    setPending(true);
    setMessage(null);
    const outcome = await write();
    if (!outcome.ok) setMessage(outcome.message);
    // Success or not, re-read: access may have changed under us (our own included).
    await Promise.all([mutate(), refreshDrive()]);
    setPending(false);
  };

  if (error) return <p role="alert" className="text-[0.8125rem]" style={{ color: 'var(--outline)' }}>Could not load the members.</p>;
  if (!data) return <p className="text-[0.8125rem]" style={{ color: 'var(--outline)' }}>Loading members...</p>;
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
      {message && <p role="alert" className="text-[0.8125rem]" style={{ color: 'var(--error, #b3261e)' }}>{message}</p>}
      <ul className="flex flex-col">
        {data.members.map((member) => (
          <li key={member.id} className="flex items-center gap-2 py-1.5 text-[0.875rem]" style={{ color: 'var(--on-surface)' }}>
            <span className="flex-1 truncate">{memberLabel(member)}{member.is_link ? ' (linked chat)' : ''}</span>
            <select
              aria-label={`Role for ${memberLabel(member)}`}
              value={member.role}
              disabled={pending}
              onChange={(e) => { const role = e.target.value as Role; void run(() => changeMemberRole(api, driveId, member.id, role)); }}
              className="rounded-md px-2 py-1 text-[0.8125rem] disabled:opacity-50"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--on-surface)' }}
            >
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
            <button
              type="button"
              disabled={pending}
              onClick={() => { void run(() => removeMember(api, driveId, member.id)); }}
              className="text-[0.8125rem] px-2 py-1 rounded-md disabled:opacity-50"
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
