// The drive tree the sidebar and the drive page draw (spec 5.1). The API's
// GET /api/drives/:id/tree answers flat lists; relationships the viewer can't
// see come back null, so an item whose folder or parent page is hidden is
// shown at the top level rather than dropped (rule C4).

export type FolderDto = { id: string; parent_folder_id: string | null; name: string; position: number };
export type DocumentDto = {
  id: string; title: string; icon: string | null; folder_id: string | null; parent_document_id: string | null;
  position: number; updated_at: string;
};
export type DriveTreeNode = { type: 'folder' | 'document'; id: string; title: string; icon: string | null; children: DriveTreeNode[] };

export type DriveListItem = {
  id: string; name: string; icon: string | null; kind: 'open' | 'private' | 'personal'; system_key: string | null;
  role: 'full' | 'edit' | 'comment' | 'view' | null; default_role: string | null; frozen: boolean; pinned: boolean; admin_listed: boolean;
  /** A direct grant, or a seat in a chat that holds one. Never an admin's implicit access or an open drive's default. */
  is_member: boolean;
  /** The caller's own personal drive. */
  is_mine: boolean;
  /** For another person's personal drive: the owner's name, or null when the people rule hides them. */
  owner_name: string | null;
};

/** How a drive is named on screen. Every personal drive is stored as "My drive", so only the caller's own is shown that way. */
export function driveLabel(drive: Pick<DriveListItem, 'name' | 'kind' | 'is_mine' | 'owner_name'>): string {
  if (drive.is_mine) return 'My drive';
  if (drive.kind === 'personal') return drive.owner_name ? `${drive.owner_name}'s drive` : 'A shared personal drive';
  return drive.name;
}

/** The drives the sidebar lists: your own, then those you belong to or pinned. Others are found through Browse. */
export function sidebarDrives(drives: DriveListItem[]): { mine: DriveListItem | null; others: DriveListItem[] } {
  const openable = drives.filter((d) => d.role !== null && !d.frozen);
  const mine = openable.find((d) => d.is_mine) ?? null;
  const others = openable.filter((d) => !d.is_mine && (d.is_member || d.pinned));
  return { mine, others };
}

/** The Drive nav item also stays active on document pages (/d/…); /drive/… is covered by the generic check. */
export function isDriveNavActive(pathname: string, href: string): boolean {
  return href === '/drive' && pathname.startsWith('/d/');
}

const byPositionThenTitle = (a: { position: number; title: string; id: string }, b: { position: number; title: string; id: string }) =>
  a.position - b.position || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);

export function buildDriveTree(tree: { folders: FolderDto[]; documents: DocumentDto[] }): DriveTreeNode[] {
  type Sortable = { node: DriveTreeNode; position: number; title: string; id: string };
  const folderIds = new Set(tree.folders.map((f) => f.id));
  const documentIds = new Set(tree.documents.map((d) => d.id));
  const folders = new Map<string, Sortable>();
  const documents = new Map<string, Sortable>();
  for (const f of tree.folders) {
    folders.set(f.id, { node: { type: 'folder', id: f.id, title: f.name, icon: null, children: [] }, position: f.position, title: f.name, id: f.id });
  }
  for (const d of tree.documents) {
    documents.set(d.id, { node: { type: 'document', id: d.id, title: d.title, icon: d.icon, children: [] }, position: d.position, title: d.title, id: d.id });
  }
  const childFolders = new Map<string | null, Sortable[]>();
  const childDocs = new Map<string | null, Sortable[]>();
  const add = (map: Map<string | null, Sortable[]>, key: string | null, item: Sortable) => {
    const list = map.get(key) ?? [];
    list.push(item);
    map.set(key, list);
  };
  for (const f of tree.folders) add(childFolders, f.parent_folder_id && folderIds.has(f.parent_folder_id) ? f.parent_folder_id : null, folders.get(f.id)!);
  // A document sits under its parent page when that page is listed, else in its folder when listed, else at the top.
  for (const d of tree.documents) {
    const item = documents.get(d.id)!;
    if (d.parent_document_id && documentIds.has(d.parent_document_id) && d.parent_document_id !== d.id) {
      add(childDocs, `d:${d.parent_document_id}`, item);
    } else {
      add(childDocs, d.folder_id && folderIds.has(d.folder_id) ? `f:${d.folder_id}` : null, item);
    }
  }
  const fill = (node: DriveTreeNode, seen: Set<string>): void => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    if (node.type === 'folder') {
      node.children = [
        ...(childFolders.get(node.id) ?? []).sort(byPositionThenTitle).map((s) => s.node),
        ...(childDocs.get(`f:${node.id}`) ?? []).sort(byPositionThenTitle).map((s) => s.node),
      ];
    } else {
      node.children = (childDocs.get(`d:${node.id}`) ?? []).sort(byPositionThenTitle).map((s) => s.node);
    }
    for (const child of node.children) fill(child, seen);
  };
  const roots = [
    ...(childFolders.get(null) ?? []).sort(byPositionThenTitle),
    ...(childDocs.get(null) ?? []).sort(byPositionThenTitle),
  ].map((s) => s.node);
  const seen = new Set<string>();
  for (const root of roots) fill(root, seen);
  return roots;
}
