import { retainedSourceStorageProvider } from './email-mailbox-key-references.js';

/** Static Host registration, never app-controlled. This retained storage owner
 * includes custody, source routing and historical Calendar model decoding. */
export const hostRetainedSourceStorage = retainedSourceStorageProvider;
