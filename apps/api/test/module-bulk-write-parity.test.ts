import assert from 'node:assert/strict';
import test from 'node:test';
import { MODULE_OPERATION_DEFINITIONS, MODULE_OPERATION_REQUEST_SCHEMAS } from '@deft/shared/modules';
import { MODULE_MCP_WRITE_TOOLS } from '../src/lib/mcp-tools/modules.js';

test('reviewed module bulk create is a shared MCP write operation', () => {
  assert.equal(typeof MODULE_MCP_WRITE_TOOLS.module_record_bulk_create, 'function');
  assert.equal(MODULE_OPERATION_DEFINITIONS.module_record_bulk_create.approval_tier, 'full');
  assert.equal(MODULE_OPERATION_DEFINITIONS.module_record_bulk_create.destructive, true);
  assert.equal(MODULE_OPERATION_REQUEST_SCHEMAS.module_record_bulk_create.safeParse({
    module_id: 'com.example.equipment',
    collection_key: 'assets',
    expected_manifest_digest: `sha256:${'a'.repeat(64)}`,
    rows: [{ data: { serial: 'CAM-1' } }],
    idempotency_key: 'shared-bulk-1',
  }).success, true);
});
