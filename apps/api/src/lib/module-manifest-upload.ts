import {
  MODULE_LIMITS,
  ModuleManifestDigestSchema,
  digestModuleManifest,
  parseDeftModuleManifestJson,
  type DeftModuleManifestV1,
} from '@deft/shared/modules';
import { ModuleError } from './module-errors.js';

export const MODULE_MANIFEST_REQUEST_MAX_BYTES = MODULE_LIMITS.manifest_bytes;

export type ModuleManifestUpload = {
  manifest: DeftModuleManifestV1;
  manifest_digest: string;
  expected_active_digest?: string;
};

function invalidManifest(message: string, details?: Record<string, unknown>): ModuleError {
  return new ModuleError(message, 'MODULE_MANIFEST_INVALID', 400, details);
}

function requestTooLarge(): ModuleError {
  return new ModuleError(
    `Module manifest request exceeds ${MODULE_MANIFEST_REQUEST_MAX_BYTES} bytes`,
    'MODULE_MANIFEST_TOO_LARGE',
    413,
    { max_bytes: MODULE_MANIFEST_REQUEST_MAX_BYTES },
  );
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw invalidManifest('Content-Length must be a non-negative integer');
    }
    if (parsed > MODULE_MANIFEST_REQUEST_MAX_BYTES) throw requestTooLarge();
  }

  if (!request.body) throw invalidManifest('A module manifest file is required');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MODULE_MANIFEST_REQUEST_MAX_BYTES) {
        await reader.cancel('module manifest request too large').catch(() => undefined);
        throw requestTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (byteLength === 0) throw invalidManifest('A module manifest file is required');
  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parseExpectedDigest(value: FormDataEntryValue | string | null): string | undefined {
  if (value === null) return undefined;
  if (typeof value !== 'string') {
    throw invalidManifest('expected_active_digest must be a string');
  }
  const trimmed = value.trim();
  const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
  const parsed = ModuleManifestDigestSchema.safeParse(unquoted);
  if (!parsed.success) {
    throw invalidManifest('expected_active_digest must be a sha256 module manifest digest');
  }
  return parsed.data;
}

function parseManifestJson(source: string): DeftModuleManifestV1 {
  try {
    return parseDeftModuleManifestJson(source);
  } catch (error) {
    if (error instanceof ModuleError) throw error;
    const details = error && typeof error === 'object' && 'issues' in error
      ? {
          issues: Array.isArray((error as { issues: unknown }).issues)
            ? (error as { issues: Array<{ path?: unknown; message?: unknown }> }).issues.map((issue) => ({
                path: Array.isArray(issue.path) ? issue.path : [],
                message: typeof issue.message === 'string' ? issue.message : 'Invalid manifest value',
              }))
            : [],
        }
      : undefined;
    throw invalidManifest(
      error instanceof Error ? error.message : 'Module manifest is invalid',
      details,
    );
  }
}

function decodeManifestJson(body: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw invalidManifest('Module manifest must be valid UTF-8 JSON');
  }
}

async function parseMultipart(
  body: Uint8Array,
  contentType: string,
): Promise<{ manifest: DeftModuleManifestV1; expected_active_digest?: string }> {
  let form: FormData;
  try {
    const copiedBody = body.slice().buffer as ArrayBuffer;
    form = await new Response(copiedBody, { headers: { 'content-type': contentType } }).formData();
  } catch {
    throw invalidManifest('Malformed multipart module manifest request');
  }

  const allowed = new Set(['file', 'expected_active_digest']);
  for (const key of form.keys()) {
    if (!allowed.has(key)) throw invalidManifest(`Unexpected multipart field: ${key}`);
  }
  if (form.getAll('file').length !== 1 || form.getAll('expected_active_digest').length > 1) {
    throw invalidManifest('Provide exactly one module manifest file');
  }

  const file = form.get('file');
  if (!(file instanceof Blob)) throw invalidManifest('The file field must contain a local JSON file');
  const namedFile = file as Blob & { name?: string };
  if (namedFile.name && namedFile.name !== 'deft.module.json') {
    throw invalidManifest('The module manifest filename must be deft.module.json');
  }
  if (file.size > MODULE_LIMITS.manifest_bytes) throw requestTooLarge();

  const expected = parseExpectedDigest(form.get('expected_active_digest'));
  return {
    manifest: parseManifestJson(decodeManifestJson(new Uint8Array(await file.arrayBuffer()))),
    ...(expected ? { expected_active_digest: expected } : {}),
  };
}

/**
 * Parse one local-only module manifest upload without buffering more than the
 * public 128 KiB policy. JSON requests contain the manifest directly. For an
 * upgrade, JSON clients send the current digest in If-Match; multipart clients
 * use the expected_active_digest form field.
 */
export async function parseModuleManifestUpload(
  request: Request,
  options: { requireExpectedActiveDigest?: boolean } = {},
): Promise<ModuleManifestUpload> {
  const body = await readBoundedBody(request);
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  let parsed: { manifest: DeftModuleManifestV1; expected_active_digest?: string };

  if (contentType.startsWith('application/json')) {
    const expected = parseExpectedDigest(
      request.headers.get('if-match') ?? request.headers.get('x-deft-expected-manifest-digest'),
    );
    parsed = {
      manifest: parseManifestJson(decodeManifestJson(body)),
      ...(expected ? { expected_active_digest: expected } : {}),
    };
  } else if (contentType.startsWith('multipart/form-data;')) {
    parsed = await parseMultipart(body, request.headers.get('content-type') ?? contentType);
  } else {
    throw new ModuleError(
      'Module manifests must be sent as application/json or multipart/form-data',
      'MODULE_MEDIA_TYPE_UNSUPPORTED',
      415,
    );
  }

  if (options.requireExpectedActiveDigest && !parsed.expected_active_digest) {
    throw invalidManifest('expected_active_digest is required for module upgrades');
  }
  return {
    ...parsed,
    manifest_digest: await digestModuleManifest(parsed.manifest),
  };
}
