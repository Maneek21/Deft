/**
 * Phase 8 — Integration token helper.
 *
 * Reads an `integrations` row, decrypts the access token, refreshes it if
 * expired (calling the provider-specific refresh helper), and returns the
 * raw access token the caller can pass to API requests.
 *
 * Keeping this in one place means DeploymentProvider implementations never
 * touch encryption/refresh logic — they just ask for a fresh token.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db.js';
import { integrations } from '@deft/db/schema';
import { decrypt, encrypt } from '../encryption.js';
import { refreshRailwayToken } from '../railway-oauth.js';

const REFRESH_SKEW_MS = 60_000;

export async function getFreshIntegrationAccessToken(
  integrationId: string,
): Promise<string> {
  const [row] = await db
    .select()
    .from(integrations)
    .where(eq(integrations.id, integrationId))
    .limit(1);
  if (!row) throw new Error(`Integration ${integrationId} not found`);
  if (row.status !== 'connected') {
    throw new Error(`Integration ${integrationId} is ${row.status}`);
  }

  const now = Date.now();
  const expired =
    row.access_token_expires_at &&
    row.access_token_expires_at.getTime() - REFRESH_SKEW_MS <= now;

  if (!expired) {
    return decrypt(row.access_token_encrypted);
  }

  if (!row.refresh_token_encrypted) {
    // Expired and we can't refresh — surface and let the caller mark the
    // integration as `error` so the UI prompts a reconnect.
    throw new Error(
      `Integration ${integrationId} access token is expired and no refresh token is available`,
    );
  }

  const refreshToken = decrypt(row.refresh_token_encrypted);

  let refreshed;
  try {
    if (row.provider === 'railway') {
      refreshed = await refreshRailwayToken(refreshToken);
    } else {
      throw new Error(`Token refresh not implemented for provider ${row.provider}`);
    }
  } catch (err) {
    await db
      .update(integrations)
      .set({ status: 'error' })
      .where(eq(integrations.id, integrationId));
    throw err;
  }

  const newAccess = encrypt(refreshed.access_token);
  const newRefresh = refreshed.refresh_token
    ? encrypt(refreshed.refresh_token)
    : row.refresh_token_encrypted;
  const newExpiry = new Date(now + refreshed.expires_in * 1000);

  await db
    .update(integrations)
    .set({
      access_token_encrypted: newAccess,
      refresh_token_encrypted: newRefresh,
      access_token_expires_at: newExpiry,
      last_used_at: new Date(),
    })
    .where(eq(integrations.id, integrationId));

  return refreshed.access_token;
}
