import { api } from './api';

export type ProtectedFileRequest = (
  path: string,
  options?: RequestInit,
) => Promise<Response>;

export function protectedFilePath(fileId: string): string {
  const normalizedId = fileId.trim();
  if (!normalizedId) throw new Error('Attachment id is required');
  return `/api/files/${encodeURIComponent(normalizedId)}`;
}

async function protectedFileError(response: Response): Promise<string> {
  const body = await response.clone().json().catch(() => null) as {
    error?: unknown;
    message?: unknown;
  } | null;
  if (typeof body?.error === 'string' && body.error.trim()) return body.error;
  if (typeof body?.message === 'string' && body.message.trim()) return body.message;
  return `Unable to open attachment (${response.status})`;
}

export async function fetchProtectedFile(
  fileId: string,
  request: ProtectedFileRequest = (path, options) => api.fetch(path, options),
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await request(protectedFilePath(fileId), { signal });
  if (!response.ok) throw new Error(await protectedFileError(response));
  return response.blob();
}
