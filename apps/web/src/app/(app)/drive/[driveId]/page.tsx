'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import useSWR, { useSWRConfig } from 'swr';
import { FileText, Folder, FolderPlus, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { formatRelative } from '@/lib/time';
import { PageHeader } from '@/components/page-header';
import { DRIVES_KEY, driveTreeKey, useDriveTree } from '@/components/drive/drive-sidebar';
import { DriveMembersPanel } from '@/components/drive/drive-members-panel';
import { buildDriveTree, type DriveTreeNode } from '@/lib/drive-tree';

type Role = 'full' | 'edit' | 'comment' | 'view';
type DriveDetail = { id: string; name: string; icon: string | null; kind: string; role: Role | null };
type TrashItem = { id: string; title: string; icon: string | null; deleted_at: string };

async function fetchJson<T>(path: string): Promise<T> {
  const res = await api.get(path);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json() as Promise<T>;
}

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
  const { mutate: refreshKey } = useSWRConfig();
  const drive = useSWR<{ drive: DriveDetail }>(`/api/drives/${driveId}`, fetchJson);
  const role = drive.data?.drive.role ?? null;
  const canEdit = role === 'edit' || role === 'full';
  const tree = useDriveTree(drive.data ? driveId : null);
  const trash = useSWR<{ items: TrashItem[] }>(canEdit ? `/api/drives/${driveId}/trash` : null, fetchJson);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const nodes = tree.data ? buildDriveTree(tree.data) : [];
  // Owners and admins may manage the members of a private drive they can't open.
  const adminCanManage = user?.role === 'owner' || user?.role === 'admin';

  const newDocument = async () => {
    setMessage(null);
    const res = await api.post('/api/documents', { drive_id: driveId });
    const body = await res.json().catch(() => ({})) as { document?: { id: string }; error?: string };
    if (!res.ok || !body.document) { setMessage(body.error ?? 'Could not create the document'); return; }
    await refreshKey(driveTreeKey(driveId));
    router.push(`/d/${body.document.id}`);
  };

  const newFolder = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!folderName?.trim()) return;
    setMessage(null);
    const res = await api.post('/api/doc-folders', { drive_id: driveId, name: folderName.trim() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      setMessage(body.error ?? 'Could not create the folder');
      return;
    }
    setFolderName(null);
    await refreshKey(driveTreeKey(driveId));
  };

  const restore = async (id: string) => {
    setMessage(null);
    const res = await api.post(`/api/documents/${id}/restore`);
    if (!res.ok) { setMessage('Could not restore that document'); return; }
    await Promise.all([trash.mutate(), refreshKey(driveTreeKey(driveId)), refreshKey(DRIVES_KEY)]);
  };

  if (drive.error) {
    return (
      <div className="flex-1 overflow-y-auto">
        <PageHeader title="Drive" />
        <div className="px-4 pb-8 flex flex-col gap-6 max-w-3xl">
          <p className="text-[0.875rem]" style={{ color: 'var(--on-surface-variant)' }}>
            {adminCanManage ? 'You can\'t open this drive, but you can manage who has access.' : 'This drive isn\'t available.'}
          </p>
          {adminCanManage && <DriveMembersPanel driveId={driveId} />}
        </div>
      </div>
    );
  }
  if (!drive.data) return <div className="flex-1 p-4 text-[0.875rem]" style={{ color: 'var(--outline)' }}>Loading...</div>;

  const title = drive.data.drive.kind === 'personal' ? 'My drive' : drive.data.drive.name;
  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader
        title={title}
        primary={canEdit ? (
          <>
            <button
              type="button"
              onClick={() => setFolderName(folderName === null ? '' : null)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[0.8125rem]"
              style={{ background: 'var(--surface)', color: 'var(--on-surface)' }}
            >
              <FolderPlus size={14} strokeWidth={1.5} /> New folder
            </button>
            <button
              type="button"
              onClick={() => { void newDocument(); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[0.8125rem] font-medium text-white"
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
          <form onSubmit={(e) => { void newFolder(e); }} className="flex gap-2">
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
            <button type="submit" disabled={!folderName.trim()} className="px-3 py-1.5 rounded-lg text-[0.8125rem] disabled:opacity-50" style={{ background: 'var(--surface)', color: 'var(--on-surface)' }}>
              Create
            </button>
          </form>
        )}
        {tree.error ? (
          <p className="text-[0.875rem]" style={{ color: 'var(--on-surface-variant)' }}>Could not load this drive.</p>
        ) : tree.data && nodes.length === 0 ? (
          <p className="text-[0.875rem]" style={{ color: 'var(--on-surface-variant)' }}>
            {canEdit ? 'Nothing here yet. Start with a new document.' : 'Nothing here yet.'}
          </p>
        ) : (
          <Nodes nodes={nodes} depth={0} />
        )}
        {role === 'full' && <DriveMembersPanel driveId={driveId} />}
        {canEdit && trash.data && (
          <section aria-label="Trash" className="flex flex-col gap-2">
            <h2 className="text-[0.9375rem] font-semibold" style={{ color: 'var(--on-surface)' }}>Trash</h2>
            {trash.data.items.length === 0 ? (
              <p className="text-[0.8125rem]" style={{ color: 'var(--outline)' }}>Deleted documents stay here for 30 days.</p>
            ) : (
              <ul className="flex flex-col">
                {trash.data.items.map((item) => (
                  <li key={item.id} className="flex items-center gap-2 min-h-[40px] text-[0.875rem]" style={{ color: 'var(--on-surface)' }}>
                    <span className="flex-1 truncate">{item.title || 'Untitled'}</span>
                    <span className="text-[0.75rem]" style={{ color: 'var(--outline)' }}>{formatRelative(item.deleted_at)}</span>
                    <button type="button" onClick={() => { void restore(item.id); }} className="px-2 py-1 rounded-md text-[0.8125rem]" style={{ color: 'var(--primary)' }}>
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
