/**
 * ClawHub allowlist fetcher.
 *
 * Pulls the VoltAgent awesome-openclaw-skills markdown, parses out skill slugs,
 * and upserts them into the clawhub_allowlist table. Falls back to the bundled
 * static list on network failure so the Library UI always has something to
 * show.
 *
 * Block 0 Task 0.11 of OpenClaw Unlock plan.
 */
import { db } from './db.js';
import { sql } from 'drizzle-orm';
import { BUNDLED_ALLOWLIST } from './clawhub-bundled-allowlist.js';

const VOLTAGENT_RAW_URL =
  'https://raw.githubusercontent.com/VoltAgent/awesome-openclaw-skills/main/README.md';

export type AllowlistEntry = {
  slug: string;
  description: string;
  homepage?: string;
  source: 'voltagent' | 'deft-bundled' | 'deft-verified';
};

/**
 * Parse bulleted entries out of the VoltAgent markdown. Recognises:
 *   - [slug](https://clawhub.ai/skills/slug) — short description
 *   - * [slug](https://github.com/openclaw/...) - other separator
 * Tolerates formatting drift; skips non-clawhub links.
 */
export function parseVoltAgentMarkdown(md: string): AllowlistEntry[] {
  const entries: AllowlistEntry[] = [];
  const linkRe =
    /^\s*[-*]\s*\[([a-z0-9][a-z0-9-]*)\]\((https?:\/\/(?:clawhub\.ai\/skills\/|github\.com\/openclaw\/)[^)]+)\)\s*[—\-]\s*(.+?)(?:\n|$)/gim;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(md)) !== null) {
    const slug = match[1]!.toLowerCase();
    const homepage = match[2]!;
    const description = match[3]!.trim().slice(0, 500);
    entries.push({ slug, homepage, description, source: 'voltagent' });
  }
  return entries;
}

export async function fetchVoltAgentAllowlist(): Promise<AllowlistEntry[]> {
  const res = await fetch(VOLTAGENT_RAW_URL, {
    headers: { 'user-agent': 'deft-clawhub-allowlist-fetcher/1.0' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`VoltAgent fetch failed: ${res.status}`);
  }
  const md = await res.text();
  return parseVoltAgentMarkdown(md);
}

/**
 * Runs a full refresh: fetch remote, fall back to bundled, upsert rows.
 * Returns the count of rows upserted.
 */
export async function refreshClawhubAllowlist(
  opts: { silent?: boolean } = {},
): Promise<number> {
  const log = (s: string) => {
    if (!opts.silent) console.log(s);
  };
  let entries: AllowlistEntry[];
  try {
    entries = await fetchVoltAgentAllowlist();
    log(`[clawhub-allowlist] fetched ${entries.length} entries from VoltAgent`);
  } catch (err) {
    log(
      `[clawhub-allowlist] remote fetch failed (${(err as Error).message}); using bundled static list`,
    );
    entries = BUNDLED_ALLOWLIST.map((e) => ({
      slug: e.slug,
      description: e.description,
      homepage: e.homepage,
      source: 'deft-bundled' as const,
    }));
  }

  if (entries.length === 0) {
    log('[clawhub-allowlist] no entries to upsert; skipping');
    return 0;
  }

  for (const e of entries) {
    await db.execute(sql`
      INSERT INTO clawhub_allowlist (slug, source, description, homepage, last_seen_at, added_at)
      VALUES (
        ${e.slug},
        ${e.source},
        ${e.description ?? null},
        ${e.homepage ?? null},
        now(),
        now()
      )
      ON CONFLICT (slug) DO UPDATE
        SET source       = EXCLUDED.source,
            description  = COALESCE(EXCLUDED.description, clawhub_allowlist.description),
            homepage     = COALESCE(EXCLUDED.homepage, clawhub_allowlist.homepage),
            last_seen_at = now()
    `);
  }
  log(`[clawhub-allowlist] upserted ${entries.length} rows`);
  return entries.length;
}
