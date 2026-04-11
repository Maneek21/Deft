import { db } from '../lib/db.js';
import { connectedAccounts, events } from '@deft/db/schema';
import { eq, and } from 'drizzle-orm';
import { decrypt } from '../lib/encryption.js';

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
        const existing = await db.select({ id: events.id }).from(events)
          .where(and(eq(events.source, 'github'), eq(events.external_id, externalId)))
          .limit(1);

        if (existing.length > 0) {
          await db.update(events).set(eventData).where(eq(events.id, existing[0]!.id));
        } else {
          await db.insert(events).values(eventData);
        }
        synced++;
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
