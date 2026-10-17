import { AppError } from './app-errors.js';
import { PRIVATE_FILE_LIMITS, PrivateFileUploadSchema } from './app-private-file-contract.js';

const active = new Map<string, number>();
let totalActive = 0;
const invalid = () => new AppError('Invalid private file upload', 'APP_ACTION_INVALID', 400);

export function parsePrivateFileUpload(request: Request) {
  const query = [...new URL(request.url).searchParams];
  if (query.length !== 3 || new Set(query.map(([key]) => key)).size !== 3
    || query.some(([key]) => !['expected_revision', 'upload_operation_id', 'filename'].includes(key))) throw invalid();
  const raw = Object.fromEntries(query);
  if (!/^[1-9][0-9]{0,9}$/.test(raw.expected_revision ?? '')) throw invalid();
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^[1-9][0-9]*$/.test(declared) || Number(declared) > PRIVATE_FILE_LIMITS.file_bytes)) throw invalid();
  return PrivateFileUploadSchema.parse({ ...raw, expected_revision: Number(raw.expected_revision),
    media_type: request.headers.get('content-type')?.trim().toLowerCase() });
}

/** Capacity covers the read and its mutation, including cancelled DB settlement. */
export async function withPrivateFileUpload<T>(ownerScope: string, request: Request,
  use: (bytes: Uint8Array) => Promise<T>): Promise<T> {
  if (totalActive >= 8 || (active.get(ownerScope) ?? 0) >= 2) {
    throw new AppError('Private file upload is busy', 'APP_ACTION_UNAVAILABLE', 503);
  }
  totalActive++; active.set(ownerScope, (active.get(ownerScope) ?? 0) + 1);
  const reader = request.body?.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectRead: ((error: unknown) => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => { rejectRead = reject; });
  const abort = () => { rejectRead?.(invalid()); void reader?.cancel().catch(() => undefined); };
  try {
    if (!reader || request.signal.aborted) throw invalid();
    request.signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(abort, PRIVATE_FILE_LIMITS.transfer_ms);
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const next = await Promise.race([reader.read(), interrupted]);
      if (next.done) break;
      length += next.value.byteLength;
      if (length > PRIVATE_FILE_LIMITS.file_bytes) throw invalid();
      chunks.push(next.value);
    }
    if (!length || request.signal.aborted) throw invalid();
    const declared = request.headers.get('content-length');
    if (declared !== null && Number(declared) !== length) throw invalid();
    clearTimeout(timer); timer = undefined;
    request.signal.removeEventListener('abort', abort);
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return await use(bytes);
  } finally {
    if (timer) clearTimeout(timer);
    request.signal.removeEventListener('abort', abort);
    void reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
    totalActive--; const remaining = (active.get(ownerScope) ?? 1) - 1;
    if (remaining) active.set(ownerScope, remaining); else active.delete(ownerScope);
  }
}
