import { eq } from 'drizzle-orm';
import { mcpConnections } from '@deft/db/schema';
import { db } from './db.js';
import {
  isStoredMcpCredential,
  migrateLegacyMcpCredential,
} from './mcp-connection-auth.js';
import { validateMcpConnectionTarget } from './mcp-connection-validation.js';

export interface McpCredentialMigrationResult {
  migrated: number;
  disabledUnsupportedAuth: number;
  disabledUnsafeTarget: number;
  skipped: number;
}

/** Idempotently encrypt historical plaintext MCP credential payloads. */
export async function migrateLegacyMcpConnectionCredentials(): Promise<McpCredentialMigrationResult> {
  const rows = await db
    .select({
      id: mcpConnections.id,
      auth_type: mcpConnections.auth_type,
      auth_config_encrypted: mcpConnections.auth_config_encrypted,
      transport: mcpConnections.transport,
      server_url: mcpConnections.server_url,
      stdio_command: mcpConnections.stdio_command,
      stdio_args: mcpConnections.stdio_args,
    })
    .from(mcpConnections);

  let migrated = 0;
  let disabledUnsupportedAuth = 0;
  let disabledUnsafeTarget = 0;
  let skipped = 0;

  for (const row of rows) {
    const targetError = validateMcpConnectionTarget({
      transport: row.transport,
      serverUrl: row.server_url,
      stdioCommand: row.stdio_command,
      stdioArgs: (row.stdio_args as string[] | null) ?? null,
    });
    if (targetError) {
      await db
        .update(mcpConnections)
        .set({ is_active: false, connection_error: `Disabled by MCP host policy: ${targetError}` })
        .where(eq(mcpConnections.id, row.id));
      disabledUnsafeTarget++;
    }

    if (row.auth_type !== 'none' && row.auth_type !== 'api_key') {
      await db
        .update(mcpConnections)
        .set({
          auth_type: 'none',
          auth_config_encrypted: null,
          is_active: false,
          connection_error: 'Unsupported OAuth authentication was disabled. Reconfigure this connection with an API key.',
        })
        .where(eq(mcpConnections.id, row.id));
      disabledUnsupportedAuth++;
      continue;
    }

    if (
      row.auth_config_encrypted === null
      || row.auth_config_encrypted === undefined
      || isStoredMcpCredential(row.auth_config_encrypted)
    ) {
      skipped++;
      continue;
    }

    if (
      typeof row.auth_config_encrypted === 'object'
      && !Array.isArray(row.auth_config_encrypted)
      && (row.auth_config_encrypted as Record<string, unknown>).secret_encrypted !== undefined
    ) {
      await db
        .update(mcpConnections)
        .set({
          is_active: false,
          connection_error: 'Stored MCP credentials use a reserved or invalid header name. Re-enter the credential.',
        })
        .where(eq(mcpConnections.id, row.id));
      disabledUnsupportedAuth++;
      continue;
    }

    const encrypted = migrateLegacyMcpCredential(row.auth_config_encrypted);
    if (!encrypted) {
      skipped++;
      continue;
    }

    await db
      .update(mcpConnections)
      .set({ auth_config_encrypted: encrypted })
      .where(eq(mcpConnections.id, row.id));
    migrated++;
  }

  return { migrated, disabledUnsupportedAuth, disabledUnsafeTarget, skipped };
}
