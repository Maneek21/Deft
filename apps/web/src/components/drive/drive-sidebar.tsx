'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { ChevronRight, FileText, Folder, FolderOpen, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { DRIVES_KEY, driveTreeKey, ensureMyDrive, fetchJson } from '@/lib/drive-actions';
import { buildDriveTree, driveLabel, sidebarDrives, type DocumentDto, type DriveListItem, type DriveTreeNode, type FolderDto } from '@/lib/drive-tree';
import { NewDriveDialog } from './new-drive-dialog';

export { DRIVES_KEY, driveTreeKey };

export function useDrives() {
  return useSWR<{ drives: DriveListItem[] }>(DRIVES_KEY, fetchJson, { revalidateOnFocus: true });
}

export function useDriveTree(driveId: string | null) {
  return useSWR<{ folders: FolderDto[]; documents: DocumentDto[] }>(driveId ? driveTreeKey(driveId) : null, fetchJson);
}

const rowClass = 'w-full text-left px-2 flex items-center gap-1.5 relative min-h-[44px] md:min-h-0 md:h-8';

function rowStyle(active: boolean) {
  return {
    background: active ? 'var(--bg-active)' : 'transparent',
    color: active ? 'var(--on-surface)' : 'var(--on-surface-variant)',
    fontWeight: active ? 500 : 500,
    fontSize: '0.8125rem',
    borderRadius: '999px',
  } as const;
}

function TreeNodes({ nodes, depth, pathname, onNav }: { nodes: DriveTreeNode[]; depth: number; pathname: string; onNav?: () => void }) {
  return (
    <>
      {nodes.map((node) => {
        const href = node.type === 'document' ? `/d/${node.id}` : null;
        const active = href !== null && pathname === href;
        const label = node.title || 'Untitled';
        const Icon = node.type === 'folder' ? Folder : FileText;
        return (
          <div key={`${node.type}:${node.id}`}>
            {href ? (
              <Link href={href} onClick={onNav} className={rowClass} style={{ ...rowStyle(active), paddingLeft: `${0.5 + depth * 0.75}rem` }}>
                <span className="flex-shrink-0 text-[13px] leading-none">{node.icon ?? <Icon size={13} strokeWidth={1.5} style={{ opacity: 0.5 }} />}</span>
                <span className="truncate flex-1">{label}</span>
              </Link>
            ) : (
              <div className={rowClass} style={{ ...rowStyle(false), paddingLeft: `${0.5 + depth * 0.75}rem` }}>
                <Icon size={13} strokeWidth={1.5} className="flex-shrink-0" style={{ opacity: 0.5 }} />
                <span className="truncate flex-1">{label}</span>
              </div>
            )}
            {node.children.length > 0 && <TreeNodes nodes={node.children} depth={depth + 1} pathname={pathname} onNav={onNav} />}
          </div>
        );
      })}
    </>
  );
}

function DriveBranch({ drive, label, pathname, onNav }: { drive: DriveListItem; label: string; pathname: string; onNav?: () => void }) {
  const href = `/drive/${drive.id}`;
  const active = pathname === href;
  const [open, setOpen] = useState(pathname.startsWith(href));
  const tree = useDriveTree(open ? drive.id : null);
  const nodes = tree.data ? buildDriveTree(tree.data) : [];
  return (
    <div>
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
          className="p-1 rounded flex-shrink-0"
          style={{ color: 'var(--outline)' }}
        >
          <ChevronRight size={12} strokeWidth={1.5} style={{ transform: open ? 'rotate(90deg)' : undefined }} />
        </button>
        <Link href={href} onClick={onNav} className={rowClass} style={rowStyle(active)}>
          <span className="flex-shrink-0 text-[13px] leading-none">{drive.icon ?? <FolderOpen size={14} strokeWidth={1.5} style={{ opacity: 0.5 }} />}</span>
          <span className="truncate flex-1">{label}</span>
        </Link>
      </div>
      {open && (
        <div className="pl-3">
          {tree.error ? (
            <p className="px-2 py-1 text-[0.75rem]" style={{ color: 'var(--outline)' }}>Could not load this drive.</p>
          ) : !tree.data ? (
            <p className="px-2 py-1 text-[0.75rem]" style={{ color: 'var(--outline)' }}>Loading...</p>
          ) : nodes.length === 0 ? (
            <p className="px-2 py-1 text-[0.75rem]" style={{ color: 'var(--outline)' }}>Nothing here yet.</p>
          ) : (
            <TreeNodes nodes={nodes} depth={0} pathname={pathname} onNav={onNav} />
          )}
        </div>
      )}
    </div>
  );
}

/** The sidebar's contextual area on /drive and /d/: My drive, your drives, Browse, and + New drive (not for guests). */
export function DriveSidebarContent({ role, pathname, onNav }: { role?: string; pathname: string; onNav?: () => void }) {
  const { data, error, mutate } = useDrives();
  const [creating, setCreating] = useState(false);
  const [mineFailed, setMineFailed] = useState(false);
  const asked = useRef(false);
  const { mine, others } = sidebarDrives(data?.drives ?? []);
  const isGuest = role === 'guest';

  // Everyone has a My drive: if the list holds none of the caller's own, make it once.
  useEffect(() => {
    if (!data || asked.current) return;
    asked.current = true;
    void ensureMyDrive(data.drives, api).then((outcome) => {
      if (!outcome) return;
      if (outcome.ok) void mutate();
      else setMineFailed(true);
    });
  }, [data, mutate]);
  return (
    <div className="px-3 pt-5 pb-1">
      <div className="flex items-center justify-between px-2 mb-2">
        <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.05em]" style={{ color: 'var(--outline)' }}>
          Drive
        </span>
      </div>
      {error && !data && <p role="alert" className="px-2 py-1 text-[0.75rem]" style={{ color: 'var(--outline)' }}>Could not load your drives.</p>}
      {!data && !error && <p className="px-2 py-1 text-[0.75rem]" style={{ color: 'var(--outline)' }}>Loading drives...</p>}
      {mineFailed && !mine && <p role="alert" className="px-2 py-1 text-[0.75rem]" style={{ color: 'var(--outline)' }}>Could not open My drive.</p>}
      {mine && <DriveBranch drive={mine} label="My drive" pathname={pathname} onNav={onNav} />}
      {others.map((drive) => <DriveBranch key={drive.id} drive={drive} label={driveLabel(drive)} pathname={pathname} onNav={onNav} />)}
      <Link href="/drive" onClick={onNav} className={rowClass} style={rowStyle(pathname === '/drive')}>
        <span className="truncate flex-1">Browse drives</span>
      </Link>
      {!isGuest && (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className={rowClass}
          style={{ ...rowStyle(false), color: 'var(--outline)' }}
        >
          <Plus size={13} strokeWidth={1.5} className="flex-shrink-0" />
          <span className="truncate flex-1">New drive</span>
        </button>
      )}
      {creating && <NewDriveDialog onClose={() => setCreating(false)} onCreated={() => { void mutate(); }} />}
    </div>
  );
}
