// The one rule for where an AI model request may be sent.
//
// Self-hosted installs may point any provider at an address of their choice
// (a model server on their own network, an OpenAI-compatible gateway, an
// Ollama box). That is unchanged: outside hosted mode these helpers hand back
// exactly what they were given and callers keep their own defaults.
//
// On a hosted cell nobody runs a model on their own network, and a custom
// address would let a workspace admin make the server fetch any address.
// So in hosted mode only the built-in, named providers are allowed, each at
// its standard address; Ollama and custom addresses are refused, whether they
// arrive in a save request, sit in stored configuration, or come from the
// environment (OLLAMA_URL and friends).

import { isHostedMode } from './hosted-mode.js';

export type AiAddressProvider = 'anthropic' | 'openai' | 'openrouter' | 'ollama';

export const STANDARD_AI_PROVIDER_ADDRESSES = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
} as const;

export const HOSTED_AI_ADDRESS_REFUSED = 'HOSTED_CUSTOM_AI_ADDRESS_REFUSED';

export type AiProviderAddress =
  | { allowed: true; baseUrl: string | undefined }
  | { allowed: false; reason: string };

export class AiAddressRefusedError extends Error {
  readonly code = HOSTED_AI_ADDRESS_REFUSED;
  constructor(reason: string) {
    super(reason);
    this.name = 'AiAddressRefusedError';
  }
}

function sameAddress(a: string, b: string): boolean {
  const norm = (value: string) => value.trim().replace(/\/+$/u, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Decides the address for a provider. `customAddress` is whatever the caller
 * would use today (a route's baseUrl, the org's Ollama URL, an embedding
 * base_url, an environment value). Self-hosted: returned unchanged (null
 * becomes undefined), so callers behave exactly as before. Hosted: Ollama is
 * refused, a custom address other than the provider's standard one is
 * refused, and otherwise the standard address is returned.
 */
export function aiProviderAddress(provider: AiAddressProvider, customAddress?: string | null): AiProviderAddress {
  if (!isHostedMode()) return { allowed: true, baseUrl: customAddress ?? undefined };
  const custom = typeof customAddress === 'string' ? customAddress.trim() : '';
  if (provider === 'ollama') {
    return { allowed: false, reason: 'Ollama is not available on hosted Deft. Use Anthropic, OpenAI or OpenRouter.' };
  }
  const standard = STANDARD_AI_PROVIDER_ADDRESSES[provider];
  if (custom && !sameAddress(custom, standard)) {
    return { allowed: false, reason: `Custom AI addresses are not available on hosted Deft. ${provider} uses ${standard}.` };
  }
  return { allowed: true, baseUrl: standard };
}

/** Throwing form of `aiProviderAddress` for the places that are about to fetch. */
export function requireAiProviderAddress(provider: AiAddressProvider, customAddress?: string | null): string | undefined {
  const decision = aiProviderAddress(provider, customAddress);
  if (!decision.allowed) throw new AiAddressRefusedError(decision.reason);
  return decision.baseUrl;
}

/**
 * Options for the Anthropic SDK client. The SDK reads ANTHROPIC_BASE_URL from
 * the environment when no baseURL is given; hosted mode pins the standard
 * address instead. Self-hosted: no option, exactly as before.
 */
export function anthropicClientAddress(): { baseURL?: string } {
  return isHostedMode() ? { baseURL: STANDARD_AI_PROVIDER_ADDRESSES.anthropic } : {};
}

/**
 * An address taken from the environment (OLLAMA_URL, TRANSCRIPTION_OPENAI_BASE_URL).
 * Hosted mode ignores it; self-hosted gets the value exactly as before.
 */
export function environmentAiAddress(value: string | null | undefined): string {
  if (isHostedMode()) return '';
  return value ?? '';
}
