import { Hono } from 'hono';
import { eq, and, ilike, desc, or, gte, lte, isNotNull, sql } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { tasks, projects, spaces, users, messages, orgMembers, tags, spaceMembers } from '@deft/db/schema';
import { documents } from '@deft/db/documents';
import { retrieveContext, type ContextResult } from '../lib/retrieve-context.js';
import { visibleTaskCondition } from '../lib/task-visibility.js';
import { visibleDocumentCondition } from '../lib/document-access.js';
import { visibleLiveMemberForOrg } from '../lib/member-visibility.js';
import { emailFor, peopleViewer, personVisibleSql } from '../lib/people-visibility.js';
import { unjoinedPublicSpaceReadableSql } from '../lib/space-membership.js';
import { humanModuleActor } from '../lib/module-service.js';
import { searchAuthorizedModuleResourcesWithDiagnostics as searchModuleRecords } from '../lib/resource-search-service.js';

export const searchRoutes = new Hono();

// GET /api/search?q=query — search across all types
searchRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');
    const q = c.req.query('q') || '';

    if (q.length < 1) {
      return c.json({
        spaces: [], tasks: [], people: [], messages: [], tags: [], documents: [], notes: [],
        wiki: [], privateNotes: [], decisions: [], modules: [],
      });
    }

    const pattern = `%${q}%`;

    // Search spaces
    // Spaces and messages the caller may read: spaces they are in, and public
    // spaces a member of the workspace (never a guest) may read before joining.
    const readableSpace = or(isNotNull(spaceMembers.id), unjoinedPublicSpaceReadableSql(user.id));

    const spaceResults = await db.select({
      id: spaces.id, name: spaces.name, type: spaces.type,
    })
      .from(spaces)
      .leftJoin(spaceMembers, and(
        eq(spaces.id, spaceMembers.space_id),
        eq(spaceMembers.user_id, user.id),
      ))
      .where(and(eq(spaces.org_id, user.org_id), eq(spaces.is_archived, false), ilike(spaces.name, pattern), readableSpace))
      .limit(5);

    // Search tasks (by title or prefix-number)
    const prefixMatch = q.match(/^([A-Z]+)-?(\d+)?$/i);
    let taskConditions: any[] = [eq(tasks.org_id, user.org_id), eq(tasks.is_deleted, false)];

    if (prefixMatch) {
      const prefix = prefixMatch[1]!.toUpperCase();
      const num = prefixMatch[2] ? parseInt(prefixMatch[2]) : null;
      const [proj] = await db.select({ id: projects.id }).from(projects)
        .where(and(eq(projects.org_id, user.org_id), eq(projects.prefix, prefix))).limit(1);
      if (proj) {
        if (num) {
          taskConditions.push(and(eq(tasks.project_id, proj.id), eq(tasks.number, num)));
        } else {
          taskConditions.push(eq(tasks.project_id, proj.id));
        }
      } else {
        taskConditions.push(ilike(tasks.title, pattern));
      }
    } else {
      taskConditions.push(ilike(tasks.title, pattern));
    }

    const taskResults = await db.select({
      id: tasks.id, number: tasks.number, title: tasks.title,
      status: tasks.status, priority: tasks.priority,
      project_prefix: projects.prefix, project_name: projects.name,
    })
      .from(tasks)
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .where(and(...taskConditions, visibleTaskCondition(user.id)))
      .orderBy(desc(tasks.updated_at))
      .limit(5);

    // Search people: active members only (a removed member is not listed).
    // A guest finds only the people who share a space with them, by name
    // only, and sees no email address (lib/people-visibility.ts).
    const viewer = await peopleViewer(user.org_id, user.id);
    const peopleRows = await db.select({
      id: users.id, name: users.name, email: users.email, avatar_url: users.avatar_url,
    })
      .from(users)
      .innerJoin(orgMembers, eq(users.id, orgMembers.user_id))
      .where(and(
        eq(orgMembers.org_id, user.org_id),
        eq(orgMembers.is_active, true),
        visibleLiveMemberForOrg(orgMembers.org_id),
        personVisibleSql(viewer, users.id),
        viewer.guest ? ilike(users.name, pattern) : or(ilike(users.name, pattern), ilike(users.email, pattern)),
      ))
      .limit(5);
    const peopleResults = peopleRows.map((person) => ({ ...person, email: emailFor(viewer, person.id, person.email) }));

    // Search messages (with optional filters: author_id, space_id, date_from, date_to)
    const authorId = c.req.query('author_id');
    const spaceFilter = c.req.query('space_id');
    const dateFrom = c.req.query('date_from');
    const dateTo = c.req.query('date_to');

    const msgConditions: any[] = [
      eq(messages.org_id, user.org_id),
      eq(messages.is_deleted, false),
      ilike(messages.content, pattern),
    ];
    if (authorId) msgConditions.push(eq(messages.user_id, authorId));
    if (spaceFilter) msgConditions.push(eq(messages.space_id, spaceFilter));
    if (dateFrom) msgConditions.push(gte(messages.created_at, new Date(dateFrom)));
    if (dateTo) msgConditions.push(lte(messages.created_at, new Date(dateTo)));

    const messageResults = await db.select({
      id: messages.id, content: messages.content,
      user_name: users.name, space_id: messages.space_id,
      space_name: spaces.name,
      created_at: messages.created_at,
    })
      .from(messages)
      .innerJoin(users, eq(messages.user_id, users.id))
      .innerJoin(spaces, eq(messages.space_id, spaces.id))
      .leftJoin(spaceMembers, and(
        eq(messages.space_id, spaceMembers.space_id),
        eq(spaceMembers.user_id, user.id),
      ))
      .where(and(...msgConditions, readableSpace))
      .orderBy(desc(messages.created_at))
      .limit(10);

    // Search tags (by name, only if query starts with # or matches tag names)
    const tagQuery = q.startsWith('#') ? q.slice(1) : q;
    const tagResults = await db.select({
      id: tags.id, name: tags.name, color: tags.color,
    }).from(tags)
      .where(and(eq(tags.org_id, user.org_id), ilike(tags.name, `%${tagQuery}%`)))
      .limit(5);

    // Documents (a temporary group until H2's search, F15): full-text search
    // over search_vector, as the access check lets the caller open them
    // (lib/document-access.ts), documents shared only with them included.
    // `notes` stays, empty, for clients that still read it.
    const documentResults = await db.select({
      id: documents.id, title: documents.title, icon: documents.icon, drive_id: documents.drive_id, updated_at: documents.updated_at,
    }).from(documents)
      .where(and(
        eq(documents.org_id, user.org_id),
        visibleDocumentCondition(user.id, user.org_id),
        sql`${documents.search_vector} @@ websearch_to_tsquery('simple', ${q})`,
      ))
      .orderBy(sql`ts_rank(${documents.search_vector}, websearch_to_tsquery('simple', ${q})) DESC`)
      .limit(5);

    // ── Knowledge groups: wiki, notes (private), decisions ─────────────────────
    // Call retrieveContext once for all three knowledge types. The gateway
    // handles hybrid FTS + pgvector ranking internally.
    const knowledgeResults: ContextResult[] = await retrieveContext({
      query: q,
      org_id: user.org_id,
      user_id: user.id,
      types: ['wiki', 'notes', 'decisions'],
      limit: 5,
      hybrid: true,
    }).catch(() => []);

    // Split by source_type into three display groups.
    const wikiGroup = knowledgeResults
      .filter((r) => r.source_type === 'wiki_page')
      .map((r) => ({
        id: r.source_id,
        title: r.title,
        summary: (r.metadata?.summary as string | null) ?? null,
        slug: (r.metadata?.slug as string | null) ?? null,
        type: (r.metadata?.type as string | null) ?? null,
        source_id: r.source_id,
      }));

    // The notes group of Knowledge reads documents since the move (F15).
    const notesGroup = knowledgeResults
      .filter((r) => r.source_type === 'document')
      .map((r) => ({
        id: r.source_id,
        title: r.title,
        summary: r.content ? r.content.slice(0, 120) : null,
        source_id: r.source_id,
        url: `/d/${r.source_id}`,
      }));

    const decisionsGroup = knowledgeResults
      .filter((r) => r.source_type === 'decision')
      .map((r) => ({
        id: r.source_id,
        title: r.title,
        summary: (r.metadata?.summary as string | null) ?? null,
        slug: (r.metadata?.slug as string | null) ?? null,
        source_id: r.source_id,
      }));

    const moduleSearch = await searchModuleRecords(
      humanModuleActor({
        orgId: user.org_id,
        userId: user.id,
        role: user.role ?? 'member',
        source: 'rest',
      }),
      { query: q, limit: 5 },
    );
    const moduleGroup = moduleSearch.items.map((item) => ({
      id: item.resource_id,
      type: 'module_record' as const,
      title: item.title,
      snippet: item.snippet ?? item.subtitle,
      url: item.url,
      module_slug: item.module_slug,
      module_name: item.module_name,
      collection_key: item.collection_key,
      collection_name: item.collection_name,
      updated_at: item.updated_at,
      score: item.score,
    }));

    return c.json({
      spaces: spaceResults,
      tasks: taskResults,
      people: peopleResults,
      messages: messageResults,
      tags: tagResults,
      documents: documentResults.map((row) => ({ ...row, url: `/d/${row.id}` })),
      notes: [],
      wiki: wikiGroup,
      privateNotes: notesGroup,
      decisions: decisionsGroup,
      modules: moduleGroup,
      search_diagnostics: {
        modules: moduleSearch.diagnostic ?? { source: 'modules', status: 'ready' },
      },
    });
  } catch (err) {
    console.error('Search error:');
    return c.json({ error: 'Search failed', code: 'INTERNAL_ERROR' }, 500);
  }
});
