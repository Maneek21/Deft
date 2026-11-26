'use client';

// A chat's Docs tab (spec 5.3, mockup 3 option A; plan Task F13): the
// chat's linked drive, browsable, then the documents shared into the chat
// with their home and this viewer's role, then "+ Link a drive" for someone
// with full access on a drive. Everything comes from
// GET /api/spaces/:id/documents, which lists only what this viewer can open
// and leaves hidden drive and folder names null.

import { useState } from 'react';
import Link from 'next/link';
import useSWR, { mutate as swrMutate } from 'swr';
import { ChevronDown, ChevronRight, FileText, Folder, HardDrive, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { buildDriveTree, type DocumentDto, type DriveTreeNode, type FolderDto } from '@/lib/drive-tree';
import { ROLE_LABEL, type DocRole } from './document-card';

export type SpaceDocumentsData = {
  linked_drive: { id: string; name: string; role: DocRole } | null;
  shared: Array<{ id: string; title: string; home: { drive_name: string | null; folder_name: string | null }; role: DocRole }>;
};

type ListedDrive = { id: string; name: string; role: DocRole | null; frozen: boolean };

export const spaceDocumentsKey = (spaceId: string) => `/api/spaces/${spaceId}/documents`;

async function fetchJson<T>(path: string): Promise<T> {
  const res = await api.get(path);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json() as Promise<T>;
}

async function errorText(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === 'string' && body.error.trim() ? body.error : fallback;
}

const rowClass = 'flex min-h-[40px] w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left md:min-h-[32px]';

function TreeRows({ nodes, depth }: { nodes: DriveTreeNode[]; depth: number }) {
  return (
    <>
      {nodes.map((node) => (
        <div key={`${node.type}:${node.id}`} className="min-w-0">
          {node.type === 'document' ? (
            <Link href={`/d/${node.id}`} className={`${rowClass} hover:bg-[var(--surface-container)]`} style={{ paddingLeft: `${0.5 + depth * 0.875}rem` }}>
              <span className="flex-shrink-0 text-[13px] leading-none">{node.icon ?? <FileText size={14} strokeWidth={1.5} style={{ color: 'var(--outline)' }} />}</span>
              <span className="truncate text-[13px]" style={{ color: 'var(--on-surface)' }}>{node.title.trim() || 'Untitled'}</span>
            </Link>
          ) : (
            <div className={rowClass} style={{ paddingLeft: `${0.5 + depth * 0.875}rem` }}>
              <Folder size={14} strokeWidth={1.5} className="flex-shrink-0" style={{ color: 'var(--outline)' }} />
              <span className="truncate text-[13px]" style={{ color: 'var(--on-surface-variant)' }}>{node.title}</span>
            </div>
          )}
          {node.children.length > 0 && <TreeRows nodes={node.children} depth={depth + 1} />}
        </div>
      ))}
    </>
  );
}

function LinkedDrive({ drive }: { drive: NonNullable<SpaceDocumentsData['linked_drive']> }) {
  const [open, setOpen] = useState(true);
  const tree = useSWR<{ folders: FolderDto[]; documents: DocumentDto[] }>(open ? `/api/drives/${drive.id}/tree` : null, fetchJson);
  const nodes = tree.data ? buildDriveTree(tree.data) : [];
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label={open ? `Collapse ${drive.name}` : `Expand ${drive.name}`}
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg md:h-8 md:w-8"
          style={{ color: 'var(--outline)' }}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <Link href={`/drive/${drive.id}`} className="flex min-w-0 flex-1 items-center gap-2 py-1">
          <HardDrive size={14} strokeWidth={1.5} className="flex-shrink-0" style={{ color: 'var(--on-surface-variant)' }} />
          <span className="truncate text-[13px] font-semibold" style={{ color: 'var(--on-surface)' }}>{drive.name}</span>
        </Link>
        <span className="flex-shrink-0 text-[11px]" style={{ color: 'var(--on-surface-variant)' }}>{ROLE_LABEL[drive.role]}</span>
      </div>
      {open && (
        <div className="min-w-0">
          {tree.error && <p className="px-2 py-1 text-[12px]" style={{ color: 'var(--on-surface-variant)' }}>Couldn&apos;t load this drive.</p>}
          {!tree.error && !tree.data && <p className="px-2 py-1 text-[12px]" style={{ color: 'var(--on-surface-variant)' }}>Loading…</p>}
          {tree.data && nodes.length === 0 && <p className="px-2 py-1 text-[12px]" style={{ color: 'var(--on-surface-variant)' }}>This drive is empty.</p>}
          <TreeRows nodes={nodes} depth={1} />
        </div>
      )}
    </div>
  );
}

function LinkDrive({ spaceId }: { spaceId: string }) {
  const drives = useSWR<{ drives: ListedDrive[] }>('/api/drives', fetchJson);
  const manageable = (drives.data?.drives ?? []).filter((drive) => drive.role === 'full' && !drive.frozen);
  const [open, setOpen] = useState(false);
  const [driveId, setDriveId] = useState('');
  const [role, setRole] = useState<DocRole>('edit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (manageable.length === 0) return null;

  const link = async () => {
    const target = driveId || manageable[0]!.id;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post(`/api/drives/${encodeURIComponent(target)}/link-space`, { space_id: spaceId, role });
      if (!res.ok) {
        setError(await errorText(res, 'Could not link the drive'));
        return;
      }
      setOpen(false);
      await swrMutate(spaceDocumentsKey(spaceId));
    } catch {
      setError('Could not link the drive');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={`${rowClass} mt-2`} style={{ color: 'var(--primary)' }}>
        <Plus size={14} strokeWidth={1.8} /> <span className="text-[13px] font-medium">Link a drive</span>
      </button>
    );
  }
  const selectStyle = { background: 'var(--surface)', border: '1px solid var(--outline-variant)', color: 'var(--on-surface)' } as const;
  return (
    <div className="mt-2 flex min-w-0 flex-col gap-2 rounded-lg p-3" style={{ background: 'var(--surface-container)' }}>
      <div className="text-[12px] font-medium" style={{ color: 'var(--on-surface)' }}>Link a drive to this chat</div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <select aria-label="Drive" value={driveId || manageable[0]!.id} onChange={(e) => setDriveId(e.target.value)}
          className="min-h-[36px] min-w-0 max-w-full flex-1 rounded-md px-2 text-[13px]" style={selectStyle}>
          {manageable.map((drive) => <option key={drive.id} value={drive.id}>{drive.name}</option>)}
        </select>
        <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as DocRole)}
          className="min-h-[36px] rounded-md px-2 text-[13px]" style={selectStyle}>
          <option value="view">Can view</option>
          <option value="comment">Can comment</option>
          <option value="edit">Can edit</option>
        </select>
      </div>
      {error && <p role="alert" className="text-[12px]" style={{ color: 'var(--status-red, #ef4444)' }}>{error}</p>}
      <div className="flex items-center gap-2">
        <button type="button" disabled={busy} onClick={() => { void link(); }}
          className="min-h-[36px] rounded-md px-3 text-[13px] font-semibold text-white disabled:opacity-60" style={{ background: 'var(--primary-container)' }}>
          {busy ? 'Linking…' : 'Link'}
        </button>
        <button type="button" onClick={() => { setOpen(false); setError(null); }} className="min-h-[36px] rounded-md px-3 text-[13px]"
          style={{ color: 'var(--on-surface-variant)' }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function SpaceDocsTab({ spaceId, spaceName, isDm }: { spaceId: string; spaceName: string; isDm: boolean }) {
  const { data, error, mutate } = useSWR<SpaceDocumentsData>(spaceDocumentsKey(spaceId), fetchJson, { revalidateOnFocus: true });
  const where = isDm ? 'this conversation' : `#${spaceName}`;
  const heading = 'px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide';
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 md:px-4" data-testid="space-docs-tab">
      {error && !data && (
        <div className="flex items-center gap-2 px-2 py-3 text-[13px]" style={{ color: 'var(--on-surface-variant)' }}>
          Couldn&apos;t load this chat&apos;s documents.
          <button type="button" onClick={() => { void mutate(); }} className="font-semibold" style={{ color: 'var(--primary)' }}>Try again</button>
        </div>
      )}
      {!error && !data && <p className="px-2 py-3 text-[13px]" style={{ color: 'var(--on-surface-variant)' }}>Loading documents…</p>}
      {data && (
        <div className="mx-auto flex w-full max-w-[760px] min-w-0 flex-col">
          {data.linked_drive && (
            <>
              <div className={heading} style={{ color: 'var(--outline)' }}>Linked drive</div>
              <LinkedDrive drive={data.linked_drive} />
            </>
          )}
          <div className={heading} style={{ color: 'var(--outline)' }}>Shared into {where}</div>
          {data.shared.length === 0 && (
            <p className="px-2 py-1 text-[13px]" style={{ color: 'var(--on-surface-variant)' }}>No documents have been shared into {where} yet.</p>
          )}
          {data.shared.map((doc) => {
            const home = doc.home.drive_name
              ? [doc.home.drive_name, doc.home.folder_name].filter(Boolean).join(' / ')
              : 'Shared with you';
            return (
              <Link key={doc.id} href={`/d/${doc.id}`} className={`${rowClass} hover:bg-[var(--surface-container)]`}>
                <FileText size={14} strokeWidth={1.5} className="flex-shrink-0" style={{ color: 'var(--outline)' }} />
                <span className="min-w-0 flex-1 truncate text-[13px]" style={{ color: 'var(--on-surface)' }}>{doc.title.trim() || 'Untitled'}</span>
                <span className="max-w-[50%] flex-shrink-0 truncate text-[11px]" style={{ color: 'var(--on-surface-variant)' }}>
                  {home} · {ROLE_LABEL[doc.role]}
                </span>
              </Link>
            );
          })}
          {!data.linked_drive && <LinkDrive spaceId={spaceId} />}
        </div>
      )}
    </div>
  );
}
