import { env } from './env.js';

function clean(url: string): string {
  return url.replace(/\/+$/, '');
}

export function apiPublicUrl(): string {
  return clean(env.DEFT_PUBLIC_URL || env.NEXT_PUBLIC_API_URL || `http://localhost:${env.API_PORT}`);
}

export function appPublicUrl(): string {
  return clean(env.DEFT_PUBLIC_URL || env.NEXT_PUBLIC_APP_URL);
}

export function mcpResourceUrl(): string {
  return `${apiPublicUrl()}/api/mcp/v1`;
}

export function oauthIssuerUrl(): string {
  return apiPublicUrl();
}

export function isHttpsPublicUrl(): boolean {
  const url = apiPublicUrl();
  return url.startsWith('https://') || url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1');
}
