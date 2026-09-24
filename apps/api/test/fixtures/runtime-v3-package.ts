import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildDeftAppPackage } from '@deft/app-kit';

/** External packed artifact is preferred for acceptance; a fresh local Kit
 * fixture keeps focused tests runnable without the acceptance workspace. */
export async function runtimeV3PackageJson(): Promise<string> {
  if (process.env.DEFT_RUNTIME_AUTHOR_PACKAGE) {
    return readFile(process.env.DEFT_RUNTIME_AUTHOR_PACKAGE, 'utf8');
  }
  const suffix = randomUUID().replace(/-/g, '');
  return (await buildDeftAppPackage({ manifest: {
    schema_version: '3', id: `community.example.shipping.app${suffix}`,
    version: '1.0.0', name: 'Shipping', license: 'AGPL-3.0-only',
    compatibility: { app_protocol: '3' }, modules: [], navigation: [],
    runtime_requirements: [{ key: 'carrier', protocol_version: 'deft.app_runtime_channel.v1' }],
    private_capabilities: [{ key: 'create_shipping_label', version: '1',
      input_schema: { type: 'object', properties: { shipment_id: { type: 'string', maxLength: 120 } },
        required: ['shipment_id'], additionalProperties: false },
      output_schema: { type: 'object', properties: { label_id: { type: 'string', maxLength: 120 } },
        required: ['label_id'], additionalProperties: false } }],
    runtime_actions: [{ key: 'create_shipping_label', label: 'Create shipping label',
      capability_key: 'create_shipping_label', runtime_requirement_key: 'carrier' }],
  }, artifacts: [] })).json;
}
