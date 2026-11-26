'use client';

// The document body's editors, loaded on demand (plan Task F12, fix round 1):
// next/dynamic keeps document-editor.tsx, and with it the collaboration
// packages, Yjs bindings and the document image view
// (lib/editor/document-extensions.ts), out of every bundle but the one the
// document page loads. Never rendered on the server.

import dynamic from 'next/dynamic';

function Loading() {
  return <p className="text-[13px]" style={{ color: 'var(--outline)' }}>Loading…</p>;
}

export const LazyDocumentEditor = dynamic(() => import('./document-editor').then((m) => m.DocumentEditor), { ssr: false, loading: Loading });
export const LazyDocumentReadOnly = dynamic(() => import('./document-editor').then((m) => m.DocumentReadOnly), { ssr: false, loading: Loading });
