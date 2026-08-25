import assert from 'node:assert/strict';
import test from 'node:test';

import { memoryUpdateApprovalGuardError } from '../src/lib/mcp-tools/memory-update.js';

test('memory promotion approval guard accepts the exact queued page version', () => {
  assert.equal(
    memoryUpdateApprovalGuardError(
      { id: 'page-1', version: 3 },
      { page_id: 'page-1', version: 3 },
    ),
    null,
  );
});

test('memory promotion approval guard rejects a stale page version', () => {
  assert.match(
    memoryUpdateApprovalGuardError(
      { id: 'page-1', version: 4 },
      { page_id: 'page-1', version: 3 },
    ) ?? '',
    /changed since approval was requested/i,
  );
});

test('memory promotion approval guard rejects a replaced target', () => {
  assert.match(
    memoryUpdateApprovalGuardError(
      { id: 'page-2', version: 3 },
      { page_id: 'page-1', version: 3 },
    ) ?? '',
    /target changed since approval was requested/i,
  );
});

