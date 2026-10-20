import type { HostCustodyInventoryProvider } from './host-custody-inventory.js';
import { listPrivateDeftyKeyReferences } from './app-private-defty-key-references.js';
import { listEmailMailboxKeyReferences } from './email-mailbox-key-references.js';

/** Static Host composition root. No app-controlled provider registration. The
 * retained legacy storage owner must remain registered until a separate data
 * retirement gate proves that no ciphertext references its keys. */
export const hostCustodyInventoryProviders: readonly HostCustodyInventoryProvider[] = Object.freeze([
  Object.freeze({ id: 'private-agent-history', listReferences: listPrivateDeftyKeyReferences }),
  Object.freeze({ id: 'retained-source-storage', listReferences: listEmailMailboxKeyReferences }),
]);
