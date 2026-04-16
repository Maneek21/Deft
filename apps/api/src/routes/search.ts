import { Hono } from 'hono';
import { eq, and, ilike, desc, or, gte, lte } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { tasks, projects, spaces, users, messages, orgMembers, tags, notes } from '@deft/db/schema';
import { retrieveContext, type ContextResult } from '../lib/retrieve-context.js';

export const searchRoutes = new Hono();

// GET /api/search?q=query — search across all types
searchRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');
    const q = c.req.query('q') || '';

    if (q.length < 1) {
      return c.json({ spaces: [], tasks: [], people: [], messages: [] });
    }

    const pattern = `%${q}%`;

    // Search spaces
    const spaceResults = await db.select({
      id: spaces.id, name: spaces.name, type: spaces.type,
    })
      .from(spaces)
      .where(and(eq(spaces.org_id, user.org_id), eq(spaces.is_archived, false), ilike(spaces.name, pattern)))
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
      .where(and(...taskConditions))
      .orderBy(desc(tasks.updated_at))
      .limit(5);

    // Search people
    const peopleResults = await db.select({
      id: users.id, name: users.name, email: users.email, avatar_url: users.avatar_url,
    })
      .from(users)
      .innerJoin(orgMembers, eq(users.id, orgMembers.user_id))
      .where(and(
        eq(orgMembers.org_id, user.org_id),
        or(ilike(users.name, pattern), ilike(users.email, pattern)),
      ))
      .limit(5);

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
      .where(and(...msgConditions))
      .orderBy(desc(messages.created_at))
      .limit(10);

    // Search tags (by name, only if query starts with # or matches tag names)
    const tagQuery = q.startsWith('#') ? q.slice(1) : q;
    const tagResults = await db.select({
      id: tags.id, name: tags.name, color: tags.color,
    }).from(tags)
      .where(and(eq(tags.org_id, user.org_id), ilike(tags.name, `%${tagQuery}%`)))
      .limit(5);

    // Search notes (existing DB query for backward compat)
    const noteResults = await db.select({
      id: notes.id, title: notes.title, icon: notes.icon, updated_at: notes.updated_at,
    }).from(notes)
      .where(and(eq(notes.org_id, user.org_id), eq(notes.is_deleted, false), or(ilike(notes.title, pattern), ilike(notes.content, pattern))))
      .orderBy(desc(notes.updated_at))
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

    const notesGroup = knowledgeResults
      .filter((r) => r.source_type === 'note')
      .map((r) => ({
        id: r.source_id,
        title: r.title,
        summary: r.content ? r.content.slice(0, 120) : null,
        source_id: r.source_id,
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

    return c.json({
      spaces: spaceResults,
      tasks: taskResults,
      people: peopleResults,
      messages: messageResults,
      tags: tagResults,
      notes: noteResults,
      wiki: wikiGroup,
      privateNotes: notesGroup,
      decisions: decisionsGroup,
    });
  } catch (err) {
    console.error('Search error:', err);
    return c.json({ error: 'Search failed', code: 'INTERNAL_ERROR' }, 500);
  }
});
