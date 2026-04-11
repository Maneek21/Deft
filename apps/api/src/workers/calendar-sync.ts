import { db } from '../lib/db.js';
import { connectedAccounts, events } from '@deft/db/schema';
import { eq, and } from 'drizzle-orm';
import { decrypt, encrypt } from '../lib/encryption.js';
import { env } from '../lib/env.js';

export async function syncCalendarForUser(accountId: string) {
  // 1. Get connection record
  const [account] = await db.select().from(connectedAccounts)
    .where(eq(connectedAccounts.id, accountId)).limit(1);
  if (!account) return { error: 'Account not found' };

  // 2. Decrypt access token
  let accessToken = decrypt(account.access_token_encrypted);

  // 3. Check if token needs refresh
  if (account.token_expires_at && new Date(account.token_expires_at) < new Date(Date.now() + 5 * 60 * 1000)) {
    // Refresh token
    if (!account.refresh_token_encrypted) return { error: 'No refresh token' };
    const refreshToken = decrypt(account.refresh_token_encrypted);

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    const data = await res.json() as any;
    if (data.access_token) {
      accessToken = data.access_token;
      await db.update(connectedAccounts).set({
        access_token_encrypted: encrypt(data.access_token),
        token_expires_at: new Date(Date.now() + (data.expires_in || 3600) * 1000),
        sync_error: null,
      }).where(eq(connectedAccounts.id, accountId));
    } else {
      await db.update(connectedAccounts).set({ sync_error: 'Token refresh failed' })
        .where(eq(connectedAccounts.id, accountId));
      return { error: 'Token refresh failed' };
    }
  }

  // 4. Fetch events from Google Calendar API
  const now = new Date();
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 86400000);
  const thirtyDaysFromNow = new Date(now.getTime() + 30 * 86400000);

  const params = new URLSearchParams({
    timeMin: fourteenDaysAgo.toISOString(),
    timeMax: thirtyDaysFromNow.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
  });

  try {
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const err = await res.text();
      await db.update(connectedAccounts).set({ sync_error: `API error: ${res.status}` })
        .where(eq(connectedAccounts.id, accountId));
      return { error: `Google API error: ${res.status}` };
    }

    const data = await res.json() as any;
    const items = data.items || [];

    // 5. Upsert events
    let synced = 0;
    for (const item of items) {
      if (!item.id) continue;

      const eventData = {
        org_id: account.org_id,
        source: 'google_calendar' as const,
        event_type: 'calendar_event',
        external_id: item.id,
        title: item.summary || 'Untitled event',
        body: item.description || null,
        url: item.htmlLink || null,
        actor: item.organizer?.email || null,
        timestamp: new Date(item.start?.dateTime || item.start?.date || now),
        metadata: {
          start: item.start?.dateTime || item.start?.date,
          end: item.end?.dateTime || item.end?.date,
          location: item.location || null,
          attendees: (item.attendees || []).map((a: any) => ({
            email: a.email,
            displayName: a.displayName || null,
            responseStatus: a.responseStatus || null,
          })),
          hangoutLink: item.hangoutLink || null,
          status: item.status || null,
          allDay: !item.start?.dateTime,
        },
        user_id: account.user_id,
        connected_account_id: account.id,
      };

      // Upsert by source + external_id
      const existing = await db.select({ id: events.id }).from(events)
        .where(and(eq(events.source, 'google_calendar'), eq(events.external_id, item.id)))
        .limit(1);

      if (existing.length > 0) {
        await db.update(events).set(eventData).where(eq(events.id, existing[0]!.id));
      } else {
        await db.insert(events).values(eventData);
      }
      synced++;
    }

    // 6. Update last_sync_at
    await db.update(connectedAccounts).set({ last_sync_at: new Date(), sync_error: null })
      .where(eq(connectedAccounts.id, accountId));

    return { synced, total: items.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    await db.update(connectedAccounts).set({ sync_error: msg })
      .where(eq(connectedAccounts.id, accountId));
    return { error: msg };
  }
}
