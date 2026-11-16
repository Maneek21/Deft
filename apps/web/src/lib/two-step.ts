import { api } from './api';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const ENROL_TOKEN_KEY = 'deft-two-step-enrol-token';

/** What a sign-in returns instead of a session when a second step is due. */
export type TwoStepPending = {
  status: 'code_required' | 'enrolment_required';
  token: string;
  expires_at: string;
};

export type TwoStepStatus = {
  enabled: boolean;
  confirmed_at: string | null;
  recovery_codes_remaining: number;
  required: boolean;
  can_disable: boolean;
};

export type TwoStepSession = { accessToken: string; refreshToken: string };

export function readTwoStepPending(data: unknown): TwoStepPending | null {
  const value = (data as { two_step?: Partial<TwoStepPending> } | null)?.two_step;
  if (!value || typeof value.token !== 'string') return null;
  if (value.status !== 'code_required' && value.status !== 'enrolment_required') return null;
  return { status: value.status, token: value.token, expires_at: String(value.expires_at ?? '') };
}

/** The enrol-only token lives for this tab only and is never a session. */
export function storeEnrolToken(token: string): void {
  sessionStorage.setItem(ENROL_TOKEN_KEY, token);
}
export function takeEnrolToken(): string | null {
  return sessionStorage.getItem(ENROL_TOKEN_KEY);
}
export function clearEnrolToken(): void {
  sessionStorage.removeItem(ENROL_TOKEN_KEY);
}

export class TwoStepError extends Error {
  constructor(message: string, public readonly code: string, public readonly status: number) {
    super(message);
  }
}

/**
 * Calls a two-step route. With an enrol-only token the request carries that
 * token and nothing else; otherwise it goes through the signed-in client.
 */
async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, enrolToken?: string | null): Promise<T> {
  const url = `/api/auth/two-step${path}`;
  const res = enrolToken
    ? await fetch(`${API_URL}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${enrolToken}` },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    })
    : method === 'GET' ? await api.get(url) : await api.post(url, body ?? {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new TwoStepError(twoStepMessage(data?.code, data?.error, data?.retry_after_seconds), String(data?.code ?? 'ERROR'), res.status);
  }
  return data as T;
}

export function twoStepMessage(code: unknown, fallback?: unknown, retryAfterSeconds?: unknown): string {
  switch (code) {
    case 'TWO_STEP_CODE_INVALID': return 'That code is not right. Check your authenticator app and try again.';
    case 'TWO_STEP_CHALLENGE_DEAD': return 'Too many wrong codes. Sign in again.';
    case 'TWO_STEP_CHALLENGE_INVALID': return 'This sign-in has expired. Sign in again.';
    case 'TWO_STEP_LOCKED': {
      const seconds = Number(retryAfterSeconds);
      const wait = Number.isFinite(seconds) && seconds > 0
        ? (seconds >= 90 ? `${Math.ceil(seconds / 60)} minutes` : `${Math.ceil(seconds)} seconds`)
        : 'a while';
      return `Too many wrong codes. Wait ${wait} and try again.`;
    }
    case 'TWO_STEP_REQUIRED_FOR_ROLE': return 'Owners and admins must keep two-step verification on.';
    case 'TWO_STEP_CODE_REQUIRED': return 'Enter a current code or a recovery code to replace your authenticator.';
    case 'TWO_STEP_ENROLMENT_REQUIRED':
    case 'INVALID_TOKEN': return 'Sign in again to continue.';
    default: return typeof fallback === 'string' && fallback ? fallback : 'Something went wrong. Try again.';
  }
}

export const twoStepApi = {
  status: () => request<TwoStepStatus>('GET', ''),
  startEnrolment: (proof: { code?: string; recovery_code?: string; current_password?: string }, enrolToken?: string | null) =>
    request<{ secret: string; otpauth_url: string }>('POST', '/enrol/start', proof, enrolToken),
  confirmEnrolment: (code: string, enrolToken?: string | null) =>
    request<{ recovery_codes: string[] } & Partial<TwoStepSession>>('POST', '/enrol/confirm', { code }, enrolToken),
  regenerateRecoveryCodes: (code: string) => request<{ recovery_codes: string[] }>('POST', '/recovery-codes', { code }),
  disable: (code: string) => request<{ success: true }>('POST', '/disable', { code }),
};

/** The second call of a sign-in: challenge plus a code or a recovery code. */
export async function exchangeTwoStepChallenge(challengeToken: string, proof: { code: string } | { recovery_code: string }): Promise<TwoStepSession> {
  const res = await fetch(`${API_URL}/api/auth/two-step/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_token: challengeToken, ...proof }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data.accessToken !== 'string' || typeof data.refreshToken !== 'string') {
    throw new TwoStepError(twoStepMessage(data?.code, data?.error, data?.retry_after_seconds), String(data?.code ?? 'ERROR'), res.status);
  }
  return { accessToken: data.accessToken, refreshToken: data.refreshToken };
}
