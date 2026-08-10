import { z } from 'zod';
import { decrypt, encrypt } from './encryption.js';

const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const DEFAULT_HEADER_NAME = 'Authorization';
const DEFAULT_SCHEME = 'Bearer';
const DEFAULT_ENV_VAR = 'MCP_API_KEY';

const UNSAFE_CREDENTIAL_HEADER_NAMES = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'mcp-protocol-version',
  'mcp-session-id',
  'origin',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'forwarded',
  'x-http-method-override',
  'x-method-override',
  'x-original-host',
  'x-original-method',
  'x-original-url',
  'x-rewrite-url',
]);

export function isSafeMcpCredentialHeaderName(name: string): boolean {
  const normalized = name.toLowerCase();
  return HTTP_TOKEN.test(name)
    && !UNSAFE_CREDENTIAL_HEADER_NAMES.has(normalized)
    && !normalized.startsWith('x-forwarded-')
    && !normalized.startsWith('x-original-');
}

const credentialHeaderNameSchema = z.string()
  .min(1)
  .max(128)
  .regex(HTTP_TOKEN)
  .refine(isSafeMcpCredentialHeaderName, 'Reserved HTTP/MCP routing headers cannot carry connector credentials');

export const mcpAuthTypeSchema = z.enum(['none', 'api_key']);
export type McpAuthType = z.infer<typeof mcpAuthTypeSchema>;

export const mcpCredentialInputSchema = z.object({
  secret: z.string().min(1).max(16_384),
  header_name: credentialHeaderNameSchema.optional(),
  scheme: z.string().min(1).max(64).regex(HTTP_TOKEN).nullable().optional(),
  env_var: z.string().min(1).max(128).regex(ENV_NAME).optional(),
}).strict();

export type McpCredentialInput = z.infer<typeof mcpCredentialInputSchema>;

const storedMcpCredentialSchema = z.object({
  version: z.literal(1),
  kind: z.literal('api_key'),
  secret_encrypted: z.string().min(1),
  header_name: credentialHeaderNameSchema,
  scheme: z.string().min(1).max(64).regex(HTTP_TOKEN).nullable(),
  env_var: z.string().min(1).max(128).regex(ENV_NAME),
}).strict();

export type StoredMcpCredential = z.infer<typeof storedMcpCredentialSchema>;

export interface McpCredentialSettings {
  header_name: string;
  scheme: string | null;
  env_var: string;
}

export function storeMcpCredential(input: McpCredentialInput): StoredMcpCredential {
  const parsed = mcpCredentialInputSchema.parse(input);
  return {
    version: 1,
    kind: 'api_key',
    secret_encrypted: encrypt(parsed.secret),
    header_name: parsed.header_name ?? DEFAULT_HEADER_NAME,
    scheme: parsed.scheme === undefined ? DEFAULT_SCHEME : parsed.scheme,
    env_var: parsed.env_var ?? DEFAULT_ENV_VAR,
  };
}

export function isStoredMcpCredential(value: unknown): value is StoredMcpCredential {
  return storedMcpCredentialSchema.safeParse(value).success;
}

function legacyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function legacySettings(value: unknown): McpCredentialSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      header_name: DEFAULT_HEADER_NAME,
      scheme: DEFAULT_SCHEME,
      env_var: DEFAULT_ENV_VAR,
    };
  }

  const record = value as Record<string, unknown>;
  const headerCandidate = legacyString(record.header_name) ?? legacyString(record.header);
  const schemeCandidate = record.scheme === null ? null : legacyString(record.scheme);
  const envCandidate = legacyString(record.env_var) ?? legacyString(record.env);

  return {
    header_name: headerCandidate && isSafeMcpCredentialHeaderName(headerCandidate)
      ? headerCandidate
      : DEFAULT_HEADER_NAME,
    scheme: schemeCandidate === null
      ? null
      : schemeCandidate && HTTP_TOKEN.test(schemeCandidate)
        ? schemeCandidate
        : DEFAULT_SCHEME,
    env_var: envCandidate && ENV_NAME.test(envCandidate)
      ? envCandidate
      : DEFAULT_ENV_VAR,
  };
}

function extractLegacySecret(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ['api_key', 'apiKey', 'token', 'access_token', 'bearer_token', 'secret']) {
    const secret = legacyString(record[key]);
    if (secret) return secret;
  }
  return undefined;
}

/**
 * Convert the historical plaintext JSON payload to the encrypted v1 envelope.
 * Unknown legacy shapes are encrypted as an opaque secret instead of remaining
 * readable at rest; the old runtime ignored these payloads in any case.
 */
export function migrateLegacyMcpCredential(value: unknown): StoredMcpCredential | null {
  if (value === null || value === undefined) return null;
  if (isStoredMcpCredential(value)) return value;
  if (
    typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).secret_encrypted !== undefined
  ) return null;

  const secret = extractLegacySecret(value)
    ?? (typeof value === 'string' ? value : JSON.stringify(value));
  if (!secret) return null;

  const settings = legacySettings(value);
  return storeMcpCredential({ secret, ...settings });
}

export function getMcpCredentialSettings(value: unknown): McpCredentialSettings | null {
  if (isStoredMcpCredential(value)) {
    return {
      header_name: value.header_name,
      scheme: value.scheme,
      env_var: value.env_var,
    };
  }
  return value === null || value === undefined ? null : legacySettings(value);
}

export function redactMcpConnection<T extends Record<string, unknown>>(
  connection: T,
): Omit<T, 'auth_config_encrypted'> & {
  has_credentials: boolean;
  credential_settings: McpCredentialSettings | null;
} {
  const { auth_config_encrypted, ...safe } = connection;
  return {
    ...safe,
    has_credentials: auth_config_encrypted !== null && auth_config_encrypted !== undefined,
    credential_settings: getMcpCredentialSettings(auth_config_encrypted),
  };
}

/**
 * Decrypt the credential only while constructing an active transport config.
 * The returned value should be passed directly to the MCP client and never
 * serialized, cached in database rows, or returned from an API route.
 */
export function resolveMcpRuntimeAuth(
  authType: string,
  storedValue: unknown,
  transport: 'stdio' | 'sse' | 'streamable-http',
): { headers?: Record<string, string>; env?: Record<string, string> } {
  if (authType === 'none') return {};
  if (authType !== 'api_key') {
    throw new Error(`Unsupported MCP authentication type: ${authType}`);
  }
  if (!isStoredMcpCredential(storedValue)) {
    throw new Error('MCP credentials are missing or awaiting secure migration');
  }

  const secret = decrypt(storedValue.secret_encrypted);
  if (transport === 'stdio') {
    return { env: { [storedValue.env_var]: secret } };
  }

  const headerValue = storedValue.scheme
    ? `${storedValue.scheme} ${secret}`
    : secret;
  return { headers: { [storedValue.header_name]: headerValue } };
}
