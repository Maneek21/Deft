'use client';

// A document's block image, drawn (plan Task F12). The node and its
// attributes are @deft/doc-schema's DocumentImage, so the editor and the API
// share one schema; this adds only the view.
//
// An image that names a Deft file (`fileId`) is fetched with the viewer's own
// token into a blob URL, as notes do, so it shows only to someone the file
// route lets read it (F10: through the documents that link it). A freshly
// uploaded image is readable to viewers and commenters only once the
// document's next store confirms it is in the content, which can take up to a
// minute while people are editing. So a 404 is not taken as broken at once:
// the view shows "Image is loading" and tries again when the document changes
// (a Yjs change, or `document:updated`) and on a backoff, for about 90 s;
// only then does it say "Image not available". Any other refusal says so at
// once.
//
// An image from another site (`src`, https only) is drawn as is.

import { useEffect, useState } from 'react';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import { DocumentImage } from '@deft/doc-schema/nodes/document-image';
import { api } from '@/lib/api';
import { protectedFilePath } from '@/lib/protected-file';
import { DOCUMENT_UPDATED_EVENT } from '@/lib/document-events';

/** Waits between retries after a 404 (about 90 s in all). */
export const IMAGE_RETRY_DELAYS_MS = [3_000, 6_000, 12_000, 24_000, 45_000];
/** How long after the first 404 the image is given up on. */
export const IMAGE_GIVE_UP_AFTER_MS = 90_000;
/** A change to the document brings a retry this soon after it. */
const NUDGE_MS = 250;

/** An outside image is drawn only from an https address. */
export function outsideImageSrc(src: unknown): string | null {
  if (typeof src !== 'string') return null;
  try {
    return new URL(src).protocol === 'https:' ? src : null;
  } catch {
    return null;
  }
}

type Phase = { kind: 'loading' } | { kind: 'waiting' } | { kind: 'shown'; url: string } | { kind: 'unavailable' };

/** Loads a Deft file image, waiting out the 404 a new image gives viewers until its document is stored. */
function useDocumentFile(fileId: string, editor: Editor): Phase {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  useEffect(() => {
    let done = false;
    let objectUrl: string | null = null;
    let inFlight: AbortController | null = null;
    let again = false;
    let retries = 0;
    let firstMiss: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let nudge: ReturnType<typeof setTimeout> | null = null;
    const clearTimers = () => {
      if (timer) clearTimeout(timer);
      if (nudge) clearTimeout(nudge);
      timer = null;
      nudge = null;
    };
    const finish = (next: Phase) => {
      done = true;
      clearTimers();
      setPhase(next);
    };
    const retryLater = () => {
      if (timer) clearTimeout(timer);
      const wait = IMAGE_RETRY_DELAYS_MS[Math.min(retries, IMAGE_RETRY_DELAYS_MS.length - 1)]!;
      retries += 1;
      timer = setTimeout(() => { timer = null; void attempt(); }, wait);
    };
    const attempt = async (): Promise<void> => {
      if (done) return;
      if (inFlight) { again = true; return; }
      const controller = new AbortController();
      inFlight = controller;
      let status: number | 'network' = 'network';
      let blob: Blob | null = null;
      try {
        const res = await api.fetch(protectedFilePath(fileId), { signal: controller.signal });
        status = res.status;
        if (res.ok) blob = await res.blob();
      } catch {
        status = 'network';
      }
      inFlight = null;
      if (done || controller.signal.aborted) return;
      if (blob) {
        objectUrl = URL.createObjectURL(blob);
        finish({ kind: 'shown', url: objectUrl });
        return;
      }
      if (status !== 404 && status !== 'network') {
        finish({ kind: 'unavailable' });
        return;
      }
      firstMiss ??= Date.now();
      if (Date.now() - firstMiss >= IMAGE_GIVE_UP_AFTER_MS) {
        finish({ kind: 'unavailable' });
        return;
      }
      setPhase({ kind: 'waiting' });
      if (again) {
        again = false;
        void attempt();
        return;
      }
      retryLater();
    };
    const onDocumentChange = () => {
      if (done || firstMiss === null) return;
      if (nudge) clearTimeout(nudge);
      nudge = setTimeout(() => { nudge = null; void attempt(); }, NUDGE_MS);
    };
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (transaction.docChanged) onDocumentChange();
    };
    editor.on('transaction', onTransaction);
    window.addEventListener(DOCUMENT_UPDATED_EVENT, onDocumentChange);
    void attempt();
    return () => {
      done = true;
      clearTimers();
      inFlight?.abort();
      editor.off('transaction', onTransaction);
      window.removeEventListener(DOCUMENT_UPDATED_EVENT, onDocumentChange);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileId, editor]);
  return phase;
}

function Unavailable() {
  return <span className="text-[12px]" style={{ color: 'var(--on-surface-variant)' }}>Image not available</span>;
}

function FileImage({ fileId, name, editor }: { fileId: string; name: string; editor: Editor }) {
  const phase = useDocumentFile(fileId, editor);
  if (phase.kind === 'shown') {
    // eslint-disable-next-line @next/next/no-img-element -- a blob URL fetched with the viewer's own token
    return <img src={phase.url} alt={name} className="max-w-full rounded-lg" />;
  }
  if (phase.kind === 'unavailable') return <Unavailable />;
  return (
    <span role="status" aria-label={phase.kind === 'waiting' ? 'Image is loading' : `Loading ${name}`}
      className="flex h-24 w-40 max-w-full items-center justify-center rounded-lg text-[12px]"
      style={{ background: 'var(--surface-container)', color: 'var(--on-surface-variant)' }}>
      {phase.kind === 'waiting' ? 'Image is loading' : null}
    </span>
  );
}

function DocumentImageView({ node, editor }: NodeViewProps) {
  const fileId = typeof node.attrs.fileId === 'string' ? node.attrs.fileId : '';
  const name = typeof node.attrs.alt === 'string' && node.attrs.alt ? node.attrs.alt : 'Image';
  const src = fileId ? null : outsideImageSrc(node.attrs.src);
  return (
    <NodeViewWrapper className="my-2" data-document-image="">
      {fileId ? (
        <FileImage key={fileId} fileId={fileId} name={name} editor={editor} />
      ) : src ? (
        // eslint-disable-next-line @next/next/no-img-element -- an outside image the document links to; next/image would proxy it
        <img src={src} alt={name} loading="lazy" referrerPolicy="no-referrer" className="max-w-full rounded-lg" />
      ) : (
        <Unavailable />
      )}
    </NodeViewWrapper>
  );
}

/** DocumentImage with the view above; same name (`image`), attributes and HTML. */
export const DocumentImageWithView = DocumentImage.extend({
  addNodeView() {
    return ReactNodeViewRenderer(DocumentImageView);
  },
});
