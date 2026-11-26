'use client';

// Moving a document from its ⋯ menu (spec 5.3; plan Tasks F5 and F12):
// POST /api/documents/:id/move { drive_id, folder_id }. The move needs edit on
// the document and on both drives, so only drives the viewer can edit are
// offered; its sub-pages go with it. Moving into a private drive can take
// access away from people who had it through the old drive.

import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { api } from '@/lib/api';
import { driveLabel, type DriveListItem, type FolderDto } from '@/lib/drive-tree';
import { AppDialog } from '@/components/overlay-primitives';
import { driveTreeListKey, drivesListKey, fetchScopedJson, sendWrite, type SessionScope } from './document-keys';

/** The drives a document can move into: ones the viewer can edit that aren't frozen. */
export function moveTargets(drives: DriveListItem[]): DriveListItem[] {
  return drives.filter((drive) => (drive.role === 'edit' || drive.role === 'full') && !drive.frozen);
}

/** Folder paths for a drive's folders, parents first ("Specs / 2026"). */
function folderPaths(folders: FolderDto[]): Array<{ id: string; path: string }> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const pathOf = (folder: FolderDto): string => {
    const names: string[] = [];
    const seen = new Set<string>();
    let current: FolderDto | undefined = folder;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      names.unshift(current.name);
      current = current.parent_folder_id ? byId.get(current.parent_folder_id) : undefined;
    }
    return names.join(' / ');
  };
  return folders.map((folder) => ({ id: folder.id, path: pathOf(folder) })).sort((a, b) => a.path.localeCompare(b.path));
}

export function DocumentMoveDialog({ documentId, scope, currentDriveId, onMoved, onClose }: {
  documentId: string;
  scope: SessionScope;
  currentDriveId: string;
  onMoved: () => void;
  onClose: () => void;
}) {
  const drives = useSWR<{ drives: DriveListItem[] }>(drivesListKey(scope), fetchScopedJson);
  const targets = useMemo(() => moveTargets(drives.data?.drives ?? []), [drives.data]);
  const [driveId, setDriveId] = useState<string>(currentDriveId);
  const chosen = targets.find((drive) => drive.id === driveId) ?? null;
  const tree = useSWR<{ folders: FolderDto[] }>(chosen ? driveTreeListKey(scope, chosen.id) : null, fetchScopedJson);
  const folders = useMemo(() => folderPaths(tree.data?.folders ?? []), [tree.data]);
  const [folderId, setFolderId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const move = async () => {
    if (!chosen || busy) return;
    setBusy(true);
    setError(null);
    const outcome = await sendWrite(() => api.post(`/api/documents/${encodeURIComponent(documentId)}/move`, {
      drive_id: chosen.id, folder_id: folderId || null, parent_document_id: null,
    }), 'Could not move the document');
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.refusal.status === 403 ? 'You need edit access to this document and to both drives to move it.' : outcome.refusal.message);
      return;
    }
    onMoved();
    onClose();
  };

  const field = { background: 'var(--surface)', border: '1px solid var(--outline-variant)', color: 'var(--on-surface)' } as const;
  return (
    <AppDialog
      onClose={onClose}
      title="Move document"
      description="Its sub-pages move with it. People who could open it only through the old drive may lose access."
      footer={(
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="min-h-[36px] rounded-md px-3 text-[13px]" style={{ color: 'var(--on-surface-variant)' }}>Cancel</button>
          <button type="button" onClick={() => { void move(); }} disabled={busy || !chosen}
            className="min-h-[36px] rounded-md px-4 text-[13px] font-semibold text-white disabled:opacity-50" style={{ background: 'var(--primary-container)' }}>
            {busy ? 'Moving…' : 'Move'}
          </button>
        </div>
      )}
    >
      <div className="flex min-w-0 flex-col gap-3">
        {drives.error && !drives.data ? (
          <p role="alert" className="text-[13px]" style={{ color: 'var(--on-surface-variant)' }}>Could not load your drives.</p>
        ) : !drives.data ? (
          <p className="text-[13px]" style={{ color: 'var(--outline)' }}>Loading…</p>
        ) : targets.length === 0 ? (
          <p className="text-[13px]" style={{ color: 'var(--on-surface-variant)' }}>There is no drive you can move this document into.</p>
        ) : (
          <>
            <label className="flex min-w-0 flex-col gap-1 text-[12px]" style={{ color: 'var(--on-surface-variant)' }}>
              Drive
              <select value={chosen ? chosen.id : ''} onChange={(event) => { setDriveId(event.target.value); setFolderId(''); }} disabled={busy}
                className="min-h-[36px] w-full min-w-0 rounded-md px-2 text-[13px]" style={field}>
                {!chosen && <option value="" disabled>Choose a drive</option>}
                {targets.map((drive) => <option key={drive.id} value={drive.id}>{driveLabel(drive)}</option>)}
              </select>
            </label>
            {chosen && (
              <label className="flex min-w-0 flex-col gap-1 text-[12px]" style={{ color: 'var(--on-surface-variant)' }}>
                Folder
                <select value={folderId} onChange={(event) => setFolderId(event.target.value)} disabled={busy || !tree.data}
                  className="min-h-[36px] w-full min-w-0 rounded-md px-2 text-[13px]" style={field}>
                  <option value="">Top of the drive</option>
                  {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.path}</option>)}
                </select>
              </label>
            )}
          </>
        )}
        {error && <p role="alert" className="text-[12px]" style={{ color: 'var(--error, #b3261e)' }}>{error}</p>}
      </div>
    </AppDialog>
  );
}
