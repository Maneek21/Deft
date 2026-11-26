'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import useSWR from 'swr';
import { FileText, Folder, FolderPlus, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { driveKey, driveTrashKey, driveWrite, fetchJson, isNoAccess, pageAccess, useRefreshDrive, type MemberRole } from '@/lib/drive-actions';
import { formatRelative } from '@/lib/time';
import { PageHeader } from '@/components/page-header';
import { useDrives, useDriveTree } from '@/components/drive/drive-sidebar';
import { DriveMembersPanel } from '@/components/drive/drive-members-panel';
import { buildDriveTree, type DriveTreeNode } from '@/lib/drive-tree';

type DriveDetail = { id: string; name: string; icon: string | null; kind: string; role: MemberRole | null };
type TrashItem = { id: string; title: string; icon: string | null; deleted_at: string };

function Nodes({ nodes, depth }: { nodes: DriveTreeNode[]; depth: number }) {
  return (
    <ul className="flex flex-col">
      {nodes.map((node) => (
        <li key={`${node.type}:${node.id}`}>
          {node.type === 'document' ? (
            <Link
              href={`/d/${node.id}`}
              className="flex items-center gap-2 min-h-[40px] rounded-lg text-[0.875rem]"
              style={{ paddingLeft: `${0.5 + depth * 1}rem`, color: 'var(--on-surface)' }}
            >
              <span className="text-[0.9375rem]">{node.icon ?? <FileText size={14} strokeWidth={1.5} style={{ opacity: 0.5 }} />}</span>
              <span className="truncate">{node.title || 'Untitled'}</span>
            </Link>
          ) : (
            <div
              className="flex items-center gap-2 min-h-[40px] text-[0.875rem] font-medium"
              style={{ paddingLeft: `${0.5 + depth * 1}rem`, color: 'var(--on-surface)' }}
            >
              <Folder size={14} strokeWidth={1.5} style={{ opacity: 0.5 }} />
              <span className="truncate">{node.title}</span>
            </div>
          )}
          {node.children.length > 0 && <Nodes nodes={node.children} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

export default function DriveDetailPage() {
  const { driveId } = useParams<{ driveId: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const refreshDrive = useRefreshDrive(driveId);
  const drive = useSWR<{ drive: DriveDetail }>(driveKey(driveId), fetchJson);
  const drives = useDrives();
  const role = drive.data?.drive.role ?? null;
  const { canEdit, canManage } = pageAccess(role);
  // A failed re-read after an access change means access is gone: never keep showing cached content.
  const noAccess = drive.error !== undefined && isNoAccess(drive.error);
  const tree = useDriveTree(drive.data && !drive.error ? driveId : null);
  const trash = useSWR<{ items: TrashItem[] }>(canEdit && !drive.error ? driveTrashKey(driveId) : null, fetchJson);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nodes = tree.data ? buildDriveTree(tree.data) : [];
  // Owners and admins may manage the members of a private drive they can't open.
  const adminCanManage = user?.role === 'owner' || user?.role === 'admin';

  const run = async (write: () => Promise<{ ok: boolean; message?: string }>) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const outcome = await write();
    if (!outcome.ok) setMessage(outcome.message ?? 'Something went wrong');
    setBusy(false);
  };

  const newDocument = () => run(async () => {
    const outcome = await driveWrite<{ document?: { id: string } }>(() => api.post('/api/documents', { drive_id: driveId }), 'Could not create the document');
    if (!outcome.ok) return outcome;
    const id = outcome.body.document?.id;
    if (!id) return { ok: false, message: 'Could not create the document' };
    await refreshDrive();
    router.push(`/d/${id}`);
    return { ok: true };
  });

  const newFolder = (event: React.FormEvent) => {
    event.preventDefault();
    const name = folderName?.trim();
    if (!name) return;
    void run(async () => {
      const outcome = await driveWrite(() => api.post('/api/doc-folders', { drive_id: driveId, name }), 'Could not create the folder');
      if (outcome.ok) { setFolderName(null); await refreshDrive(); }
      return outcome;
    });
  };

  const restore = (id: string) => run(async () => {
    const outcome = await driveWrite(() => api.post(`/api/documents/${id}/restore`), 'Could not restore that document');
    await refreshDrive();
    return outcome;
  });

  if (drive.error) {
    return (
      <div className="flex-1 overflow-y-auto">
        <PageHeader title="Drive" />
        <div className="px-4 pb-8 flex flex-col gap-6 max-w-3xl">
          <p role="alert" className="text-[0.875rem]" style={{ color: 'var(--on-surface-variant)' }}>
            {!noAccess
              ? 'Could not load this drive. Check your connection and try again.'
              : adminCanManage
                ? 'You can\'t open this drive, but you can manage who has access.'
                : 'You no longer have access to this drive, or it isn\'t available.'}
          </p>
          {noAccess && adminCanManage && <DriveMembersPanel driveId={driveId} />}
        </div>
      </div>
    );
  }
  if (!drive.data) return <div className="flex-1 p-4 text-[0.875rem]" style={{ color: 'var(--outline)' }}>Loading...</div>;

  const isMine = drives.data?.drives.some((d) => d.id === driveId && d.is_mine) ?? false;
  const title = isMine ? 'My drive' : drive.data.drive.name;
  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader
        title={title}
        primary={canEdit ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => setFolderName(folderName === null ? '' : null)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[0.8125rem] disabled:opacity-50"
              style={{ background: 'var(--surface)', color: 'var(--on-surface)' }}
            >
              <FolderPlus size={14} strokeWidth={1.5} /> New folder
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => { void newDocument(); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[0.8125rem] font-medium text-white disabled:opacity-50"
              style={{ background: 'var(--primary-container)' }}
            >
              <Plus size={14} strokeWidth={1.5} /> New document
            </button>
          </>
        ) : undefined}
      />
      <div className="px-4 pb-8 flex flex-col gap-6 max-w-3xl">
        {message && <p role="alert" className="text-[0.8125rem]" style={{ color: 'var(--error, #b3261e)' }}>{message}</p>}
        {folderName !== null && (
          <form onSubmit={newFolder} className="flex gap-2">
            <input
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              placeholder="Folder name"
              aria-label="Folder name"
              maxLength={200}
              autoFocus
              className="flex-1 rounded-lg px-3 py-2 text-[0.875rem]"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--on-surface)' }}
            />
            <button type="submit" disabled={busy || !folderName.trim()} className="px-3 py-1.5 rounded-lg text-[0.8125rem] disabled:opacity-50" style={{ background: 'var(--surface)', color: 'var(--on-surface)' }}>
              Create
            </button>
          </form>
        )}
        {tree.error ? (
          <p role="alert" className="text-[0.875rem]" style={{ color: 'var(--on-surface-variant)' }}>Could not load this drive.</p>
        ) : !tree.data ? (
          <p className="text-[0.875rem]" style={{ color: 'var(--outline)' }}>Loading...</p>
        ) : nodes.length === 0 ? (
          <p className="text-[0.875rem]" style={{ color: 'var(--on-surface-variant)' }}>
            {canEdit ? 'Nothing here yet. Start with a new document.' : 'Nothing here yet.'}
          </p>
        ) : (
          <Nodes nodes={nodes} depth={0} />
        )}
        {canManage && <DriveMembersPanel driveId={driveId} />}
        {canEdit && (
          <section aria-label="Trash" className="flex flex-col gap-2">
            <h2 className="text-[0.9375rem] font-semibold" style={{ color: 'var(--on-surface)' }}>Trash</h2>
            {trash.error ? (
              <p role="alert" className="text-[0.8125rem]" style={{ color: 'var(--on-surface-variant)' }}>Could not load the trash.</p>
            ) : !trash.data ? (
              <p className="text-[0.8125rem]" style={{ color: 'var(--outline)' }}>Loading...</p>
            ) : trash.data.items.length === 0 ? (
              <p className="text-[0.8125rem]" style={{ color: 'var(--outline)' }}>Deleted documents stay here for 30 days.</p>
            ) : (
              <ul className="flex flex-col">
                {trash.data.items.map((item) => (
                  <li key={item.id} className="flex items-center gap-2 min-h-[40px] text-[0.875rem]" style={{ color: 'var(--on-surface)' }}>
                    <span className="flex-1 truncate">{item.title || 'Untitled'}</span>
                    <span className="text-[0.75rem]" style={{ color: 'var(--outline)' }}>{formatRelative(item.deleted_at)}</span>
                    <button type="button" disabled={busy} onClick={() => { void restore(item.id); }} className="px-2 py-1 rounded-md text-[0.8125rem] disabled:opacity-50" style={{ color: 'var(--primary)' }}>
                      Restore
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
