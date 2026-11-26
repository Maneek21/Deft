'use client';

import { useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { FolderOpen, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { PageHeader } from '@/components/page-header';
import { useDrives } from '@/components/drive/drive-sidebar';
import { NewDriveDialog } from '@/components/drive/new-drive-dialog';

type WithoutManager = { id: string; name: string; icon: string | null; member_count: number; created_at: string };

async function fetchWithoutManager(path: string): Promise<{ drives: WithoutManager[] }> {
  const res = await api.get(path);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

const ROLE_LABEL: Record<string, string> = { full: 'Full access', edit: 'Can edit', comment: 'Can comment', view: 'Can view' };

export default function DrivePage() {
  const { user } = useAuth();
  const isGuest = user?.role === 'guest';
  const canSeeUnmanaged = user?.role === 'owner' || user?.role === 'admin';
  const { data, error, isLoading, mutate } = useDrives();
  const unmanaged = useSWR(canSeeUnmanaged ? '/api/drives/without-manager' : null, fetchWithoutManager);
  const [creating, setCreating] = useState(false);
  const visible = (data?.drives ?? []).filter((d) => d.role !== null && !d.frozen);

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader
        title="Drives"
        description="Documents and folders, organised by drive."
        primary={!isGuest ? (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[0.8125rem] font-medium text-white"
            style={{ background: 'var(--primary-container)' }}
          >
            <Plus size={14} strokeWidth={1.5} /> New drive
          </button>
        ) : undefined}
      />
      <div className="px-4 pb-8 flex flex-col gap-6 max-w-3xl">
        {error ? (
          <p className="text-[0.875rem]" style={{ color: 'var(--on-surface-variant)' }}>Could not load drives.</p>
        ) : isLoading ? (
          <p className="text-[0.875rem]" style={{ color: 'var(--outline)' }}>Loading...</p>
        ) : visible.length === 0 ? (
          <p className="text-[0.875rem]" style={{ color: 'var(--on-surface-variant)' }}>You don&apos;t have access to any drives yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {visible.map((drive) => (
              <li key={drive.id}>
                <Link
                  href={`/drive/${drive.id}`}
                  className="flex items-center gap-3 px-3 min-h-[44px] rounded-xl"
                  style={{ background: 'var(--surface)', color: 'var(--on-surface)' }}
                >
                  <span className="text-[1rem]">{drive.icon ?? <FolderOpen size={16} strokeWidth={1.5} />}</span>
                  <span className="flex-1 truncate text-[0.875rem] font-medium">{drive.kind === 'personal' ? 'My drive' : drive.name}</span>
                  <span className="text-[0.75rem]" style={{ color: 'var(--outline)' }}>
                    {drive.kind === 'open' ? 'Everyone' : drive.kind === 'personal' ? 'Only you' : 'Private'}
                    {drive.role ? ` · ${ROLE_LABEL[drive.role]}` : ''}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {canSeeUnmanaged && unmanaged.data && unmanaged.data.drives.length > 0 && (
          <section aria-label="Drives without a manager" className="flex flex-col gap-2">
            <h2 className="text-[0.9375rem] font-semibold" style={{ color: 'var(--on-surface)' }}>Drives without a manager</h2>
            <p className="text-[0.8125rem]" style={{ color: 'var(--on-surface-variant)' }}>
              Nobody in these private drives has full access. Open one to choose who manages it.
            </p>
            <ul className="flex flex-col gap-1">
              {unmanaged.data.drives.map((drive) => (
                <li key={drive.id}>
                  <Link
                    href={`/drive/${drive.id}`}
                    className="flex items-center gap-3 px-3 min-h-[44px] rounded-xl"
                    style={{ background: 'var(--surface)', color: 'var(--on-surface)' }}
                  >
                    <span className="flex-1 truncate text-[0.875rem] font-medium">{drive.name}</span>
                    <span className="text-[0.75rem]" style={{ color: 'var(--outline)' }}>
                      {drive.member_count} {drive.member_count === 1 ? 'member' : 'members'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {creating && <NewDriveDialog onClose={() => setCreating(false)} onCreated={() => { void mutate(); }} />}
    </div>
  );
}
