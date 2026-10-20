import { hostRetainedSourceStorage } from './host-source-storage.js';

/** Compatibility export for existing callers; remove after their owner switch. */
export const decorateEmailKnowledgeCitations = hostRetainedSourceStorage.knowledge.decorateCitations;
