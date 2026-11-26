// The one writer of document content outside live sockets (consult rule C2;
// plan Task F7): agent edits, applied suggestions, restores, imports,
// templates after creation and the move's later fixes all call
// writeDocument. Live editing writes through /collab.
//
// writeDocument is defined in collab/server.ts, next to the live documents it
// must coordinate with, and that module exports no other way to change a
// document: the write machinery behind it isn't reachable. Its contract
// (roles, suggest-only drives, expectedRevision, the size cap, BUSY, the
// stored listeners, and `inTransaction` for work that commits with the
// content) is documented there.
export {
  DocumentWriteRefused, writeDocument, type DocumentWriteInTransaction, type DocumentWriteReason, type DocumentWriteRefusalCode,
} from '../collab/server.js';
