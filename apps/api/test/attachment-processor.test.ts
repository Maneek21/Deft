import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_EXTRACTED_TEXT_BYTES,
  processAttachment,
} from '../src/lib/attachment-processor.js';

test('extracts bounded UTF-8 text and fingerprints the original bytes', () => {
  const result = processAttachment({
    filename: 'plan.csv',
    declaredMimeType: 'application/vnd.ms-excel',
    bytes: Buffer.from('project,task\nLaunch,Verify\n'),
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.kind, 'spreadsheet');
  assert.equal(result.detectedMimeType, 'text/csv');
  assert.match(result.contentSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.derivative?.content, 'project,task\nLaunch,Verify\n');
  assert.deepEqual(result.derivative?.metadata, { source_mime_type: 'text/csv' });
});

test('recognizes supported images and OOXML spreadsheets from signatures', () => {
  const png = processAttachment({
    filename: 'diagram.png',
    declaredMimeType: 'image/png',
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
  });
  assert.equal(png.status, 'ready');
  assert.equal(png.kind, 'image');
  assert.equal(png.detectedMimeType, 'image/png');
  assert.equal(png.derivative, null);

  const workbook = processAttachment({
    filename: 'plan.xlsx',
    declaredMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]),
  });
  assert.equal(workbook.status, 'ready');
  assert.equal(workbook.kind, 'spreadsheet');
});

test('blocks executable, active, macro-enabled, and misleading content', () => {
  const cases = [
    processAttachment({ filename: 'payload.exe', declaredMimeType: 'text/plain', bytes: Buffer.from('harmless-looking') }),
    processAttachment({ filename: 'page.html', declaredMimeType: 'text/plain', bytes: Buffer.from('<script>alert(1)</script>') }),
    processAttachment({ filename: 'sheet.xlsm', declaredMimeType: 'application/zip', bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]) }),
    processAttachment({
      filename: 'not-text.txt',
      declaredMimeType: 'text/plain',
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    }),
  ];

  assert.deepEqual(cases.map((item) => item.status), ['blocked', 'blocked', 'blocked', 'blocked']);
  assert.deepEqual(cases.map((item) => item.error), [
    'unsafe_executable',
    'active_content',
    'macro_enabled_document',
    'declared_type_mismatch',
  ]);
});

test('records truthful terminal failures and bounded extraction outcomes', () => {
  const invalidUtf8 = processAttachment({
    filename: 'notes.txt',
    declaredMimeType: 'text/plain',
    bytes: Buffer.from([0xc3, 0x28]),
  });
  assert.equal(invalidUtf8.status, 'failed');
  assert.equal(invalidUtf8.error, 'invalid_utf8');

  const invalidJson = processAttachment({
    filename: 'plan.json',
    declaredMimeType: 'application/json',
    bytes: Buffer.from('{not valid json}'),
  });
  assert.equal(invalidJson.status, 'failed');
  assert.equal(invalidJson.error, 'invalid_json');

  const extractionLimited = processAttachment({
    filename: 'large.txt',
    declaredMimeType: 'text/plain',
    bytes: Buffer.alloc(MAX_EXTRACTED_TEXT_BYTES + 1, 0x61),
  });
  assert.equal(extractionLimited.status, 'ready');
  assert.equal(extractionLimited.error, 'text_extraction_limit');
  assert.equal(extractionLimited.derivative, null);

  const uploadLimited = processAttachment({
    filename: 'too-large.bin',
    declaredMimeType: 'application/octet-stream',
    bytes: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1),
  });
  assert.equal(uploadLimited.status, 'failed');
  assert.equal(uploadLimited.error, 'file_size_limit');
});
