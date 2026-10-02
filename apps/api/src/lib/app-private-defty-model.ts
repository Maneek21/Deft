import { createHmac } from 'node:crypto';
import { canonicalCapabilityJson } from '@deft/shared';
import type { AppRunKeyProvider } from './app-run-keyrings.js';
import { AppRunKeyVersionUnavailableError } from './app-run-keyrings.js';
import type { ResolvedReasonProvider } from './org-ai-config.js';
import { PrivateDeftyModelDestination } from './app-private-defty-contract.js';

/** Exact normalized destination, not a wildcard provider grant. Query/fragment
 * endpoint credentials are rejected rather than copied into review metadata. */
export function privateDeftyEndpoint(resolved: ResolvedReasonProvider): string {
  const endpoint = new URL(resolved.baseUrl || (resolved.provider === 'anthropic'
    ? 'https://api.anthropic.com' : resolved.provider === 'ollama'
      ? 'http://localhost:11434' : resolved.provider === 'openrouter'
        ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1'));
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash) throw new Error('Private model endpoint unavailable');
  endpoint.pathname = endpoint.pathname.replace(/\/+$/u, '') || '/';
  return endpoint.toString().replace(/\/$/u, '');
}

export function privateDeftyDestination(keys: AppRunKeyProvider, resolved: ResolvedReasonProvider,
  keyVersion?: string) {
  const key = keyVersion ? keys.read('fingerprint', keyVersion) : keys.current('fingerprint');
  if (!key) throw new AppRunKeyVersionUnavailableError();
  try {
    return PrivateDeftyModelDestination.parse({
      provider: resolved.provider, model: resolved.model, endpoint: privateDeftyEndpoint(resolved),
      credential_key_version: key.key_id,
      credential_fingerprint: `hmac-sha256:${createHmac('sha256', key.key)
        .update('deft.private_defty.model_credential.v1\0').update(resolved.apiKey).digest('hex')}`,
      reasoning_effort: resolved.reasoningEffort ?? null,
    });
  } finally { key.key.fill(0); }
}

export function equalPrivateDeftyDestination(left: unknown, right: unknown): boolean {
  return canonicalCapabilityJson(PrivateDeftyModelDestination.parse(left))
    === canonicalCapabilityJson(PrivateDeftyModelDestination.parse(right));
}
