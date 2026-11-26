import {
  MODULE_LIMITS,
  ModuleManifestDigestSchema,
  digestSupportedModuleManifest as digestModuleManifest,
  parseSupportedDeftModuleManifestJson as parseDeftModuleManifestJson,
  type DeftModuleManifest as DeftModuleManifestV1,
} from '@deft/shared/modules';
import { formatManifestError } from '@deft/shared/module-issues';
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
    `The app file is larger than ${MODULE_MANIFEST_REQUEST_MAX_BYTES} bytes`,
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

  if (!request.body) throw invalidManifest('An app file is required');
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

  if (byteLength === 0) throw invalidManifest('An app file is required');
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
    throw invalidManifest('expected_active_digest must be a sha256 app file digest');
  }
  return parsed.data;
}

function parseManifestJson(source: string): DeftModuleManifestV1 {
  try {
    return parseDeftModuleManifestJson(source);
  } catch (error) {
    if (error instanceof ModuleError) throw error;
    // Validator output is turned into at most three plain lines that name
    // where the problem is. Raw validator JSON never reaches the response.
    let input: unknown;
    try { input = JSON.parse(source) as unknown; } catch { input = undefined; }
    const readable = formatManifestError(error, { input, source, subject: 'App file' });
    throw invalidManifest(readable.message, { issues: readable.issues, lines: readable.lines });
  }
}

function decodeManifestJson(body: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw invalidManifest('The app file must be UTF-8 JSON text');
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
    throw invalidManifest('The upload could not be read. Send the app file again.');
  }

  const allowed = new Set(['file', 'expected_active_digest']);
  for (const key of form.keys()) {
    if (!allowed.has(key)) throw invalidManifest('The upload has an unexpected form field. Send only the app file.');
  }
  if (form.getAll('file').length !== 1 || form.getAll('expected_active_digest').length > 1) {
    throw invalidManifest('Send exactly one app file');
  }

  const file = form.get('file');
  if (!(file instanceof Blob)) throw invalidManifest('The file field must contain a local JSON file');
  const namedFile = file as Blob & { name?: string };
  if (namedFile.name && namedFile.name !== 'deft.module.json') {
    throw invalidManifest('The app file must be named deft.module.json');
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
      'App files must be sent as application/json or multipart/form-data',
      'MODULE_MEDIA_TYPE_UNSUPPORTED',
      415,
    );
  }

  if (options.requireExpectedActiveDigest && !parsed.expected_active_digest) {
    throw invalidManifest('expected_active_digest is required to update an app');
  }
  return {
    ...parsed,
    manifest_digest: await digestModuleManifest(parsed.manifest),
  };
}
