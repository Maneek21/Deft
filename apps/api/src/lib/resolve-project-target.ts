import { and, eq } from 'drizzle-orm';
import { projectSpaces, projects } from '@deft/db/schema';
import { db } from './db.js';

export type ProjectTargetRow = {
  id: string;
  name: string;
  prefix: string | null;
  is_archived: boolean;
  is_deleted: boolean;
};

export type RankedProjectTarget<T extends ProjectTargetRow = ProjectTargetRow> = T & {
  confidence: number;
  match_reason: string;
  linked_to_source: boolean;
};

export type ProjectTargetResolution<T extends ProjectTargetRow = ProjectTargetRow> =
  | { status: 'resolved'; project: RankedProjectTarget<T>; candidates: RankedProjectTarget<T>[] }
  | { status: 'missing'; message: string; candidates: RankedProjectTarget<T>[] }
  | { status: 'ambiguous'; message: string; matches: RankedProjectTarget<T>[]; candidates: RankedProjectTarget<T>[] };

export function normalizeProjectTargetName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(value: unknown): string {
  return normalizeProjectTargetName(value).replace(/\s+/g, '');
}

function scorePart(query: string, value: unknown, reason: string): { confidence: number; reason: string } {
  const normalizedQuery = normalizeProjectTargetName(query);
  const normalizedValue = normalizeProjectTargetName(value);
  if (!normalizedQuery || !normalizedValue) return { confidence: 0, reason };

  if (normalizedQuery === normalizedValue || compact(query) === compact(value)) {
    return { confidence: 1, reason: `${reason}: exact` };
  }

  // A planner may return a canonical name followed by explanatory prose. A
  // complete, contiguous project name is safe to recover; token fragments are not.
  const paddedQuery = ` ${normalizedQuery} `;
  const paddedValue = ` ${normalizedValue} `;
  if (paddedQuery.includes(paddedValue)) {
    return { confidence: 0.98, reason: `${reason}: complete name in text` };
  }

  if (normalizedValue.startsWith(normalizedQuery) || compact(value).startsWith(compact(query))) {
    return { confidence: 0.92, reason: `${reason}: prefix` };
  }

  const queryTokens = normalizedQuery.split(' ').filter(Boolean);
  const valueTokens = normalizedValue.split(' ').filter(Boolean);
  const querySet = new Set(queryTokens);
  const matchedValueTokens = valueTokens.filter((token) => querySet.has(token)).length;
  if (valueTokens.length > 1 && matchedValueTokens === valueTokens.length) {
    return { confidence: 0.9, reason: `${reason}: all project words` };
  }

  return { confidence: 0, reason };
}

export function rankProjectTargets<T extends ProjectTargetRow>(
  query: string,
  rows: T[],
  linkedProjectIds: ReadonlySet<string> = new Set(),
): RankedProjectTarget<T>[] {
  return rows
    .filter((project) => !project.is_archived && !project.is_deleted)
    .map((project) => {
      const nameScore = scorePart(query, project.name, 'name');
      const prefixScore = scorePart(query, project.prefix, 'prefix');
      const best = nameScore.confidence >= prefixScore.confidence ? nameScore : prefixScore;
      return {
        ...project,
        confidence: best.confidence,
        match_reason: best.reason,
        linked_to_source: linkedProjectIds.has(project.id),
      };
    })
    .filter((project) => project.confidence > 0)
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      const nameLengthDelta = normalizeProjectTargetName(b.name).length - normalizeProjectTargetName(a.name).length;
      if (nameLengthDelta !== 0) return nameLengthDelta;
      if (a.linked_to_source !== b.linked_to_source) return a.linked_to_source ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function asRanked<T extends ProjectTargetRow>(project: T, linkedProjectIds: ReadonlySet<string>): RankedProjectTarget<T> {
  return {
    ...project,
    confidence: 1,
    match_reason: 'single project linked to source space',
    linked_to_source: linkedProjectIds.has(project.id),
  };
}

export function resolveProjectTargetFromRows<T extends ProjectTargetRow>(
  rows: T[],
  args: { projectId?: unknown; projectName?: unknown; linkedProjectIds?: ReadonlySet<string> },
): ProjectTargetResolution<T> {
  const activeRows = rows.filter((project) => !project.is_archived && !project.is_deleted);
  const linkedProjectIds = args.linkedProjectIds ?? new Set<string>();
  const projectId = typeof args.projectId === 'string' ? args.projectId.trim() : '';
  const projectName = typeof args.projectName === 'string' ? args.projectName.trim() : '';

  if (projectId) {
    const exact = activeRows.find((project) => project.id === projectId);
    if (exact) {
      const project = asRanked(exact, linkedProjectIds);
      return { status: 'resolved', project, candidates: [project] };
    }
    return {
      status: 'missing',
      message: 'I could not find that active project. Choose an existing project and I will draft it again.',
      candidates: [],
    };
  }

  if (!projectName) {
    const linked = activeRows.filter((project) => linkedProjectIds.has(project.id));
    if (linked.length === 1) {
      const project = asRanked(linked[0]!, linkedProjectIds);
      return { status: 'resolved', project, candidates: [project] };
    }
    if (linked.length > 1) {
      const matches = linked.map((project) => asRanked(project, linkedProjectIds));
      return {
        status: 'ambiguous',
        message: `This conversation is linked to several projects: ${matches.map((project) => project.name).join(', ')}. Which one should I use?`,
        matches,
        candidates: matches,
      };
    }
    return {
      status: 'missing',
      message: 'I need the target project before I can create the task approval card.',
      candidates: [],
    };
  }

  const candidates = rankProjectTargets(projectName, activeRows, linkedProjectIds);
  const top = candidates[0];
  const second = candidates[1];
  if (!top || top.confidence < 0.9) {
    return {
      status: 'missing',
      message: 'I could not confidently match the target project. Name the project exactly and I will draft it again.',
      candidates: candidates.slice(0, 5),
    };
  }

  const normalizedTopName = normalizeProjectTargetName(top.name);
  const normalizedSecondName = second ? normalizeProjectTargetName(second.name) : '';
  const topIsSpecificVersionOfSecond = Boolean(
    second
    && normalizedTopName.startsWith(`${normalizedSecondName} `)
    && normalizeProjectTargetName(projectName).startsWith(`${normalizedTopName} `),
  );
  const exactTie = Boolean(second && top.confidence === 1 && second.confidence === 1);
  const closeNonExactMatch = Boolean(
    second
    && top.confidence < 1
    && top.confidence - second.confidence < 0.1
    && !topIsSpecificVersionOfSecond,
  );
  if (exactTie || closeNonExactMatch) {
    const matches = candidates.filter((candidate) => top.confidence - candidate.confidence < 0.1).slice(0, 5);
    return {
      status: 'ambiguous',
      message: `I found several possible projects: ${matches.map((project) => project.name).join(', ')}. Which one should I use?`,
      matches,
      candidates: candidates.slice(0, 5),
    };
  }

  return { status: 'resolved', project: top, candidates: candidates.slice(0, 5) };
}

export async function resolveProjectTarget(
  orgId: string,
  args: { projectId?: unknown; projectName?: unknown; sourceSpaceId?: unknown },
): Promise<ProjectTargetResolution> {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      prefix: projects.prefix,
      is_archived: projects.is_archived,
      is_deleted: projects.is_deleted,
    })
    .from(projects)
    .where(and(eq(projects.org_id, orgId), eq(projects.is_archived, false), eq(projects.is_deleted, false)));

  const sourceSpaceId = typeof args.sourceSpaceId === 'string' ? args.sourceSpaceId.trim() : '';
  const linkedProjectIds = new Set<string>();
  if (sourceSpaceId) {
    const links = await db
      .select({ projectId: projectSpaces.project_id })
      .from(projectSpaces)
      .innerJoin(projects, and(
        eq(projectSpaces.project_id, projects.id),
        eq(projects.org_id, orgId),
        eq(projects.is_archived, false),
        eq(projects.is_deleted, false),
      ))
      .where(eq(projectSpaces.space_id, sourceSpaceId));
    for (const link of links) linkedProjectIds.add(link.projectId);
  }

  return resolveProjectTargetFromRows(rows, {
    projectId: args.projectId,
    projectName: args.projectName,
    linkedProjectIds,
  });
}
