import { db } from '../lib/db.js';
import {
  connectedAccounts,
  events,
  projects,
  tasks,
  taskActivity,
  taskComments,
  users,
  orgMembers,
} from '@deft/db/schema';
import { eq, and, inArray, asc } from 'drizzle-orm';
import { decrypt } from '../lib/encryption.js';

/**
 * Task 5.6 — Matches `PREFIX-N` references in PR titles/bodies. The regex
 * captures one or more uppercase letters, a hyphen, and one or more digits.
 * Using `\b` prevents matches inside URLs (`.../DEFT-42`) because hyphens are
 * not word chars in JS regex — we want full-word boundaries on both sides.
 */
export const TASK_REF_REGEX = /\b([A-Z]+)-(\d+)\b/g;

interface MergedPRInput {
  org_id: string;
  /** GitHub PR number (e.g. 123). */
  pr_number: number;
  /** Full PR title. */
  title: string;
  /** PR body; may be null/empty. */
  body: string | null;
  /** Canonical HTML URL of the PR (null if not available). */
  url: string | null;
}

interface MergedPRCloseResult {
  /** Task IDs that transitioned to `done`. */
  closed_task_ids: string[];
  /** Refs parsed out of the PR (may include tasks that didn't close). */
  matched_refs: Array<{ prefix: string; number: number }>;
}

/** Parse unique (prefix, number) refs out of `text`. Returns empty list on null/empty. */
export function parseTaskRefs(text: string | null | undefined): Array<{ prefix: string; number: number }> {
  if (!text) return [];
  const seen = new Set<string>();
  const refs: Array<{ prefix: string; number: number }> = [];
  for (const match of text.matchAll(TASK_REF_REGEX)) {
    const prefix = match[1]!;
    const number = Number(match[2]);
    if (!Number.isFinite(number)) continue;
    const key = `${prefix}-${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ prefix, number });
  }
  return refs;
}

/**
 * Pick a stable user_id to attribute the close action to. Preference order:
 *   1. An `is_agent` shadow user that is an active member of the org
 *      (consistent with existing GitHub-originated comments from workers).
 *   2. The earliest active org member (rough fallback for "org owner").
 * Returns null if neither is available — caller must handle (log + skip).
 */
async function pickActorUserId(orgId: string): Promise<string | null> {
  const [agent] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(orgMembers, and(eq(orgMembers.user_id, users.id), eq(orgMembers.org_id, orgId), eq(orgMembers.is_active, true)))
    .where(eq(users.is_agent, true))
    .limit(1);
  if (agent) return agent.id;

  const [owner] = await db
    .select({ id: orgMembers.user_id })
    .from(orgMembers)
    .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.is_active, true)))
    .orderBy(asc(orgMembers.created_at))
    .limit(1);
  return owner?.id ?? null;
}

/**
 * Task 5.6 — When a PR is merged, parse PREFIX-N refs from its title + body
 * and move every matched task (in the same org) from (todo|in_progress|in_review)
 * to `done`. Writes one task_activity row (field=status, action=status_changed,
 * old/new) + one task_comments row per closed task. Tasks already `done` or
 * `cancelled` are not touched. Idempotent per-call: subsequent invocations on
 * the same PR will find the tasks already in `done` and skip them.
 */
export async function closeTasksForMergedPR(input: MergedPRInput): Promise<MergedPRCloseResult> {
  const refs = parseTaskRefs(`${input.title}\n${input.body ?? ''}`);
  const result: MergedPRCloseResult = { closed_task_ids: [], matched_refs: refs };
  if (refs.length === 0) return result;

  // Group refs by prefix so we issue one query per project prefix.
  const byPrefix = new Map<string, number[]>();
  for (const r of refs) {
    const existing = byPrefix.get(r.prefix) ?? [];
    existing.push(r.number);
    byPrefix.set(r.prefix, existing);
  }

  const actorUserId = await pickActorUserId(input.org_id);
  if (!actorUserId) {
    // No actor available — we can't attribute the activity/comment. Logging
    // here matches the guidance in Task 5.6: prefer an agent user, fall back
    // to org owner; if neither exists we skip rather than fabricate data.
    console.warn('[github-sync] cannot close tasks for PR', input.pr_number, 'in org', input.org_id, '— no eligible actor user');
    return result;
  }

  const CLOSABLE_STATUSES = ['todo', 'in_progress', 'in_review'] as const;
  const commentBody = `Closed by merging PR #${input.pr_number}: ${input.title}${input.url ? `\n\n${input.url}` : ''}`;

  for (const [prefix, numbers] of byPrefix) {
    const candidates = await db
      .select({
        id: tasks.id,
        number: tasks.number,
        status: tasks.status,
        prefix: projects.prefix,
      })
      .from(tasks)
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .where(
        and(
          eq(tasks.org_id, input.org_id),
          eq(projects.org_id, input.org_id),
          eq(projects.prefix, prefix),
          inArray(tasks.number, numbers),
          eq(tasks.is_deleted, false),
        ),
      );

    for (const task of candidates) {
      if (!CLOSABLE_STATUSES.includes(task.status as (typeof CLOSABLE_STATUSES)[number])) {
        // Already done or cancelled — don't touch, per spec.
        continue;
      }
      const oldStatus = task.status;

      // Guard against races by scoping the UPDATE on the old status too.
      const updated = await db
        .update(tasks)
        .set({ status: 'done', updated_at: new Date() })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, oldStatus)))
        .returning({ id: tasks.id });
      if (updated.length === 0) continue;

      await db.insert(taskActivity).values({
        org_id: input.org_id,
        task_id: task.id,
        user_id: actorUserId,
        action: 'status_changed',
        field: 'status',
        old_value: oldStatus,
        new_value: 'done',
      });

      await db.insert(taskComments).values({
        org_id: input.org_id,
        task_id: task.id,
        user_id: actorUserId,
        content: commentBody,
      });

      result.closed_task_ids.push(task.id);
    }
  }

  return result;
}

export async function syncGitHubForUser(accountId: string) {
  // 1. Get connection record
  const [account] = await db.select().from(connectedAccounts)
    .where(eq(connectedAccounts.id, accountId)).limit(1);
  if (!account) return { error: 'Account not found' };

  // 2. Decrypt access token
  const accessToken = decrypt(account.access_token_encrypted);

  const headers = {
    Authorization: `token ${accessToken}`,
    Accept: 'application/vnd.github.v3+json',
  };

  try {
    // 3. Fetch user's repos (up to 30 most recently pushed)
    const reposRes = await fetch('https://api.github.com/user/repos?sort=pushed&per_page=30', { headers });
    if (!reposRes.ok) {
      const errText = await reposRes.text();
      await db.update(connectedAccounts).set({ sync_error: `GitHub API error: ${reposRes.status}` })
        .where(eq(connectedAccounts.id, accountId));
      return { error: `GitHub API error: ${reposRes.status}` };
    }

    const repos = await reposRes.json() as any[];
    let synced = 0;

    // 4. For each repo, fetch recent PRs
    for (const repo of repos.slice(0, 10)) {
      const repoFullName = repo.full_name;
      const prRes = await fetch(
        `https://api.github.com/repos/${repoFullName}/pulls?state=all&sort=updated&direction=desc&per_page=20`,
        { headers },
      );

      if (!prRes.ok) continue;
      const prs = await prRes.json() as any[];

      for (const pr of prs) {
        const externalId = `pr-${repoFullName}-${pr.number}`;
        let eventType: string;
        if (pr.merged_at) {
          eventType = 'pr_merged';
        } else if (pr.state === 'closed') {
          eventType = 'pr_closed';
        } else {
          eventType = 'pr_opened';
        }

        const eventData = {
          org_id: account.org_id,
          source: 'github' as const,
          event_type: eventType,
          external_id: externalId,
          title: `${pr.title} (#${pr.number})`,
          body: pr.body || null,
          url: pr.html_url || null,
          actor: pr.user?.login || null,
          timestamp: new Date(pr.updated_at || pr.created_at),
          metadata: {
            repo: repoFullName,
            number: pr.number,
            state: pr.state,
            merged: !!pr.merged_at,
            head_branch: pr.head?.ref || null,
            additions: pr.additions ?? null,
            deletions: pr.deletions ?? null,
            draft: pr.draft || false,
            labels: (pr.labels || []).map((l: any) => l.name),
            requested_reviewers: (pr.requested_reviewers || []).map((r: any) => r.login),
          },
          user_id: account.user_id,
          connected_account_id: account.id,
        };

        // Upsert by source + external_id
        const existing = await db.select({ id: events.id, event_type: events.event_type }).from(events)
          .where(and(eq(events.source, 'github'), eq(events.external_id, externalId)))
          .limit(1);

        const wasAlreadyMerged = existing.length > 0 && existing[0]!.event_type === 'pr_merged';

        if (existing.length > 0) {
          await db.update(events).set(eventData).where(eq(events.id, existing[0]!.id));
        } else {
          await db.insert(events).values(eventData);
        }
        synced++;

        // Task 5.6 — When a PR transitions into pr_merged (new event OR previous
        // event wasn't already pr_merged), parse PREFIX-N refs and close linked
        // tasks. Fail-soft: a closure error must never abort the sync run.
        if (eventType === 'pr_merged' && !wasAlreadyMerged) {
          try {
            await closeTasksForMergedPR({
              org_id: account.org_id,
              pr_number: pr.number,
              title: pr.title,
              body: pr.body ?? null,
              url: pr.html_url ?? null,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            console.error('[github-sync] closeTasksForMergedPR failed for PR', pr.number, msg);
          }
        }
      }
    }

    // 5. Update last_sync_at
    await db.update(connectedAccounts).set({ last_sync_at: new Date(), sync_error: null })
      .where(eq(connectedAccounts.id, accountId));

    return { synced, repos_checked: Math.min(repos.length, 10) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    await db.update(connectedAccounts).set({ sync_error: msg })
      .where(eq(connectedAccounts.id, accountId));
    return { error: msg };
  }
}
