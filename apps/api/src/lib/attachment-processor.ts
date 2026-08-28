import { createHash } from 'node:crypto';
import { extname } from 'node:path';

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_EXTRACTED_TEXT_BYTES = 256 * 1024;

export type AttachmentKind =
  | 'text'
  | 'image'
  | 'spreadsheet'
  | 'pdf'
  | 'document'
  | 'archive'
  | 'binary';

export type AttachmentProcessingStatus = 'ready' | 'blocked' | 'failed';

export type AttachmentDerivative = {
  kind: 'text';
  mimeType: 'text/plain';
  content: string;
  sizeBytes: number;
  metadata: { source_mime_type: string };
};

export type AttachmentProcessingResult = {
  detectedMimeType: string;
  kind: AttachmentKind;
  contentSha256: string;
  status: AttachmentProcessingStatus;
  error: string | null;
  derivative: AttachmentDerivative | null;
};

type Detection = {
  mimeType: string;
  kind: AttachmentKind;
  text: string | null;
  strong: boolean;
};

const GENERIC_MIME_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);
const TEXT_EXTENSIONS = new Set(['.csv', '.json', '.md', '.markdown', '.txt', '.tsv']);
const EXECUTABLE_EXTENSIONS = new Set(['.bat', '.cmd', '.com', '.dll', '.exe', '.msi', '.ps1', '.scr']);
const MACRO_EXTENSIONS = new Set(['.docm', '.pptm', '.xlsm', '.xltm']);
const ACTIVE_MIME_TYPES = new Set(['image/svg+xml', 'text/html', 'application/xhtml+xml']);

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function decodeText(bytes: Uint8Array): string | null {
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    let controls = 0;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if ((code < 9 || (code > 13 && code < 32)) && code !== 0xfeff) controls += 1;
    }
    if (controls > Math.max(2, Math.floor(value.length * 0.01))) return null;
    return value;
  } catch {
    return null;
  }
}

function textMimeType(extension: string, declaredMimeType: string): string {
  if (extension === '.csv' || declaredMimeType === 'text/csv' || declaredMimeType === 'application/csv') {
    return 'text/csv';
  }
  if (extension === '.tsv' || declaredMimeType === 'text/tab-separated-values') {
    return 'text/tab-separated-values';
  }
  if (extension === '.json' || declaredMimeType === 'application/json') return 'application/json';
  if (extension === '.md' || extension === '.markdown' || declaredMimeType === 'text/markdown') {
    return 'text/markdown';
  }
  return 'text/plain';
}

function detect(bytes: Uint8Array, extension: string, declaredMimeType: string): Detection {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mimeType: 'image/png', kind: 'image', text: null, strong: true };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { mimeType: 'image/jpeg', kind: 'image', text: null, strong: true };
  }
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
    return { mimeType: 'image/gif', kind: 'image', text: null, strong: true };
  }
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46])
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { mimeType: 'image/webp', kind: 'image', text: null, strong: true };
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return { mimeType: 'application/pdf', kind: 'pdf', text: null, strong: true };
  }
  if (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])
    || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])
    || startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])
  ) {
    if (extension === '.xlsx') {
      return {
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        kind: 'spreadsheet',
        text: null,
        strong: true,
      };
    }
    if (extension === '.docx') {
      return {
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        kind: 'document',
        text: null,
        strong: true,
      };
    }
    if (extension === '.pptx') {
      return {
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        kind: 'document',
        text: null,
        strong: true,
      };
    }
    return { mimeType: 'application/zip', kind: 'archive', text: null, strong: true };
  }

  const text = decodeText(bytes);
  if (text !== null) {
    return {
      mimeType: textMimeType(extension, declaredMimeType),
      kind: extension === '.csv' || extension === '.tsv'
        || declaredMimeType === 'text/csv'
        || declaredMimeType === 'application/csv'
        || declaredMimeType === 'application/vnd.ms-excel'
        ? 'spreadsheet'
        : 'text',
      text,
      strong: TEXT_EXTENSIONS.has(extension) || declaredMimeType.startsWith('text/')
        || declaredMimeType === 'application/json'
        || declaredMimeType === 'application/csv',
    };
  }
  return { mimeType: 'application/octet-stream', kind: 'binary', text: null, strong: false };
}

function declaredTypeMatches(declared: string, detected: Detection): boolean {
  if (GENERIC_MIME_TYPES.has(declared)) return true;
  if (detected.mimeType === declared) return true;
  if (detected.mimeType === 'text/csv') {
    return declared === 'application/csv' || declared === 'application/vnd.ms-excel' || declared === 'text/plain';
  }
  if (detected.mimeType === 'text/tab-separated-values') return declared === 'text/plain';
  if (detected.mimeType === 'text/markdown') return declared === 'text/plain';
  if (detected.kind === 'spreadsheet' && detected.mimeType.includes('openxmlformats')) {
    return declared === 'application/zip' || declared === 'application/vnd.ms-excel';
  }
  return false;
}

function blockedResult(
  detectedMimeType: string,
  kind: AttachmentKind,
  contentSha256: string,
  error: string,
): AttachmentProcessingResult {
  return { detectedMimeType, kind, contentSha256, status: 'blocked', error, derivative: null };
}

export function processAttachment(params: {
  filename: string;
  declaredMimeType?: string | null;
  bytes: Uint8Array;
}): AttachmentProcessingResult {
  const declaredMimeType = (params.declaredMimeType ?? '').toLowerCase().split(';', 1)[0]!.trim();
  const extension = extname(params.filename).toLowerCase();
  const contentSha256 = `sha256:${createHash('sha256').update(params.bytes).digest('hex')}`;

  if (params.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    return {
      detectedMimeType: 'application/octet-stream',
      kind: 'binary',
      contentSha256,
      status: 'failed',
      error: 'file_size_limit',
      derivative: null,
    };
  }

  if (
    EXECUTABLE_EXTENSIONS.has(extension)
    || startsWith(params.bytes, [0x4d, 0x5a])
    || startsWith(params.bytes, [0x7f, 0x45, 0x4c, 0x46])
    || startsWith(params.bytes, [0xfe, 0xed, 0xfa, 0xce])
    || startsWith(params.bytes, [0xcf, 0xfa, 0xed, 0xfe])
  ) {
    return blockedResult('application/x-executable', 'binary', contentSha256, 'unsafe_executable');
  }
  if (MACRO_EXTENSIONS.has(extension)) {
    return blockedResult('application/zip', 'document', contentSha256, 'macro_enabled_document');
  }
  if (startsWith(params.bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return blockedResult('application/x-ole-storage', 'binary', contentSha256, 'legacy_compound_document');
  }

  const detection = detect(params.bytes, extension, declaredMimeType);
  const textPrefix = detection.text?.trimStart().slice(0, 1024).toLowerCase() ?? '';
  if (
    ACTIVE_MIME_TYPES.has(declaredMimeType)
    || extension === '.html' || extension === '.htm' || extension === '.svg'
    || textPrefix.startsWith('<!doctype html')
    || textPrefix.startsWith('<html')
    || textPrefix.startsWith('<script')
    || textPrefix.startsWith('<svg')
  ) {
    return blockedResult(detection.mimeType, detection.kind, contentSha256, 'active_content');
  }

  if (detection.strong && !declaredTypeMatches(declaredMimeType, detection)) {
    return blockedResult(detection.mimeType, detection.kind, contentSha256, 'declared_type_mismatch');
  }
  const claimsReadableType = declaredMimeType.startsWith('text/')
    || declaredMimeType === 'application/json'
    || declaredMimeType === 'application/csv';
  if (detection.text === null && claimsReadableType) {
    return {
      detectedMimeType: detection.mimeType,
      kind: detection.kind,
      contentSha256,
      status: 'failed',
      error: 'invalid_utf8',
      derivative: null,
    };
  }
  if (detection.mimeType === 'application/json' && detection.text !== null) {
    try {
      JSON.parse(detection.text);
    } catch {
      return {
        detectedMimeType: detection.mimeType,
        kind: detection.kind,
        contentSha256,
        status: 'failed',
        error: 'invalid_json',
        derivative: null,
      };
    }
  }

  const withinExtractionLimit = params.bytes.byteLength <= MAX_EXTRACTED_TEXT_BYTES;
  const derivative = detection.text !== null && withinExtractionLimit
    ? {
      kind: 'text' as const,
      mimeType: 'text/plain' as const,
      content: detection.text,
      sizeBytes: Buffer.byteLength(detection.text, 'utf8'),
      metadata: { source_mime_type: detection.mimeType },
    }
    : null;

  return {
    detectedMimeType: detection.mimeType,
    kind: detection.kind,
    contentSha256,
    status: 'ready',
    error: detection.text !== null && !withinExtractionLimit ? 'text_extraction_limit' : null,
    derivative,
  };
}
