import { and, eq } from 'drizzle-orm';
import { spaces } from '@deft/db/schema';
import { db } from './db.js';

export type SpaceTargetRow = Pick<typeof spaces.$inferSelect, 'id' | 'name' | 'type' | 'is_archived'>;

export type SpaceTargetResolution =
  | { status: 'resolved'; space: SpaceTargetRow; requestedName?: string | null }
  | { status: 'missing'; message: string; requestedName?: string | null }
  | { status: 'ambiguous'; message: string; requestedName?: string | null; matches: SpaceTargetRow[] };

export function normalizeSpaceTargetName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/^#/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function formatSpaceName(space: Pick<SpaceTargetRow, 'name'>) {
  return `#${space.name}`;
}

function hasTokenMatch(spaceKey: string, requestedKey: string) {
  const tokens = spaceKey.split('-').filter(Boolean);
  return tokens.includes(requestedKey) || spaceKey.includes(requestedKey);
}

export function resolveSpaceTargetFromRows(
  rows: SpaceTargetRow[],
  args: { spaceId?: unknown; spaceName?: unknown },
): SpaceTargetResolution {
  const requestedId = typeof args.spaceId === 'string' && args.spaceId.trim()
    ? args.spaceId.trim()
    : '';
  const requestedName = typeof args.spaceName === 'string' && args.spaceName.trim()
    ? args.spaceName.trim().replace(/^#/, '')
    : null;
  const activeRows = rows.filter((space) => !space.is_archived);

  if (requestedId) {
    const exactId = activeRows.find((space) => space.id === requestedId);
    if (exactId) return { status: 'resolved', space: exactId, requestedName };
    return {
      status: 'missing',
      requestedName,
      message: `Space ${requestedId} was not found or is archived.`,
    };
  }

  const requestedKey = normalizeSpaceTargetName(requestedName);
  if (!requestedKey) {
    return {
      status: 'missing',
      requestedName,
      message: 'Choose a destination space before approving this post.',
    };
  }

  const exactMatches = activeRows.filter((space) => normalizeSpaceTargetName(space.name) === requestedKey);
  if (exactMatches.length === 1) {
    return { status: 'resolved', space: exactMatches[0]!, requestedName };
  }
  if (exactMatches.length > 1) {
    return {
      status: 'ambiguous',
      requestedName,
      matches: exactMatches,
      message: `Multiple spaces are named like "${requestedName}": ${exactMatches.map(formatSpaceName).join(', ')}. Choose one before approving.`,
    };
  }

  const fuzzyMatches = activeRows
    .filter((space) => space.type !== 'dm')
    .filter((space) => hasTokenMatch(normalizeSpaceTargetName(space.name), requestedKey));

  if (fuzzyMatches.length === 1) {
    return { status: 'resolved', space: fuzzyMatches[0]!, requestedName };
  }
  if (fuzzyMatches.length > 1) {
    return {
      status: 'ambiguous',
      requestedName,
      matches: fuzzyMatches,
      message: `Multiple spaces match "${requestedName}": ${fuzzyMatches.map(formatSpaceName).join(', ')}. Choose one before approving.`,
    };
  }

  return {
    status: 'missing',
    requestedName,
    message: `Space "${requestedName}" was not found. Choose an existing channel before approving.`,
  };
}

export async function resolveSpaceTarget(
  orgId: string,
  args: { spaceId?: unknown; spaceName?: unknown },
): Promise<SpaceTargetResolution> {
  const rows = await db
    .select({
      id: spaces.id,
      name: spaces.name,
      type: spaces.type,
      is_archived: spaces.is_archived,
    })
    .from(spaces)
    .where(and(eq(spaces.org_id, orgId), eq(spaces.is_archived, false)));

  return resolveSpaceTargetFromRows(rows, args);
}
