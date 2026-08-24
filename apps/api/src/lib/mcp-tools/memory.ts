/**
 * memory_recall / memory_write / memory_list MCP tools.
 *
 * memory_recall delegates to the retrieveContext gateway (Task 1.4).
 * memory_write inserts a wiki_pages row with `agent_employee_id = ctx.employee_id`
 * and `scope = 'user'` for now. Phase 4 adds `memory_update` with approval
 * gating for cross-scope promotion.
 */
import { sql, and, eq, or, desc } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { db } from '../db.js';
import {
  agentEmployees,
  messages,
  projects,
  spaceMembers,
  spaces,
  tasks,
  wikiPages,
} from '@deft/db/schema';
import type { ToolContext, ToolResult } from './types.js';
import { errorResult, textResult } from './types.js';
import { invalidatePlatformContextCacheFor } from './context.js';
import { retrieveContext } from '../retrieve-context.js';
import { wikiPageRelevantToSpaceCondition } from '../wiki-visibility.js';
import { visibleTaskCondition } from '../task-visibility.js';

const VALID_TYPES = new Set([
  'concept',
  'entity',
  'decision',
  'resource',
  'procedure',
  'preference',
  'fact',
]);

function wikiScopeCondition(scope: 'own' | 'org' | 'all', employeeId: string) {
  const orgScope = eq(wikiPages.scope, 'org');
  const ownScope = and(
    eq(wikiPages.agent_employee_id, employeeId),
    sql`${wikiPages.scope} != 'org'`,
  );
  if (scope === 'own') return ownScope;
  if (scope === 'org') return orgScope;
  return or(orgScope, ownScope);
}

function contextResultMatchesMemoryScope(
  scope: 'own' | 'org' | 'all',
  employeeId: string,
  resultScope?: string,
  resultEmployeeId?: string | null,
) {
  const isOrgScope = resultScope === 'org';
  const isOwnScope = resultEmployeeId === employeeId && !isOrgScope;
  if (scope === 'own') return isOwnScope;
  if (scope === 'org') return isOrgScope;
  return isOrgScope || isOwnScope;
}

function wikiRetrievalScopeCondition(orgId: string, spaceId: string | undefined, includeOrg: boolean) {
  if (!spaceId) return undefined;
  const spaceRelevant = wikiPageRelevantToSpaceCondition(spaceId, orgId);
  return includeOrg ? or(eq(wikiPages.scope, 'org'), spaceRelevant) : spaceRelevant;
}

function wikiMatchedSpaceIdExpr(orgId: string, spaceId: string | undefined) {
  if (!spaceId) return sql<string | null>`NULL`;
  const spaceRelevant = wikiPageRelevantToSpaceCondition(spaceId, orgId) ?? sql`FALSE`;
  return sql<string | null>`CASE WHEN ${spaceRelevant} THEN ${spaceId} ELSE NULL END`;
}

async function canEmployeeSeeSpace(
  spaceId: string,
  orgId: string,
  employeeId: string,
): Promise<boolean> {
  const [space] = await db
    .select({ id: spaces.id, type: spaces.type })
    .from(spaces)
    .where(and(eq(spaces.id, spaceId), eq(spaces.org_id, orgId)))
    .limit(1);
  if (!space) return false;
  if (space.type === 'public') return true;

  const [employee] = await db
    .select({ user_id: agentEmployees.user_id })
    .from(agentEmployees)
    .where(and(eq(agentEmployees.id, employeeId), eq(agentEmployees.org_id, orgId)))
    .limit(1);
  if (!employee?.user_id) return false;

  const [member] = await db
    .select({ id: spaceMembers.id })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.space_id, spaceId), eq(spaceMembers.user_id, employee.user_id)))
    .limit(1);
  return !!member;
}

// ─── memory_recall ────────────────────────────────────────────────────────

export type MemoryRecallArgs = {
  caller_employee_slug: string;
  query: string;
  limit?: number;
  scope?: 'own' | 'org' | 'all';
  space_id?: string;
  include_org?: boolean;
};

export async function memoryRecall(
  args: MemoryRecallArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const query = (args.query ?? '').trim();
  if (!query) {
    return errorResult('memory_recall requires a non-empty query');
  }
  const limit = Math.min(Math.max(1, args.limit ?? 5), 25);
  const scope = args.scope ?? 'all';
  const spaceId = args.space_id?.trim() || undefined;
  const includeOrg = args.include_org !== false;

  try {
    if (spaceId && !(await canEmployeeSeeSpace(spaceId, ctx.org_id, ctx.employee_id))) {
      return errorResult(`memory_recall: employee cannot access space ${spaceId}`);
    }
    const retrievalScope = wikiRetrievalScopeCondition(ctx.org_id, spaceId, includeOrg);
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length >= 3)
      .slice(0, 8);
    const exactTermMatches = terms.length > 0
      ? await db
          .select({
            slug: wikiPages.slug,
            id: wikiPages.id,
            title: wikiPages.title,
            summary: wikiPages.summary,
            content: wikiPages.content,
            type: wikiPages.type,
            agent_employee_id: wikiPages.agent_employee_id,
            space_id: wikiPages.space_id,
            origin_space_id: wikiPages.origin_space_id,
            origin_message_id: wikiPages.origin_message_id,
            created_via: wikiPages.created_via,
            version: wikiPages.version,
            matched_space_id: wikiMatchedSpaceIdExpr(ctx.org_id, spaceId),
            updated_at: wikiPages.updated_at,
          })
          .from(wikiPages)
          .where(and(
            eq(wikiPages.org_id, ctx.org_id),
            eq(wikiPages.is_deleted, false),
            wikiScopeCondition(scope, ctx.employee_id),
            ...(retrievalScope ? [retrievalScope] : []),
            ...terms.map((term) => {
              const pattern = `%${term}%`;
              return sql`(
                lower(${wikiPages.title}) like ${pattern}
                or lower(${wikiPages.summary}) like ${pattern}
                or lower(${wikiPages.content}) like ${pattern}
              )`;
            }),
          ))
          .orderBy(desc(wikiPages.updated_at))
          .limit(limit)
      : [];
    // Fetch from the unified gateway — always pass agent_employee_id so
    // the two-tier employee+org split is applied inside fetchWiki.
    const contextResults = await retrieveContext({
      query,
      org_id: ctx.org_id,
      agent_employee_id: ctx.employee_id,
      space_id: spaceId,
      include_org: includeOrg,
      types: ['wiki'],
      limit,
      hybrid: false, // FTS-only; pgvector is a separate phase
    });

    // Post-filter by explicit wiki scope. Org pages can retain an
    // agent_employee_id for audit, so employee ownership is not the tier.
    const filtered = contextResults.filter((r) => {
      if (r.source_type !== 'wiki_page') return false;
      const empId = r.metadata?.agent_employee_id as string | null | undefined;
      return contextResultMatchesMemoryScope(scope, ctx.employee_id, r.scope, empId);
    });

    // Map ContextResult back to the shape clients expect.
    // Fix #5: include page content (truncated to 2000 chars) so callers can
    // quote body text instead of only the summary. Flag pages whose content
    // exceeded the cap with `truncated: true`.
    const CONTENT_CAP = 2000;
    const seenSlugs = new Set<string>();
    const exactResults = exactTermMatches.map((row) => {
      seenSlugs.add(row.slug);
      const fullContent = row.content ?? '';
      const truncated = fullContent.length > CONTENT_CAP;
      return {
        page_id: row.id,
        slug: row.slug,
        title: row.title,
        summary: row.summary ?? null,
        content: truncated ? fullContent.slice(0, CONTENT_CAP) : fullContent,
        truncated,
        type: row.type ?? '',
        confidence: 1.0,
        space_id: row.space_id ?? null,
        origin_space_id: row.origin_space_id ?? null,
        origin_message_id: row.origin_message_id ?? null,
        created_via: row.created_via ?? null,
        matched_space_id: row.matched_space_id ?? null,
        version: Number(row.version),
        updated_at: row.updated_at,
        authority: 'deft_canonical',
      };
    });
    const result = [...exactResults, ...filtered.filter((r) => {
      const slug = (r.metadata?.slug as string) ?? '';
      if (!slug || seenSlugs.has(slug)) return false;
      seenSlugs.add(slug);
      return true;
    }).map((r) => {
      const fullContent = r.content ?? '';
      const truncated = fullContent.length > CONTENT_CAP;
      return {
        page_id: r.source_id,
        slug: (r.metadata?.slug as string) ?? '',
        title: r.title,
        summary: (r.metadata?.summary as string | null) ?? null,
        content: truncated ? fullContent.slice(0, CONTENT_CAP) : fullContent,
        truncated,
        type: (r.metadata?.type as string) ?? '',
        confidence: r.confidence ?? 1.0,
        space_id: r.metadata?.space_id ?? null,
        origin_space_id: r.metadata?.origin_space_id ?? null,
        origin_message_id: r.metadata?.origin_message_id ?? null,
        created_via: r.metadata?.created_via ?? null,
        matched_space_id: r.metadata?.matched_space_id ?? null,
        version: Number(r.metadata?.version ?? 1),
        updated_at: r.metadata?.updated_at ?? null,
        authority: 'deft_canonical',
      };
    })].slice(0, limit);

    return textResult(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`memory_recall failed: ${msg}`);
  }
}

// ─── memory_write ─────────────────────────────────────────────────────────

export type MemoryWriteArgs = {
  caller_employee_slug: string;
  title: string;
  body: string;
  type: string;
  confidence?: number;
  scope?: 'user' | 'org';
  idempotency_key?: string;
  runtime_session_id?: string;
  source_refs?: Array<{
    kind: 'task' | 'message' | 'session' | 'url' | 'artifact';
    id: string;
    excerpt?: string;
  }>;
};

const SENSITIVE_MEMORY_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*[^\s]{8,}/i,
  /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/i,
];

const UNTRUSTED_INSTRUCTION_PATTERNS = [
  /\b(?:ignore|disregard|override)\b.{0,40}\b(?:previous|prior|system|developer)\b.{0,24}\binstructions?\b/i,
  /\b(?:act|respond|behave)\s+as\s+(?:the\s+)?(?:system|developer|administrator)\b/i,
  /<\/?(?:system|developer|assistant|tool|workspace_context)\b/i,
];

function containsSensitiveMemory(text: string) {
  return SENSITIVE_MEMORY_PATTERNS.some((pattern) => pattern.test(text));
}

function containsUntrustedInstruction(text: string) {
  return UNTRUSTED_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text));
}

type ValidatedMemorySource = NonNullable<MemoryWriteArgs['source_refs']>[number] & {
  source_space_id: string | null;
  source_user_id: string | null;
};

async function validateMemorySources(
  sources: MemoryWriteArgs['source_refs'],
  orgId: string,
  employeeUserId: string,
): Promise<{ sources?: ValidatedMemorySource[]; error?: string }> {
  const validated: ValidatedMemorySource[] = [];
  for (const source of sources ?? []) {
    const id = source?.id?.trim();
    if (!id || id.length > 2048) {
      return { error: 'memory_write source_refs require a non-empty id of at most 2048 characters' };
    }
    if (source.excerpt !== undefined && source.excerpt.length > 2000) {
      return { error: 'memory_write source_ref excerpts must be at most 2000 characters' };
    }

    if (source.kind === 'message') {
      const [message] = await db
        .select({ id: messages.id, space_id: messages.space_id, user_id: messages.user_id })
        .from(messages)
        .innerJoin(spaces, eq(spaces.id, messages.space_id))
        .where(and(
          eq(messages.id, id),
          eq(messages.org_id, orgId),
          eq(spaces.org_id, orgId),
          eq(messages.is_deleted, false),
          or(
            eq(spaces.type, 'public'),
            sql`exists (
              select 1 from ${spaceMembers}
              where ${spaceMembers.space_id} = ${messages.space_id}
                and ${spaceMembers.user_id} = ${employeeUserId}
            )`,
          ),
        ))
        .limit(1);
      if (!message) return { error: `memory_write: message source ${id} is unavailable to this employee` };
      validated.push({ ...source, id, source_space_id: message.space_id, source_user_id: message.user_id });
      continue;
    }

    if (source.kind === 'task') {
      const [task] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .innerJoin(projects, eq(projects.id, tasks.project_id))
        .where(and(
          eq(tasks.id, id),
          eq(tasks.org_id, orgId),
          eq(projects.org_id, orgId),
          eq(projects.is_deleted, false),
          eq(tasks.is_deleted, false),
          visibleTaskCondition(employeeUserId),
        ))
        .limit(1);
      if (!task) return { error: `memory_write: task source ${id} is unavailable to this employee` };
      validated.push({ ...source, id, source_space_id: null, source_user_id: null });
      continue;
    }

    if (source.kind === 'url') {
      try {
        const parsed = new URL(id);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('unsupported protocol');
      } catch {
        return { error: `memory_write: URL source ${id} must be an absolute HTTP(S) URL` };
      }
    } else if (source.kind !== 'session' && source.kind !== 'artifact') {
      return { error: `memory_write: unsupported source kind ${String(source.kind)}` };
    }
    validated.push({ ...source, id, source_space_id: null, source_user_id: null });
  }
  return { sources: validated };
}

function memoryDigest(args: MemoryWriteArgs) {
  return createHash('sha256')
    .update(JSON.stringify({
      title: args.title.trim(),
      body: args.body,
      type: args.type,
      confidence: args.confidence ?? 0.7,
      source_refs: args.source_refs ?? [],
    }))
    .digest('hex');
}

function queryRows(result: unknown): Array<Record<string, any>> {
  if (Array.isArray(result)) return result as Array<Record<string, any>>;
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    return Array.isArray(rows) ? rows as Array<Record<string, any>> : [];
  }
  return [];
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

export async function memoryWrite(
  args: MemoryWriteArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!args.title?.trim()) return errorResult('memory_write requires title');
  if (!args.body?.trim()) return errorResult('memory_write requires body');
  if (!args.type || !VALID_TYPES.has(args.type)) {
    return errorResult(
      `memory_write requires type in: ${[...VALID_TYPES].join(', ')}`,
    );
  }
  if (containsSensitiveMemory(`${args.title}\n${args.body}\n${JSON.stringify(args.source_refs ?? [])}`)) {
    return errorResult('memory_write rejected content that appears to contain a credential or secret');
  }
  if (containsUntrustedInstruction(`${args.title}\n${args.body}`)) {
    return errorResult('memory_write rejected content that appears to contain an untrusted instruction');
  }
  if (!args.idempotency_key?.trim()) {
    return errorResult('memory_write requires a non-empty idempotency_key for retry-safe reusable knowledge');
  }
  if ((args.source_refs?.length ?? 0) > 20) {
    return errorResult('memory_write accepts at most 20 source_refs');
  }

  const confidence =
    typeof args.confidence === 'number'
      ? Math.max(0, Math.min(1, args.confidence))
      : 0.7;

  // Phase 3: always tag to the employee. Phase 4's memory_update handles
  // scope promotion to org with approval.
  const digest = memoryDigest(args);
  const idempotencyKey = args.idempotency_key.trim();
  const baseSlug = slugify(args.title);
  const suffix = idempotencyKey
    ? createHash('sha256').update(`${ctx.employee_id}:${idempotencyKey}`).digest('hex').slice(0, 8)
    : Math.random().toString(36).slice(2, 8);
  const slug = baseSlug ? `${baseSlug}-${suffix}` : `memory-${suffix}`;

  // NOTE: raw SQL rather than drizzle insert() because the schema declares
  // `embedding vector(1536)` but migration 0011 is deferred — pgvector is not
  // installed locally, so the column doesn't physically exist. A drizzle
  // insert() always references every declared column and would fail. Raw SQL
  // lets us list only the columns we know exist.
  try {
    const [employee] = await db.select({ user_id: agentEmployees.user_id })
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, ctx.employee_id), eq(agentEmployees.org_id, ctx.org_id)))
      .limit(1);
    if (!employee?.user_id) return errorResult('memory_write: employee shadow user not found');
    const sourceValidation = await validateMemorySources(args.source_refs, ctx.org_id, employee.user_id);
    if (sourceValidation.error) return errorResult(sourceValidation.error);
    const validatedSources = sourceValidation.sources ?? [];
    const result = await db.transaction(async (tx) => {
      if (idempotencyKey) {
        const existingRows = await tx.execute(sql`
          SELECT s.id AS sync_id, s.content_digest, s.page_version,
                 p.id AS page_id, p.slug, p.version, p.title, p.content, p.summary, p.is_deleted
          FROM wiki_memory_syncs s
          JOIN wiki_pages p ON p.id = s.page_id AND p.org_id = s.org_id
          WHERE s.org_id = ${ctx.org_id}
            AND s.agent_employee_id = ${ctx.employee_id}
            AND s.idempotency_key = ${idempotencyKey}
          FOR UPDATE OF s, p
        `);
        const existing = queryRows(existingRows)[0];
        if (existing) {
          if (existing.is_deleted) throw new Error('memory_write: canonical page was deleted; human review is required');
          if (existing.content_digest === digest) {
            return { id: existing.page_id, slug: existing.slug, version: existing.version, replayed: true, updated: false };
          }
          if (Number(existing.version) !== Number(existing.page_version)) {
            throw new Error('memory_write: canonical page changed since the last sync; human review is required');
          }
          await tx.execute(sql`
            INSERT INTO wiki_page_versions
              (id, page_id, version, title, content, summary, edited_by, created_at)
            VALUES
              (${randomUUID()}, ${existing.page_id}, ${existing.version}, ${existing.title},
               ${existing.content}, ${existing.summary}, ${employee.user_id}, now())
            ON CONFLICT (page_id, version) DO NOTHING
          `);
          const nextVersion = Number(existing.version) + 1;
          await tx.execute(sql`
            UPDATE wiki_pages
            SET title = ${args.title.trim()}, content = ${args.body}, summary = ${args.body.slice(0, 240)},
                type = ${args.type}, confidence = ${confidence}, previous_content = content,
                version = ${nextVersion}, updated_at = now()
            WHERE id = ${existing.page_id} AND org_id = ${ctx.org_id}
          `);
          await tx.execute(sql`
            UPDATE wiki_memory_syncs
            SET content_digest = ${digest}, page_version = ${nextVersion},
                runtime_session_id = ${args.runtime_session_id ?? null},
                provenance = ${JSON.stringify({ source_refs: args.source_refs ?? [] })}::jsonb,
                updated_at = now()
            WHERE id = ${existing.sync_id}
          `);
          for (const source of validatedSources) {
            await tx.execute(sql`
              INSERT INTO wiki_citations
                (id, org_id, page_id, source_type, source_id, source_space_id, source_user_id, excerpt, created_at)
              SELECT ${randomUUID()}, ${ctx.org_id}, ${existing.page_id}, ${source.kind}, ${source.id},
                     ${source.source_space_id}, ${source.source_user_id},
                     ${source.excerpt?.slice(0, 500) ?? null}, now()
              WHERE NOT EXISTS (
                SELECT 1 FROM wiki_citations
                WHERE org_id = ${ctx.org_id} AND page_id = ${existing.page_id}
                  AND source_type = ${source.kind} AND source_id = ${source.id}
              )
            `);
          }
          return { id: existing.page_id, slug: existing.slug, version: nextVersion, replayed: false, updated: true };
        }
      }

      const id = randomUUID();
      const rows = await tx.execute(sql`
        INSERT INTO wiki_pages
          (id, org_id, scope, agent_employee_id, type, title, slug, summary,
           content, metadata, confidence, version, is_deleted, created_via, created_at, updated_at)
        VALUES
          (${id}, ${ctx.org_id}, 'user', ${ctx.employee_id}, ${args.type},
           ${args.title.trim()}, ${slug}, ${args.body.slice(0, 240)}, ${args.body},
           ${JSON.stringify({ memory_sync: { runtime_session_id: args.runtime_session_id ?? null, source_refs: args.source_refs ?? [] } })}::jsonb,
           ${confidence}, 1, false, 'hermes_memory_sync', now(), now())
        RETURNING id, slug, version
      `);
      const first = queryRows(rows)[0];
      if (!first) throw new Error('memory_write: insert returned no row');
      if (idempotencyKey) {
        await tx.execute(sql`
          INSERT INTO wiki_memory_syncs
            (id, org_id, agent_employee_id, idempotency_key, content_digest, page_id,
             page_version, runtime_session_id, provenance, created_at, updated_at)
          VALUES
            (${randomUUID()}, ${ctx.org_id}, ${ctx.employee_id}, ${idempotencyKey}, ${digest}, ${id},
             1, ${args.runtime_session_id ?? null},
             ${JSON.stringify({ source_refs: args.source_refs ?? [] })}::jsonb, now(), now())
        `);
      }
      for (const source of validatedSources) {
        await tx.execute(sql`
          INSERT INTO wiki_citations
            (id, org_id, page_id, source_type, source_id, source_space_id, source_user_id, excerpt, created_at)
          SELECT ${randomUUID()}, ${ctx.org_id}, ${id}, ${source.kind}, ${source.id},
                 ${source.source_space_id}, ${source.source_user_id},
                 ${source.excerpt?.slice(0, 500) ?? null}, now()
          WHERE NOT EXISTS (
            SELECT 1 FROM wiki_citations
            WHERE org_id = ${ctx.org_id} AND page_id = ${id}
              AND source_type = ${source.kind} AND source_id = ${source.id}
          )
        `);
      }
      return { id, slug: first.slug, version: first.version, replayed: false, updated: false };
    });

    // Update search_vector so memory_recall can find this page immediately.
    await db.execute(sql`
      UPDATE wiki_pages SET search_vector =
        setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(summary, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(content, '')), 'C')
      WHERE id = ${result.id}
    `);

    // Phase 12 review fix — plan §4.2 I3: invalidate platform_context cache
    // on any memory_write so the next turn sees the new wiki page.
    invalidatePlatformContextCacheFor(ctx.employee_id);

    return textResult({
      page_id: result.id,
      slug: String(result.slug),
      version: Number(result.version),
      content_digest: digest,
      replayed: result.replayed,
      updated: result.updated,
    });
  } catch (err) {
    const databaseCode = (err as { code?: string; cause?: { code?: string } })?.code
      ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (idempotencyKey && databaseCode === '23505') {
      const replayRows = await db.execute(sql`
        SELECT p.id, p.slug, p.version, s.content_digest
        FROM wiki_memory_syncs s
        JOIN wiki_pages p ON p.id = s.page_id AND p.org_id = s.org_id
        WHERE s.org_id = ${ctx.org_id}
          AND s.agent_employee_id = ${ctx.employee_id}
          AND s.idempotency_key = ${idempotencyKey}
        LIMIT 1
      `);
      const replay = queryRows(replayRows)[0];
      if (replay?.content_digest === digest) {
        invalidatePlatformContextCacheFor(ctx.employee_id);
        return textResult({
          page_id: replay.id,
          slug: replay.slug,
          version: Number(replay.version),
          content_digest: digest,
          replayed: true,
          updated: false,
        });
      }
    }
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`memory_write failed: ${msg}`);
  }
}

// ─── memory_list ──────────────────────────────────────────────────────────

export type MemoryListArgs = {
  caller_employee_slug: string;
  type?: string;
  limit?: number;
};

export async function memoryList(
  args: MemoryListArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const limit = Math.min(Math.max(1, args.limit ?? 25), 100);

  try {
    const conditions = [
      eq(wikiPages.org_id, ctx.org_id),
      eq(wikiPages.is_deleted, false),
      wikiScopeCondition('all', ctx.employee_id),
    ];
    if (args.type && VALID_TYPES.has(args.type)) {
      conditions.push(eq(wikiPages.type, args.type as 'fact'));
    }

    const rows = await db
      .select({
        slug: wikiPages.slug,
        title: wikiPages.title,
        summary: wikiPages.summary,
        type: wikiPages.type,
        confidence: wikiPages.confidence,
        updated_at: wikiPages.updated_at,
      })
      .from(wikiPages)
      .where(and(...conditions))
      .orderBy(desc(wikiPages.updated_at))
      .limit(limit);

    return textResult(
      rows.map((r) => ({
        slug: r.slug,
        title: r.title,
        summary: r.summary,
        type: r.type,
        confidence: r.confidence,
        updated_at: r.updated_at,
      })),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`memory_list failed: ${msg}`);
  }
}
