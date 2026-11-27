'use client';

// The document page's header (spec 5.3, mockup 2; plan Task F12): where the
// document lives (breadcrumb), who has it open (presence from the live
// connection's awareness), History and Share for someone who can edit, and a
// ⋯ menu (copy link for everyone; move and delete for editors). Ancestors the
// viewer can't see arrive from the API as one "Shared with you", which is
// never a link (rule C4). Under the title: "Edited {time} by {name}"
// (EditedLine), naming the editor only when the viewer may see them.

import { Fragment, useRef, useState } from 'react';
import Link from 'next/link';
import { History, Link2, MoreHorizontal, MoveRight, Share2, Trash2 } from 'lucide-react';
import { AppMenu, type AppMenuItem } from '@/components/overlay-primitives';
import { formatDateTime, formatRelative } from '@/lib/time';
import type { CollabStatus } from '@/lib/collab-provider';

export type DocRole = 'full' | 'edit' | 'comment' | 'view';
export type BreadcrumbItem =
  | { type: 'drive' | 'folder' | 'document'; id: string; title: string }
  | { type: 'shared'; title: string };
/** Someone else with the document open: a name and caret colour from awareness, nothing more. */
export type PresenceUser = { key: string; name: string; color: string };

export const canEditRole = (role: DocRole | null | undefined) => role === 'edit' || role === 'full';

const MAX_AVATARS = 4;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts.length === 1 ? parts[0]!.slice(0, 1) : `${parts[0]!.slice(0, 1)}${parts[parts.length - 1]!.slice(0, 1)}`).toUpperCase();
}

/** A short word about the live connection, for the header; null while live. */
function statusWord(status: CollabStatus | null): string | null {
  switch (status) {
    case 'offline': return 'Offline';
    case 'connecting': return 'Connecting…';
    case 'busy':
    case 'crowded':
    case 'live_off':
    case 'read_only': return 'Read-only';
    default: return null;
  }
}

function Crumbs({ items, title }: { items: BreadcrumbItem[]; title: string }) {
  // The last crumb is the document itself.
  const path = items.length > 0 && items[items.length - 1]!.type === 'document' ? items.slice(0, -1) : items;
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap text-[13px]" style={{ color: 'var(--on-surface-variant)' }}>
      {path.map((item, index) => (
        <Fragment key={item.type === 'shared' ? `shared-${index}` : `${item.type}:${item.id}`}>
          {/* At phone width only the nearest ancestor shows. */}
          <span className={`${index < path.length - 1 ? 'hidden md:inline' : 'inline'} min-w-0 max-w-[40%] truncate md:max-w-[200px]`}>
            {item.type === 'drive' ? (
              <Link href={`/drive/${item.id}`} className="hover:underline">{item.title || 'Drive'}</Link>
            ) : item.type === 'document' ? (
              <Link href={`/d/${item.id}`} className="hover:underline">{item.title.trim() || 'Untitled'}</Link>
            ) : (
              <span>{item.title}</span>
            )}
          </span>
          <span aria-hidden className={index < path.length - 1 ? 'hidden md:inline' : 'inline'} style={{ color: 'var(--outline)' }}>/</span>
        </Fragment>
      ))}
      <span aria-current="page" className="min-w-0 truncate font-semibold" style={{ color: 'var(--on-surface)' }}>{title.trim() || 'Untitled'}</span>
    </nav>
  );
}

function Presence({ people }: { people: PresenceUser[] }) {
  if (people.length === 0) return null;
  const shown = people.slice(0, MAX_AVATARS);
  const more = people.length - shown.length;
  return (
    <div role="group" aria-label="People here now" className="flex flex-shrink-0 items-center -space-x-1.5">
      {shown.map((person) => (
        <span
          key={person.key}
          title={person.name}
          aria-label={person.name}
          className="flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold text-white"
          style={{ background: person.color, boxShadow: '0 0 0 2px var(--surface, #fff)' }}
        >
          {initials(person.name)}
        </span>
      ))}
      {more > 0 && (
        <span className="flex h-7 min-w-7 items-center justify-center rounded-full px-1 text-[11px] font-semibold"
          style={{ background: 'var(--surface-container)', color: 'var(--on-surface-variant)', boxShadow: '0 0 0 2px var(--surface, #fff)' }}>
          +{more}
        </span>
      )}
    </div>
  );
}

export function DocumentHeader({
  title, breadcrumb, role, presence, status, onHistory, onShare, onCopyLink, onMove, onDelete,
}: {
  title: string;
  breadcrumb: BreadcrumbItem[];
  role: DocRole;
  presence: PresenceUser[];
  status: CollabStatus | null;
  onHistory: () => void;
  onShare: () => void;
  onCopyLink: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  const moreRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const canEdit = canEditRole(role);
  const word = statusWord(status);
  const items: AppMenuItem[] = [
    { label: 'Copy link', icon: <Link2 size={14} />, onSelect: onCopyLink },
    ...(canEdit ? [
      { label: 'Move', icon: <MoveRight size={14} />, onSelect: onMove },
      { label: 'Delete', icon: <Trash2 size={14} />, onSelect: onDelete, danger: true },
    ] : []),
  ];
  const button = 'flex min-h-[36px] flex-shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] md:min-h-[32px]';
  return (
    <header className="flex min-w-0 flex-shrink-0 items-center gap-2 px-4 py-2" style={{ borderBottom: '1px solid var(--outline-variant)' }}>
      <Crumbs items={breadcrumb} title={title} />
      {word && (
        <span role="status" className="hidden flex-shrink-0 rounded-full px-2 py-0.5 text-[11px] sm:inline" style={{ background: 'var(--surface-container)', color: 'var(--on-surface-variant)' }}>
          {word}
        </span>
      )}
      <Presence people={presence} />
      {canEdit && (
        <button type="button" onClick={onHistory} aria-label="History" className={button} style={{ border: '1px solid var(--outline-variant)', color: 'var(--on-surface)' }}>
          <History size={14} strokeWidth={1.75} />
          <span className="hidden sm:inline">History</span>
        </button>
      )}
      {canEdit && (
        <button type="button" onClick={onShare} aria-label="Share" className={`${button} font-semibold text-white`} style={{ background: 'var(--primary-container)' }}>
          <Share2 size={14} strokeWidth={1.75} className="sm:hidden" />
          <span className="hidden sm:inline">Share</span>
        </button>
      )}
      <button
        ref={moreRef}
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg md:h-8 md:w-8"
        style={{ color: 'var(--on-surface-variant)' }}
      >
        <MoreHorizontal size={16} />
      </button>
      <AppMenu open={menuOpen} onClose={() => setMenuOpen(false)} anchorRef={moreRef} items={items} ariaLabel="Document actions" />
    </header>
  );
}

/** "Edited {time} by {name}"; without "by" when the viewer may not see who; nothing before the first edit. */
export function EditedLine({ at, by }: { at: string | null; by: string | null }) {
  if (!at) return null;
  return (
    <p className="text-[12px]" style={{ color: 'var(--on-surface-variant)' }} title={formatDateTime(at)}>
      {by ? `Edited ${formatRelative(at)} by ${by}` : `Edited ${formatRelative(at)}`}
    </p>
  );
}
