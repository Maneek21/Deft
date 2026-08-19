import { readFileSync } from 'node:fs';

import {
  parseDeftModuleManifest,
  type DeftModuleManifestV1,
} from '@deft/shared/modules';

const contactsManifestUrl = new URL(
  '../../../../modules/bundled/contacts/deft.module.json',
  import.meta.url,
);

const contacts = parseDeftModuleManifest(
  JSON.parse(readFileSync(contactsManifestUrl, 'utf8')),
);

const bundledModules = new Map<string, DeftModuleManifestV1>([
  [contacts.slug, contacts],
]);

export function listBundledModules(): DeftModuleManifestV1[] {
  return [...bundledModules.values()];
}

export function getBundledModule(slug: string): DeftModuleManifestV1 | null {
  return bundledModules.get(slug) ?? null;
}
