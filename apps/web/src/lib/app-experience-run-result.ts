export const EXPERIENCE_RUN_RESULT_MAX_BYTES = 65536;
export type ExperienceRunResult = { runId: string; expiresAt: string; providerSucceeded: boolean;
  fields: { key: string; label: string; value: string | number | boolean | null }[] };
const unavailable = (): never => { throw new Error('Result unavailable'); };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable();
  return value as Record<string, unknown>;
};
export function experienceRunResult(value: unknown, expectedRunId: string, now = Date.now()): ExperienceRunResult {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > EXPERIENCE_RUN_RESULT_MAX_BYTES) unavailable();
  const envelope = object(value), run = object(envelope.run), result = object(envelope.value);
  if (Object.keys(envelope).sort().join(',') !== 'run,value' || run.id !== expectedRunId
    || typeof run.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(run.id)
    || typeof run.result_expires_at !== 'string' || !Number.isFinite(Date.parse(run.result_expires_at))
    || Date.parse(run.result_expires_at) <= now || run.result_purged_at !== null
    || Object.keys(result).sort().join(',') !== 'output,provider_succeeded,schema_version'
    || result.schema_version !== 'deft.app_run_provider_result.v1' || typeof result.provider_succeeded !== 'boolean') unavailable();
  const output = object(result.output), entries = Object.entries(output);
  if (entries.length > 32) unavailable();
  const fields = entries.map(([key, item]) => {
    if (!key.length || key.length > 128 || /[\r\n\0]/.test(key)
      || !(item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item))) unavailable();
    return { key, label: key.replaceAll('_', ' ').replaceAll('-', ' '), value: item as string | number | boolean | null };
  });
  return { runId: run.id as string, expiresAt: run.result_expires_at as string,
    providerSucceeded: result.provider_succeeded as boolean, fields };
}
export async function readExperienceRunResult(response: Response, expectedRunId: string, signal?: AbortSignal) {
  if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) unavailable();
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > EXPERIENCE_RUN_RESULT_MAX_BYTES)) unavailable();
  signal?.throwIfAborted();
  const reader = response.body?.getReader(); if (!reader) return unavailable();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > EXPERIENCE_RUN_RESULT_MAX_BYTES) { await reader.cancel(); unavailable(); }
      chunks.push(value); signal?.throwIfAborted();
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  signal?.throwIfAborted();
  return experienceRunResult(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), expectedRunId);
}
