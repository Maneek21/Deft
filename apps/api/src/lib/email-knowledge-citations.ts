import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db.js';
import { emailKnowledgeSourceUrl } from './email-knowledge-visibility.js';

/** Call only after authorizing the retained Knowledge page. The excerpt is a
 * destination-owned copy; the original mailbox link remains separately gated. */
export async function decorateEmailKnowledgeCitations<T extends { source_type: string; source_id: string }>(
  orgId: string, userId: string, citations: T[],
): Promise<Array<T & { source_url?: string | null; source_label?: string }>> {
  const ids = citations.filter(row => row.source_type === 'email').map(row => row.source_id);
  if (!ids.length) return citations;
  const { emailKnowledgeSources } = await import('@deft/db/schema');
  const rows = await db.select({ id: emailKnowledgeSources.id,
    owner_user_id: emailKnowledgeSources.owner_user_id, account_id: emailKnowledgeSources.account_id,
    logical_message_id: emailKnowledgeSources.logical_message_id }).from(emailKnowledgeSources)
    .where(and(eq(emailKnowledgeSources.org_id, orgId), inArray(emailKnowledgeSources.id, ids)));
  const byId = new Map(rows.map(row => [row.id, row]));
  // A routing marker never grants access. The destination excerpt is already
  // authorized; the link opens through a fresh Web/current App source check.
  const adopted=await db.execute(sql`SELECT s.id,m.state FROM email_knowledge_sources s
    JOIN native_email_adoptions m USING(org_id,owner_user_id,account_id)
    WHERE s.org_id=${orgId} AND s.owner_user_id=${userId} AND s.id IN (${sql.join(ids.map(id=>sql`${id}`),sql`,`)})`);
  const routes=new Map(adopted.rows.map(row=>[String(row.id),String(row.state)]));
  return citations.map(citation => {
    if (citation.source_type !== 'email') return citation;
    const source = byId.get(citation.source_id);
    return { ...citation, source_label: 'Email',
      source_url: source?.owner_user_id === userId
        ? routes.has(source.id) ? routes.get(source.id)==='runtime_active' ? `/apps/source/native-email/${encodeURIComponent(source.id)}` : null : emailKnowledgeSourceUrl(source.account_id, source.logical_message_id) : null };
  });
}
