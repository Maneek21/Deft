// ICS subscription sync — periodically fetches each due ICS feed, parses it,
// and upserts events into the unified `events` table with source='ics'.
//
// Strategy: scan-then-fan-out. The handler runs every minute (cron), finds
// every active subscription whose `last_synced_at + sync_interval_min` has
// elapsed, and processes them sequentially. Per-subscription failures stamp
// `last_error` and don't break the scan.
//
// External_id key is `<subscription_id>:<ics_uid>` so two users subscribing
// to feeds with overlapping UIDs don't collide on the unique
// (source, external_id) index.

import { eq, and, sql } from 'drizzle-orm';
import { db } from '../../lib/db.js';
import { icsSubscriptions, events } from '@deft/db/schema';
import { parseICS } from '../../lib/ics.js';
import type { JobData } from '../types.js';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB hard cap

export async function handleIcsSync(_job: JobData): Promise<void> {
  // Find every active sub that is due. NULL last_synced_at counts as due
  // (first-run case).
  const due = await db.execute(sql`
    SELECT id, org_id, user_id, ics_url, label, sync_interval_min
    FROM ics_subscriptions
    WHERE is_active = true
      AND (
        last_synced_at IS NULL
        OR last_synced_at < (now() - (sync_interval_min || ' minutes')::interval)
      )
    LIMIT 50
  `);
  const rows = (due as unknown as { rows?: Array<Record<string, unknown>> }).rows
    ?? (due as unknown as Array<Record<string, unknown>>);

  if (rows.length === 0) return;
  console.log(`[ics-sync] ${rows.length} subscription(s) due`);

  for (const row of rows) {
    const sub = row as {
      id: string;
      org_id: string;
      user_id: string;
      ics_url: string;
      label: string | null;
      sync_interval_min: number;
    };
    await syncOne(sub).catch(async (err) => {
      const msg = (err as Error).message?.slice(0, 500) ?? 'unknown error';
      console.warn(`[ics-sync] sub ${sub.id} failed: ${msg}`);
      await db
        .update(icsSubscriptions)
        .set({ last_error: msg, last_synced_at: new Date() })
        .where(eq(icsSubscriptions.id, sub.id))
        .catch(() => {});
    });
  }
}

export async function syncOne(sub: {
  id: string;
  org_id: string;
  user_id: string;
  ics_url: string;
  label: string | null;
}): Promise<{ count: number }> {
  const text = await fetchWithLimits(sub.ics_url);
  const parsed = parseICS(text);

  // Upsert each event. We rely on the existing
  // uniqueIndex(source, external_id) on the events table.
  let count = 0;
  for (const ev of parsed) {
    const externalId = `${sub.id}:${ev.uid}`;
    const title = ev.summary || '(untitled event)';
    const description = ev.description ?? '';
    const body = [description, ev.location ? `Location: ${ev.location}` : '', sub.label ? `Source: ${sub.label}` : '']
      .filter(Boolean)
      .join('\n\n');

    await db
      .insert(events)
      .values({
        org_id: sub.org_id,
        source: 'ics' as const,
        event_type: 'calendar_event',
        external_id: externalId,
        title,
        body,
        url: null,
        actor: ev.organizer,
        timestamp: ev.start,
        metadata: {
          start: ev.start.toISOString(),
          end: ev.end ? ev.end.toISOString() : null,
          all_day: ev.all_day,
          location: ev.location,
          ics_uid: ev.uid,
          ics_subscription_id: sub.id,
          ics_label: sub.label,
        },
        user_id: sub.user_id,
      })
      .onConflictDoUpdate({
        target: [events.source, events.external_id],
        set: {
          title,
          body,
          actor: ev.organizer,
          timestamp: ev.start,
          metadata: {
            start: ev.start.toISOString(),
            end: ev.end ? ev.end.toISOString() : null,
            all_day: ev.all_day,
            location: ev.location,
            ics_uid: ev.uid,
            ics_subscription_id: sub.id,
            ics_label: sub.label,
          },
        },
      });
    count += 1;
  }

  await db
    .update(icsSubscriptions)
    .set({ last_synced_at: new Date(), last_error: null, last_event_count: count })
    .where(eq(icsSubscriptions.id, sub.id));

  console.log(`[ics-sync] sub ${sub.id} synced ${count} event(s) from ${truncate(sub.ics_url, 80)}`);
  return { count };
}

async function fetchWithLimits(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Some feeds use webcal:// — rewrite to https.
    const httpsUrl = url.replace(/^webcal:\/\//i, 'https://');
    const res = await globalThis.fetch(httpsUrl, {
      method: 'GET',
      headers: { Accept: 'text/calendar, text/plain, */*' },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const ct = res.headers.get('content-type') ?? '';
    if (!/text\/calendar|text\/plain|application\/octet-stream/.test(ct)) {
      // Don't reject — Google's "secret URL" returns text/plain; some servers
      // return application/ics. Just log noise once per problem feed.
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) {
      throw new Error(`Body too large: ${buf.byteLength} bytes`);
    }
    return Buffer.from(buf).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
